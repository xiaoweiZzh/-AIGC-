const MODEL = 'wan3.0-video';
const REGIONS = ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1', 'cn-hongkong'];
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const CATEGORIES = ['角色', '场景', '道具', '风格'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_REFERENCES = 12 * 1024 * 1024;
const MAX_REFERENCE_COUNT = 10;
const MAX_VIDEO = 100 * 1024 * 1024;
const MAX_DRAFT = 512 * 1024;
const TASK_ID = /^[\w-]{1,100}$/;
const WORKSPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY = /^sk-[A-Za-z0-9._-]{8,509}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACTIVE_JOBS = "status IN ('queued','submitting','running','archiving')";
const lockTime = 90_000;
const pendingTasks = new Map();

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const sql = (env, query, ...args) => env.DB.prepare(query).bind(...args);
const rows = async (statement) => (await statement.all()).results;
const assetPath = (owner, id) => `assets/${owner}/${id}`;
const videoPath = (owner, id) => `videos/${owner}/${id}`;
const count = (env) => Math.max(1, Math.min(3, Number.parseInt(env.FRAMEFLOW_CONCURRENCY, 10) || 3));
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const localIntegration = (env) => env.local && env.DASHSCOPE_API_KEY && WORKSPACE.test(env.DASHSCOPE_WORKSPACE_ID ?? '') && REGIONS.includes(env.DASHSCOPE_REGION || 'cn-beijing')
  ? { key: env.DASHSCOPE_API_KEY, workspace: env.DASHSCOPE_WORKSPACE_ID, region: env.DASHSCOPE_REGION || 'cn-beijing' } : null;
const getIntegration = (env, owner) => sql(env, 'SELECT workspace,region,ciphertext,version FROM account_integrations WHERE owner=?', owner).first();
const canConfigure = (env) => /^[A-Fa-f0-9]{64}$/.test(env.FRAMEFLOW_CREDENTIAL_SECRET ?? '');
const encoder = new TextEncoder();

async function vaultKey(env) {
  if (!canConfigure(env)) throw new InputError('在线密钥存储尚未启用。', 503);
  const bytes = Uint8Array.from(env.FRAMEFLOW_CREDENTIAL_SECRET.match(/../g), (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const credentialContext = (owner, config) => encoder.encode(JSON.stringify(['frameflow-dashscope-v1', owner, config.workspace, config.region, config.version]));

async function resolveIntegration(env, owner) {
  if (env.local) return localIntegration(env);
  if (!canConfigure(env)) return null;
  const config = await getIntegration(env, owner);
  if (!config) return null;
  const bytes = Uint8Array.from(atob(config.ciphertext), (character) => character.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: credentialContext(owner, config) }, await vaultKey(env), bytes.subarray(12));
  return { ...config, key: new TextDecoder().decode(plaintext) };
}

async function changeIntegration(env, owner, request) {
  if (env.local) throw new InputError('本地版使用本地环境变量配置。', 409);
  if (request.method === 'DELETE') {
    const removed = await sql(env, `DELETE FROM account_integrations WHERE owner=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE owner=? AND ${ACTIVE_JOBS}) RETURNING owner`, owner, owner).first();
    if (!removed && await getIntegration(env, owner)) throw new InputError('请先取消排队任务，并等待正在处理的任务结束。', 409);
    return json({ ok: true });
  }
  const data = await readJson(request, 4096);
  const key = typeof data?.key === 'string' ? data.key.trim() : '';
  const workspace = typeof data?.workspace === 'string' ? data.workspace.trim().toLowerCase() : '';
  const region = data?.region;
  if (!KEY.test(key) || !WORKSPACE.test(workspace) || !REGIONS.includes(region)) throw new InputError('请填写有效的百炼 API Key、业务空间 ID 和地域。');
  const config = { workspace, region, version: crypto.randomUUID() };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: credentialContext(owner, config) }, await vaultKey(env), encoder.encode(key)));
  const ciphertext = base64(Uint8Array.of(...iv, ...encrypted));
  const saved = await sql(env, `INSERT INTO account_integrations (owner,workspace,region,ciphertext,version)
    SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE owner=? AND ${ACTIVE_JOBS})
    ON CONFLICT(owner) DO UPDATE SET workspace=excluded.workspace, region=excluded.region, ciphertext=excluded.ciphertext, version=excluded.version RETURNING version`, owner, workspace, region, ciphertext, config.version, owner).first();
  if (!saved) throw new InputError('请先取消排队任务，并等待正在处理的任务结束。', 409);
  return json({ workspace, region });
}

async function readJson(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('缺少请求数据。');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new InputError('提交的数据太大。', 413); }
    chunks.push(value);
  }
  try { return await new Response(new Blob(chunks)).json(); }
  catch { throw new InputError('请求格式不正确。'); }
}

async function saveDraft(env, owner, request) {
  const data = await readJson(request, MAX_DRAFT);
  if (!Array.isArray(data?.shots) || !data.shots.length || data.shots.length > 20 || !data.shots.some((shot) => shot?.id === data.selected)) throw new InputError('分镜草稿格式不正确。');
  const ids = new Set();
  const shots = data.shots.map((shot) => {
    if (!shot || typeof shot.id !== 'string' || !UUID.test(shot.id) || ids.has(shot.id) || typeof shot.prompt !== 'string' || shot.prompt.length > 2000 || !RATIOS.includes(shot.ratio) || !Number.isInteger(shot.duration) || shot.duration < 2 || shot.duration > 30 || !Array.isArray(shot.refs) || shot.refs.length > MAX_REFERENCE_COUNT || !shot.refs.every((id) => typeof id === 'string' && UUID.test(id))) throw new InputError('分镜草稿格式不正确。');
    ids.add(shot.id);
    return { id: shot.id, prompt: shot.prompt, ratio: shot.ratio, duration: shot.duration, refs: shot.refs };
  });
  await sql(env, 'INSERT INTO account_drafts (owner,draft) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET draft=excluded.draft', owner, JSON.stringify({ shots, selected: data.selected })).run();
  return json({ ok: true });
}

function displayJob(row) {
  const media = JSON.parse(row.refs);
  return { id: row.id, title: row.title, prompt: row.prompt, refs: media.filter((item) => item.role !== 'first_frame'), first: media.find((item) => item.role === 'first_frame') ?? null, ratio: row.ratio, duration: row.duration, status: row.status, created: row.created, error: row.error, video: row.status === 'done' ? `/api/videos/${row.id}` : null };
}

function fail(env, job, error) {
  return sql(env, 'UPDATE jobs SET status=?, error=?, lease=0 WHERE id=? AND lease=?', 'failed', error, job.id, job.lease).run();
}

async function dash(env, config, path, body) {
  const options = { headers: { Authorization: `Bearer ${config.key}` }, redirect: 'error', signal: AbortSignal.timeout(26_000) };
  if (body) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-DashScope-Async'] = 'enable';
    options.body = JSON.stringify(body);
  }
  const root = `https://${config.workspace}.${config.region}.maas.aliyuncs.com/api/v1`;
  const response = await (env.providerFetch ?? fetch)(`${root}${path}`, options);
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => ({})) };
}

function base64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}

async function submit(env, config, job) {
  const refs = JSON.parse(job.refs);
  try {
    const media = [];
    for (const ref of refs) {
      let url;
      if (env.referenceUrl) {
        url = await env.referenceUrl(job.owner, ref.id);
      } else {
        const item = await env.BUCKET.get(assetPath(job.owner, ref.id));
        if (!item) return await fail(env, job, '找不到生成所需的图片，请从素材库重新选择。');
        url = `data:${ref.mime};base64,${base64(new Uint8Array(await item.arrayBuffer()))}`;
      }
      media.push({ type: ref.role === 'first_frame' ? 'first_frame' : 'reference_image', url });
    }
    const result = await dash(env, config, '/services/aigc/video-generation/video-synthesis', {
      model: MODEL,
      input: { prompt: job.prompt.replace(/@图(?=\d)/g, '图'), ...(media.length ? { media } : {}) },
      parameters: { resolution: '480P', ratio: job.ratio, duration: job.duration }
    });
    if (result.status === 429) {
      return await sql(env, 'UPDATE jobs SET status=?, next=?, lease=0 WHERE id=? AND lease=?', 'queued', Date.now() + 35_000, job.id, job.lease).run();
    }
    if (!result.ok || !TASK_ID.test(result.body.output?.task_id ?? '')) {
      const hint = [401, 403].includes(result.status) ? '，请检查你的 Key、地域、业务空间和模型权限。' : '，请到百炼控制台查看详情。';
      return await fail(env, job, result.status >= 500 ? '上游服务异常，无法确认是否已受理。重试前请先检查百炼任务。' : `百炼未受理（${result.status}）${hint}`);
    }
    await sql(env, 'UPDATE jobs SET status=?, provider=?, next=?, lease=0 WHERE id=? AND lease=?', 'running', result.body.output.task_id, Date.now() + 15_000, job.id, job.lease).run();
  } catch {
    await fail(env, job, '提交发生超时或连接异常，无法确认是否已受理。重试前请先检查百炼任务。');
  }
}

async function archive(env, job) {
  const objectKey = videoPath(job.owner, job.id);
  if (!await env.BUCKET.head(objectKey)) {
    const location = new URL(job.upstream);
    if (location.protocol !== 'https:' || !location.hostname.endsWith('.aliyuncs.com') || location.username || location.password) throw new Error('Invalid video origin');
    const upstream = await (env.providerFetch ?? fetch)(location, { redirect: 'error', signal: AbortSignal.timeout(35_000) });
    const size = Number(upstream.headers.get('content-length'));
    if (!upstream.ok || !upstream.body || !Number.isSafeInteger(size) || size < 1 || size > MAX_VIDEO) throw new Error('Invalid video response');
    const options = { httpMetadata: { contentType: 'video/mp4' } };
    if (typeof FixedLengthStream !== 'undefined') {
      const stream = new FixedLengthStream(size);
      await Promise.all([upstream.body.pipeTo(stream.writable), env.BUCKET.put(objectKey, stream.readable, options)]);
    } else {
      await env.BUCKET.put(objectKey, upstream.body, options);
    }
  }
  await sql(env, 'UPDATE jobs SET status=?, upstream=NULL, lease=0 WHERE id=? AND lease=?', 'done', job.id, job.lease).run();
}

async function refresh(env, config, job) {
  try {
    if (job.status === 'archiving') return await archive(env, job);
    const result = await dash(env, config, `/tasks/${job.provider}`);
    if (result.status === 429 || result.status >= 500) throw new Error('Temporary provider issue');
    if (!result.ok) return await fail(env, job, `查询百炼任务失败（${result.status}），请到百炼控制台查看详情。`);
    const output = result.body.output ?? {};
    if (output.task_status === 'SUCCEEDED' && output.video_url) {
      await sql(env, 'UPDATE jobs SET status=?, upstream=?, next=?, lease=0 WHERE id=? AND lease=?', 'archiving', output.video_url, Date.now(), job.id, job.lease).run();
    } else if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(output.task_status)) {
      await fail(env, job, `百炼未返回可用视频（${output.task_status}），请到百炼控制台查看详情。`);
    } else {
      await sql(env, 'UPDATE jobs SET next=?, lease=0 WHERE id=? AND lease=?', Date.now() + 15_000, job.id, job.lease).run();
    }
  } catch {
    if (Date.now() - job.created > 22 * 60 * 60_000) return fail(env, job, '结果同步超时，请检查百炼任务或重试。');
    await sql(env, 'UPDATE jobs SET next=?, lease=0 WHERE id=? AND lease=?', Date.now() + 25_000, job.id, job.lease).run();
  }
}

export async function tick(env, owner) {
  const config = await resolveIntegration(env, owner);
  if (!config) return;
  const now = Date.now();
  const version = config.version ?? null;
  await sql(env, 'UPDATE jobs SET status=?, error=?, lease=0 WHERE owner=? AND status=? AND lease<?', 'failed', '任务提交中断，重试前请先检查百炼任务。', owner, 'submitting', now).run();
  const due = await rows(sql(env, 'SELECT id FROM jobs WHERE owner=? AND status IN (\'running\',\'archiving\') AND next<=? AND lease<=? ORDER BY next LIMIT 6', owner, now, now));
  await Promise.allSettled(due.map(async ({ id }) => {
    const job = await sql(env, `UPDATE jobs SET lease=? WHERE id=? AND owner=? AND status IN ('running','archiving') AND lease<=? AND next<=?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM account_integrations WHERE owner=? AND version=?)) RETURNING *`, now + lockTime, id, owner, now, now, version, owner, version).first();
    if (job) await refresh(env, config, job);
  }));
  const claimed = [];
  for (let slot = 0; slot < count(env); slot++) {
    const job = await sql(env, `UPDATE jobs SET status='submitting', lease=? WHERE id=(
      SELECT id FROM jobs WHERE owner=? AND status='queued' AND next<=? ORDER BY created,id LIMIT 1
      ) AND (SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN ('submitting','running')) < ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM account_integrations WHERE owner=? AND version=?)) RETURNING *`, now + lockTime, owner, now, owner, count(env), version, owner, version).first();
    if (!job) break;
    claimed.push(job);
  }
  await Promise.allSettled(claimed.map((job) => submit(env, config, job)));
}

function background(env, owner, ctx) {
  if (pendingTasks.has(owner)) return;
  const task = tick(env, owner).catch(() => console.error('FrameFlow queue failure')).finally(() => pendingTasks.delete(owner));
  pendingTasks.set(owner, task);
  ctx.waitUntil(task);
}

async function validatedJobs(env, owner, entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20) throw new InputError('每次可添加 1–20 条分镜。');
  const available = new Map((await rows(sql(env, 'SELECT id,name,mime,size FROM assets WHERE owner=? AND archived=0', owner))).map((item) => [item.id, item]));
  return entries.map((entry, index) => {
    const prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim() : '';
    if (!prompt || prompt.length > 2000) throw new InputError(`分镜 ${index + 1} 的提示词需为 1–2000 个字符。`);
    if (!RATIOS.includes(entry.ratio) || !Number.isInteger(entry.duration) || entry.duration < 2 || entry.duration > 30) throw new InputError('视频比例不支持，或时长不在 2–30 秒内。');
    if (!Array.isArray(entry.refs) || entry.refs.length > MAX_REFERENCE_COUNT || new Set(entry.refs).size !== entry.refs.length) throw new InputError(`请为每条分镜选择不超过 ${MAX_REFERENCE_COUNT} 张不同的参考图。`);
    const refs = entry.refs.map((ref) => available.get(ref));
    if (refs.some((ref) => !ref)) throw new InputError('所选素材已经移除，请重新选择。');
    if (entry.first != null) throw new InputError('新任务不再支持首帧，请使用参考图。');
    if (refs.reduce((total, ref) => total + ref.size, 0) > MAX_REFERENCES) throw new InputError('每条分镜的参考图总大小不能超过 12 MB。');
    if ([...prompt.matchAll(/@图(\d+)/g)].some((match) => Number(match[1]) < 1 || Number(match[1]) > refs.length)) throw new InputError(`分镜 ${index + 1} 的 @图编号没有对应参考图。`);
    return { ...entry, prompt, refs, title: text(entry.title, 80) || `镜头 ${String(index + 1).padStart(2, '0')}` };
  });
}

function validImage(mime, bytes) {
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  return String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
}

async function validateFolder(env, owner, id) {
  if (id === null) return null;
  if (typeof id !== 'string' || !await sql(env, 'SELECT id FROM asset_folders WHERE owner=? AND id=?', owner, id).first()) throw new InputError('素材文件夹不存在。', 404);
  return id;
}

async function upload(env, owner, request) {
  const length = Number(request.headers.get('Content-Length'));
  if (!length || length > MAX_IMAGE + 65_536) throw new InputError('每张参考图不能超过 4 MB。', 413);
  const form = await request.formData();
  const file = form.get('file');
  const category = form.get('category');
  const folder = await validateFolder(env, owner, form.get('folder'));
  if (!(file instanceof File) || !IMAGE_TYPES.includes(file.type) || !file.size || file.size > MAX_IMAGE || !CATEGORIES.includes(category)) throw new InputError('请选择 4 MB 以内的 JPG、PNG 或 WEBP 图片。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!validImage(file.type, bytes)) throw new InputError('图片内容与扩展名不符。');
  const asset = { id: crypto.randomUUID(), name: text(form.get('name'), 80) || text(file.name, 80), category, mime: file.type, size: file.size, created: Date.now(), folder };
  await env.BUCKET.put(assetPath(owner, asset.id), bytes, { httpMetadata: { contentType: file.type } });
  try {
    await sql(env, 'INSERT INTO assets (id,owner,name,category,mime,size,created,folder) VALUES (?,?,?,?,?,?,?,?)', asset.id, owner, asset.name, asset.category, asset.mime, asset.size, asset.created, asset.folder).run();
  } catch (error) {
    await env.BUCKET.delete(assetPath(owner, asset.id));
    throw error;
  }
  return json(asset, 201);
}

async function serveMedia(env, request, objectKey, mime, filename) {
  const range = request.headers.get('Range');
  const object = await env.BUCKET.get(objectKey, range ? { range: request.headers } : undefined);
  if (!object) throw new InputError('文件不存在。', 404);
  const headers = { 'Content-Type': mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  if (range && object.range?.length && Number.isFinite(object.range.offset)) {
    headers['Content-Range'] = `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`;
    headers['Content-Length'] = object.range.length;
    return new Response(object.body, { status: 206, headers });
  }
  headers['Content-Length'] = object.size;
  return new Response(object.body, { headers });
}

async function api(env, ctx, request, url, identity) {
  const { owner, email, canSignOut } = identity;
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/state' && method === 'GET') {
    background(env, owner, ctx);
    const [assets, jobs, folders, config, draft] = await Promise.all([
      rows(sql(env, 'SELECT id,name,category,mime,size,created,folder FROM assets WHERE owner=? AND archived=0 ORDER BY created DESC', owner)),
      rows(sql(env, 'SELECT * FROM jobs WHERE owner=? ORDER BY created DESC,id LIMIT 200', owner)),
      rows(sql(env, 'SELECT id,name FROM asset_folders WHERE owner=? ORDER BY name,id', owner)),
      env.local ? localIntegration(env) : getIntegration(env, owner),
      !env.local && url.searchParams.has('draft') ? sql(env, 'SELECT draft FROM account_drafts WHERE owner=?', owner).first() : null
    ]);
    return json({ assets, folders, jobs: jobs.map(displayJob), maxReferenceCount: MAX_REFERENCE_COUNT, maxReferenceBytes: MAX_REFERENCES, model: MODEL, concurrency: count(env), ready: Boolean(config && (env.local || canConfigure(env))), local: Boolean(env.local), account: owner, email, canSignOut: Boolean(canSignOut), canConfigure: !env.local && canConfigure(env), integration: config ? { workspace: config.workspace, region: config.region } : null, draft: draft ? JSON.parse(draft.draft) : null });
  }
  if (path === '/api/integration' && ['PUT', 'DELETE'].includes(method)) return changeIntegration(env, owner, request);
  if (path === '/api/draft' && method === 'PUT' && !env.local) return saveDraft(env, owner, request);
  if (path === '/api/folders' && method === 'POST') {
    const data = await request.json().catch(() => null);
    const name = text(data?.name, 60);
    if (!name) throw new InputError('请输入文件夹名称。');
    const id = crypto.randomUUID();
    const folder = await sql(env, 'INSERT INTO asset_folders (id,owner,name) VALUES (?,?,?) ON CONFLICT(owner,name) DO NOTHING RETURNING id,name', id, owner, name).first();
    if (!folder) throw new InputError('已有同名文件夹。', 409);
    return json(folder, 201);
  }
  if (path === '/api/assets/move' && method === 'POST') {
    const data = await request.json().catch(() => null);
    if (!Array.isArray(data?.ids) || !data.ids.length || data.ids.length > 50 || data.ids.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new InputError('每次可移动 1–50 个素材。');
    const folder = await validateFolder(env, owner, data.folder);
    const ids = [...new Set(data.ids)];
    const marks = ids.map(() => '?').join(',');
    const moved = await rows(sql(env, `UPDATE assets SET folder=? WHERE owner=? AND archived=0 AND id IN (${marks}) RETURNING id`, folder, owner, ...ids));
    return json({ count: moved.length });
  }
  if (path === '/api/assets' && method === 'POST') return upload(env, owner, request);
  const asset = path.match(/^\/api\/assets\/([a-f0-9-]{36})$/)?.[1];
  if (asset) {
    const entry = await sql(env, 'SELECT * FROM assets WHERE id=? AND owner=?', asset, owner).first();
    if (!entry) throw new InputError('素材不存在。', 404);
    if (method === 'GET') return serveMedia(env, request, assetPath(owner, asset), entry.mime);
    if (method === 'DELETE') {
      await sql(env, 'UPDATE assets SET archived=1 WHERE id=? AND owner=?', asset, owner).run();
      return json({ ok: true });
    }
  }
  if (path === '/api/jobs' && method === 'POST') {
    const config = await resolveIntegration(env, owner);
    if (!config) throw new InputError('请先在「万相接入」填写自己的百炼 API Key、业务空间 ID 和地域。', 409);
    if (Number(request.headers.get('Content-Length')) > 256_000) throw new InputError('分镜批次太大。', 413);
    const data = await request.json().catch(() => null);
    const jobs = await validatedJobs(env, owner, data?.jobs);
    const now = Date.now();
    const version = config.version ?? null;
    const results = await env.DB.batch(jobs.map((job, index) => sql(env, `INSERT INTO jobs (id,owner,title,prompt,refs,ratio,duration,status,created)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM account_integrations WHERE owner=? AND version=?)`, crypto.randomUUID(), owner, job.title, job.prompt, JSON.stringify(job.refs), job.ratio, job.duration, 'queued', now + index, version, owner, version)));
    if (results.some((result) => (result.meta?.changes ?? result.changes) === 0)) throw new InputError('百炼配置已变更，请重新提交。', 409);
    background(env, owner, ctx);
    return json({ count: jobs.length }, 201);
  }
  const action = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(retry|cancel)$/);
  if (action && method === 'POST') {
    const [ , id, operation] = action;
    const config = operation === 'retry' ? await resolveIntegration(env, owner) : null;
    const version = config?.version ?? null;
    const changed = operation === 'retry'
      ? config && await sql(env, 'UPDATE jobs SET status=?,provider=NULL,upstream=NULL,error=NULL,next=0,lease=0 WHERE id=? AND owner=? AND status=? AND (? IS NULL OR EXISTS (SELECT 1 FROM account_integrations WHERE owner=? AND version=?)) RETURNING id', 'queued', id, owner, 'failed', version, owner, version).first()
      : await sql(env, 'UPDATE jobs SET status=? WHERE id=? AND owner=? AND status=? RETURNING id', 'cancelled', id, owner, 'queued').first();
    if (!changed) throw new InputError('任务当前无法执行这个操作。', 409);
    background(env, owner, ctx);
    return json({ ok: true });
  }
  const video = path.match(/^\/api\/videos\/([a-f0-9-]{36})$/)?.[1];
  if (video && method === 'GET') {
    const entry = await sql(env, 'SELECT id FROM jobs WHERE id=? AND owner=? AND status=?', video, owner, 'done').first();
    if (entry) return serveMedia(env, request, videoPath(owner, video), 'video/mp4', url.searchParams.has('download') ? `frameflow-${video}.mp4` : '');
  }
  throw new InputError('接口或文件不存在。', 404);
}

export function createWorker(pages, identify) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const identity = env.local ? { owner: 'local', email: '' } : identify ? await identify(request, env) : { owner: request.headers.get('oai-authenticated-user-id'), email: request.headers.get('oai-authenticated-user-email') ?? '' };
      const owner = identity?.owner;
      if (!url.pathname.startsWith('/api/')) {
        if (!owner && ['/', '/index.html'].includes(url.pathname)) return Response.redirect(new URL('/signin-with-chatgpt?return_to=%2F', url), 302);
        const entry = pages[url.pathname === '/' ? '/index.html' : url.pathname];
        if (!Array.isArray(entry)) return new Response('Not found', { status: 404 });
        return new Response(Uint8Array.from(atob(entry[1]), (character) => character.charCodeAt(0)), { headers: { 'Content-Type': entry[0], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': url.pathname.endsWith('.jpg') ? 'public, max-age=86400' : 'no-cache', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'" } });
      }
      try {
        if (!owner) throw new InputError('请先登录工作台。', 401);
        if (request.method !== 'GET' && (request.headers.get('Sec-Fetch-Site') === 'cross-site' || (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin))) throw new InputError('不允许从外部页面修改工作台。', 403);
        if (!env.local && request.method !== 'GET' && request.headers.get('X-FrameFlow-Account') !== owner) throw new InputError('登录账号已变更，请刷新后重试。', 403);
        return await api(env, ctx, request, url, identity);
      } catch (error) {
        if (error instanceof InputError) return json({ error: error.message }, error.status);
        console.error('FrameFlow API failure');
        return json({ error: '服务暂时不可用，请稍后重试。' }, 500);
      }
    }
  };
}
