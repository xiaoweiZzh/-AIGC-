import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', jpg: 'image/jpeg', svg: 'image/svg+xml' };
const pages = {};
for (const name of await readdir('public')) {
  const type = types[name.split('.').at(-1)];
  if (type) pages[`/${name}`] = [type, (await readFile(`public/${name}`)).toString('base64')];
}
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await writeFile('dist/.openai/hosting.json', await readFile('.openai/hosting.json'));
const worker = await readFile('worker.mjs', 'utf8');
await writeFile('dist/server/index.js', `const PAGES = ${JSON.stringify(pages)};\n${worker}\nexport default createWorker(PAGES);\n`);
