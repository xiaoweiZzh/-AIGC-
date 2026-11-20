import { createWorker } from './worker.mjs';

const sessionCookie = '__Host-frameflow';
const sessionSeconds = 7 * 24 * 60 * 60;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const referencePath = new RegExp('^/reference/(' + uuid + ')/(' + uuid + ')$');
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const encoder = new TextEncoder();
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
const query = (env, text, ...args) => env.DB.prepare(text).bind(...args);
const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
const hash = async (value) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const cookie = (value, seconds) => `${sessionCookie}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
const redirect = (to, session) => new Response(null, { status: 303, headers: { ...securityHeaders, Location: to, ...(session ? { 'Set-Cookie': session } : {}) } });

async function sessionId(request) {
  const value = request.headers.get('Cookie')?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
  return tokenPattern.test(value ?? '') ? hash(value) : null;
}

async function identify(request, env) {
  const token = await sessionId(request);
  if (!token) return null;
  const account = await query(env, 'SELECT a.id, a.username FROM studio_sessions s JOIN studio_accounts a ON a.id=s.owner AND a.code_hash=s.code_hash WHERE s.token_hash=? AND s.expires>? AND a.disabled=0', token, Date.now()).first();
  return account ? { owner: account.id, email: account.username, canSignOut: true } : null;
}

const studio = createWorker({}, identify);

async function signIn(request, env) {
  const reader = request.body?.getReader();
  if (!reader || !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return redirect('/login?invalid=1');
  const decoder = new TextDecoder();
  let body = '';
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512) {
      await reader.cancel();
      return redirect('/login?invalid=1');
    }
    body += decoder.decode(value, { stream: true });
  }
  const form = new URLSearchParams(body + decoder.decode());
  const username = (form.get('username') ?? '').trim().toLowerCase();
  const code = (form.get('code') ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || !tokenPattern.test(code)) return redirect('/login?invalid=1');
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const session = await query(env, `INSERT INTO studio_sessions (token_hash,owner,code_hash,expires)
    SELECT ?,id,code_hash,? FROM studio_accounts WHERE username=? AND code_hash=? AND disabled=0 RETURNING owner`, await hash(token), now + sessionSeconds * 1000, username, await hash(code)).first();
  if (!session) return redirect('/login?invalid=1');
  await query(env, 'DELETE FROM studio_sessions WHERE owner=? AND expires<=?', session.owner, now).run();
  return redirect('/', cookie(token, sessionSeconds));
}

function mediaKey(env) {
  if (!/^[a-f0-9]{64}$/i.test(env.FRAMEFLOW_MEDIA_SECRET ?? '')) throw new Error('Missing reference signing secret');
  return crypto.subtle.importKey('raw', Uint8Array.from(env.FRAMEFLOW_MEDIA_SECRET.match(/../g), (pair) => parseInt(pair, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function referenceUrlFactory(env, origin) {
  let key;
  return async (owner, asset) => {
    key ??= mediaKey(env);
    const url = new URL(`/reference/${owner}/${asset}`, origin);
    const expires = String(Math.floor(Date.now() / 1000) + 900);
    const signature = await crypto.subtle.sign('HMAC', await key, encoder.encode(`${url.pathname}:${expires}`));
    url.searchParams.set('expires', expires);
    url.searchParams.set('sig', base64url(signature));
    return url.href;
  };
}

async function reference(env, request, url, owner, asset) {
  const expires = url.searchParams.get('expires') ?? '';
  const signature = url.searchParams.get('sig') ?? '';
  if (/^\d{10}$/.test(expires) && Number(expires) >= Math.floor(Date.now() / 1000) && tokenPattern.test(signature)) {
    const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), (letter) => letter.charCodeAt(0));
    if (await crypto.subtle.verify('HMAC', await mediaKey(env), bytes, encoder.encode(`${url.pathname}:${expires}`))) {
      const key = `assets/${owner}/${asset}`;
      const object = await (request.method === 'HEAD' ? env.BUCKET.head(key) : env.BUCKET.get(key));
      const type = object?.httpMetadata?.contentType;
      if (object && imageTypes.includes(type)) return new Response(object.body ?? null, { headers: { ...securityHeaders, 'Content-Type': type, 'Content-Length': object.size } });
    }
  }
  return new Response('Not found', { status: 404, headers: securityHeaders });
}

async function page(env, url, name) {
  const response = await env.ASSETS.fetch(new URL(`/${name}.html`, url));
  const headers = new Headers(response.headers);
  for (const [header, value] of Object.entries(securityHeaders)) headers.set(header, value);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return Response.json({ error: '请求来源不正确。' }, { status: 403, headers: securityHeaders });
        const online = { DB: env.DB, BUCKET: env.BUCKET, FRAMEFLOW_CONCURRENCY: env.FRAMEFLOW_CONCURRENCY, FRAMEFLOW_CREDENTIAL_SECRET: env.FRAMEFLOW_CREDENTIAL_SECRET, referenceUrl: referenceUrlFactory(env, url.origin) };
        return await studio.fetch(request, online, ctx);
      }
      const match = path.match(referencePath);
      if (match && ['GET', 'HEAD'].includes(request.method)) return await reference(env, request, url, match[1], match[2]);
      if (['/login', '/logout'].includes(path) && request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403, headers: securityHeaders });
        if (path === '/login') return await signIn(request, env);
        const token = await sessionId(request);
        if (token) await query(env, 'DELETE FROM studio_sessions WHERE token_hash=?', token).run();
        return redirect('/login', cookie('', 0));
      }
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404, headers: securityHeaders });
      if (['/', '/index', '/index.html', '/login', '/login.html'].includes(path)) {
        const signedIn = Boolean(await identify(request, env));
        if (path === '/login' || path === '/login.html') return signedIn ? redirect('/') : await page(env, url, 'login');
        return signedIn ? await page(env, url, 'index') : redirect('/login');
      }
      return new Response('Not found', { status: 404, headers: securityHeaders });
    } catch {
      return new Response('工作台暂时不可用，请稍后重试。', { status: 503, headers: securityHeaders });
    }
  }
};
