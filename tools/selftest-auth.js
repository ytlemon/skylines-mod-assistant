'use strict';

/**
 * 密钥存储自检：加密落盘 / 读回 / 掩码 / 清除 / 迁移旧 token
 * 用法：node tools/selftest-auth.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const settings = require(path.join(root, 'main/services/settings'));

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label);
  }
}

const dir = path.join(os.tmpdir(), 'neon-auth-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
settings.init(dir);

const GITEE = 'gitee_tok_abcdef1234567890';
const GH = 'ghp_0123456789abcdefghij';

console.log('\n[1] 保存与读取');
let state = settings.setCredential('gitee', GITEE);
ok(state.gitee.saved === true, 'Gitee 标记为已保存');
ok(state.github.saved === false, 'GitHub 仍未保存');
ok(!JSON.stringify(state).includes(GITEE), '状态里不返回明文密钥');
ok(
  state.gitee.hint.includes('••••') && state.gitee.hint.length < GITEE.length && !state.gitee.hint.includes('abcdef12'),
  '掩码隐藏中间内容'
);

const raw = fs.readFileSync(settings.file, 'utf8');
ok(!raw.includes(GITEE), '配置文件里没有明文密钥');
ok(/plain:|enc:/.test(raw), '配置文件里是编码后的密文');

ok(settings.getCredential('gitee') === GITEE, '内存中能取回明文（供请求使用）');

console.log('\n[2] 重新加载');
settings.init(dir);
ok(settings.getCredential('gitee') === GITEE, '重新读盘后仍能解密');
ok(settings.getCredential('github') === '', '未设置的平台为空');

console.log('\n[3] 修改 / 清除');
settings.setCredential('github', GH);
ok(settings.getCredential('github') === GH, 'GitHub 密钥独立保存');
state = settings.clearCredential('gitee');
ok(state.gitee.saved === false, '清除后标记为未保存');
ok(settings.getCredential('gitee') === '', '清除后取不到明文');
ok(settings.getCredential('github') === GH, '清除 Gitee 不影响 GitHub');

console.log('\n[4] 非法输入');
let rejected = 0;
try {
  settings.setCredential('gitee', '');
} catch {
  rejected++;
}
try {
  settings.setCredential('bitbucket', 'x');
} catch {
  rejected++;
}
try {
  settings.setCredential('gitee', 'abc def');
} catch {
  rejected++;
}
ok(rejected === 3, '空值 / 未知平台 / 含空格均被拒绝');

console.log('\n[5] 旧版本 token 迁移');
const dir2 = path.join(os.tmpdir(), 'neon-auth-migrate-' + Date.now());
fs.mkdirSync(dir2, { recursive: true });
fs.writeFileSync(
  path.join(dir2, 'settings.json'),
  JSON.stringify({ token: 'ghp_legacy_token', sources: [], concurrency: 3 }),
  'utf8'
);
const legacy = require(path.join(root, 'main/services/settings'));
// 重新加载模块以获得干净的缓存
delete require.cache[require.resolve(path.join(root, 'main/services/settings'))];
const settings2 = require(path.join(root, 'main/services/settings'));
settings2.init(dir2);
ok(settings2.getCredential('github') === 'ghp_legacy_token', '旧 token 自动迁移为 GitHub 密钥');
ok(!('token' in settings2.get()), '旧 token 字段已移除');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
for (const d of [dir, dir2]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}
process.exit(fail ? 1 : 0);
