import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';

const [action, rawUsername, ...extra] = process.argv.slice(2);
const username = rawUsername?.trim().toLowerCase() ?? '';
if (!['create', 'rotate', 'disable'].includes(action) || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || extra.length) {
  console.error('用法：node invite.mjs <create|rotate|disable> <账号>');
  process.exit(1);
}

const code = action === 'disable' ? '' : randomBytes(32).toString('base64url');
const hash = code ? createHash('sha256').update(code).digest('hex') : '';
const commands = {
  create: `INSERT INTO studio_accounts (id,username,code_hash) VALUES ('${randomUUID()}','${username}','${hash}');`,
  rotate: `UPDATE studio_accounts SET code_hash='${hash}',disabled=0 WHERE username='${username}';`,
  disable: `UPDATE studio_accounts SET disabled=1 WHERE username='${username}';`
};
mkdirSync('outputs', { recursive: true });
const file = `outputs/invite-${randomUUID()}.sql`;
writeFileSync(file, commands[action], { flag: 'wx' });
let result;
try {
  result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['dlx', 'wrangler@4.165.0', 'd1', 'execute', 'DB', '--remote', '--config', 'wrangler.local.jsonc', '--json', '--file', file], { encoding: 'utf8', shell: process.platform === 'win32' });
} finally { unlinkSync(file); }
if (result.error || result.status !== 0) {
  console.error('未修改账号。请检查 Wrangler 登录状态、数据库绑定，或确认账号名未重复。');
  process.exit(1);
}
let changed = false;
try {
  const reports = JSON.parse(result.stdout);
  changed = Array.isArray(reports) && reports[0]?.success && reports[0].meta?.changes === 1;
} catch {}
if (!changed) {
  console.error('未确认账号变更。请检查账号是否存在，必要时用 rotate 重新生成访问码。');
  process.exit(1);
}
console.log(code ? `账号：${username}\n私人访问码：${code}\n请仅私发给该账号使用者。` : `已停用账号：${username}`);
