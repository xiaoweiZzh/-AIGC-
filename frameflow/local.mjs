import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createWorker, tick } from './worker.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', jpg: 'image/jpeg', svg: 'image/svg+xml' };

export async function initialize(dataDir, options = {}) {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(options.memory ? ':memory:' : path.join(dataDir, 'frameflow.sqlite'));
  db.exec(await readFile(path.join(root, 'drizzle/0000_frameflow.sql'), 'utf8'));
  db.exec(await readFile(path.join(root, 'drizzle/0002_accounts.sql'), 'utf8'));
  const foldersMigration = await readFile(path.join(root, 'drizzle/0001_asset_folders.sql'), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(assets)').all().some((column) => column.name === 'folder')) db.exec(foldersMigration);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const DB = {
    prepare(query) {
      return { bind: (...args) => ({
        run: () => db.prepare(query).run(...args),
        first: () => db.prepare(query).get(...args) ?? null,
        all: () => ({ results: db.prepare(query).all(...args) })
      }) };
    },
    batch(statements) {
      db.exec('BEGIN');
      try { const result = statements.map((statement) => statement.run()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const filePath = (key) => path.join(dataDir, 'objects', key);
  async function getObject(key) {
    const name = filePath(key);
    try { return { name, size: (await stat(name)).size }; } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  const BUCKET = {
    head: getObject,
    async get(key, options) {
      const object = await getObject(key);
      if (!object) return null;
      const match = options?.range.get('Range')?.match(/^bytes=(\d*)-(\d*)$/);
      let start = 0;
      let end = object.size - 1;
      if (match) {
        if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
        else if (match[2]) start = Math.max(0, object.size - Number(match[2]));
      }
      const validRange = match && Number.isSafeInteger(start) && start >= 0 && start <= end;
      const fileRange = validRange ? { start, end } : {};
      return {
        size: object.size,
        range: validRange ? { offset: start, length: end - start + 1 } : undefined,
        get body() { return Readable.toWeb(createReadStream(object.name, fileRange)); },
        async arrayBuffer() { const bytes = await readFile(object.name); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); }
      };
    },
    async put(key, value) {
      const target = filePath(key);
      const temporary = `${target}.${crypto.randomUUID()}.part`;
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await pipeline(value instanceof ReadableStream ? Readable.fromWeb(value) : Readable.from([value]), createWriteStream(temporary));
        await rename(temporary, target);
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
    delete: (key) => unlink(filePath(key))
  };
  const pages = {};
  for (const name of await readdir(path.join(root, 'public'))) {
    const type = types[name.split('.').at(-1)];
    if (type) pages[`/${name}`] = [type, (await readFile(path.join(root, 'public', name))).toString('base64')];
  }
  return { worker: createWorker(pages), env: { ...options, DB, BUCKET, local: true }, close: () => db.close() };
}

async function main() {
  const config = path.join(root, '.env');
  if (existsSync(config)) process.loadEnvFile(config);
  const port = Number(process.env.PORT || 4177);
  const { worker, env } = await initialize(path.join(root, '.frameflow'), process.env);
  let running = false;
  const ctx = { waitUntil: () => {} };
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== `127.0.0.1:${port}` && incoming.headers.host !== `localhost:${port}`) { outgoing.writeHead(403).end(); return; }
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (url.host !== incoming.headers.host) { outgoing.writeHead(403).end(); return; }
      const hasBody = !['GET', 'HEAD'].includes(incoming.method);
      const response = await worker.fetch(new Request(url, {
        method: incoming.method, headers: incoming.headers,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {})
      }), env, ctx);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body && incoming.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500).end('Local server error');
      else outgoing.destroy();
      if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code)) console.error(error.message);
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`FrameFlow: http://127.0.0.1:${port}`));
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(env, 'local'); } catch (error) { console.error('FrameFlow queue:', error.message); }
    finally { running = false; }
  }, 4500).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
