'use strict';

/**
 * 离线自检：安装 / 备份 / 回滚 / 启禁用 / 卸载 / 本地扫描 / zip 安全校验
 * 用法：node tools/selftest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const installer = require(path.join(root, 'main/services/installer'));
const local = require(path.join(root, 'main/services/local'));
const zipUtil = require(path.join(root, 'main/services/zip'));
const { compareVersion } = require(path.join(root, 'main/services/repos'));

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

const work = path.join(os.tmpdir(), 'neon-selftest-' + Date.now());
const userData = path.join(work, 'userData');
const addons = path.join(work, 'Cities_Skylines', 'Addons');
const mods = path.join(addons, 'Mods');
const assets = path.join(addons, 'Assets');
const maps = path.join(addons, 'Maps');
const srcDir = path.join(work, 'src', 'NeonTools');
const zipPath = path.join(work, 'NeonTools.zip');

fs.mkdirSync(mods, { recursive: true });
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(maps, { recursive: true });
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, 'NeonTools.dll'), Buffer.alloc(2048, 1));
fs.writeFileSync(path.join(srcDir, 'readme.txt'), 'hello neon', 'utf8');
fs.mkdirSync(path.join(srcDir, 'Locale'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'Locale', 'zh.txt'), '中文内容', 'utf8');

// 用 Windows 自带 bsdtar 打 zip（-a 按扩展名识别格式）
execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', path.join(work, 'src'), 'NeonTools'], {
  stdio: 'pipe',
});

const fakePaths = {
  valid: true,
  addons,
  mods,
  assets,
  maps,
};

installer.init({ userDataDir: userData, getPaths: () => fakePaths });
local.init({ userDataDir: userData, getPaths: () => fakePaths });

const entry = {
  id: 'neon-tools',
  name: '霓虹工具箱',
  version: '1.2.0',
  installTo: 'Mods',
  dirName: 'NeonTools',
  type: 'mod',
  author: 'ytlemon',
  deps: [],
  tags: ['工具'],
  sourceLabel: 'GitHub · ytlemon/neon-mods',
};

(async () => {
  console.log('\n[1] zip 安全校验');
  ok(
    (() => {
      try {
        zipUtil.assertSafeEntry('../../evil.txt');
        return false;
      } catch {
        return true;
      }
    })(),
    '拒绝 ../ 越界路径'
  );
  ok(
    (() => {
      try {
        zipUtil.assertSafeEntry('C:\\Windows\\evil.dll');
        return false;
      } catch {
        return true;
      }
    })(),
    '拒绝盘符绝对路径'
  );
  ok(zipUtil.assertSafeEntry('Folder/NeonTools.dll') === undefined, '允许正常相对路径');

  console.log('\n[2] 安装');
  const r1 = await installer.install(entry, zipPath);
  ok(r1.ok === true, '安装返回成功');
  ok(fs.existsSync(path.join(mods, 'NeonTools', 'NeonTools.dll')), 'dll 已落盘');
  ok(fs.existsSync(path.join(mods, 'NeonTools', 'Locale', 'zh.txt')), '子目录已落盘');
  ok(r1.hasDll === true, '识别到 dll');
  const meta = JSON.parse(fs.readFileSync(path.join(mods, 'NeonTools', '.neon-mod.json'), 'utf8'));
  ok(meta.id === 'neon-tools' && meta.version === '1.2.0', '写入元数据');
  ok(r1.size > 2048, '统计体积 ' + r1.size + ' 字节');

  console.log('\n[3] 本地扫描');
  let list = local.listAll();
  ok(list.valid === true, '扫描目录有效');
  ok(list.items.length === 1, '识别 1 个已装 Mod');
  ok(list.items[0].id === 'neon-tools', 'id 正确');
  ok(list.items[0].enabled === true, '默认启用');
  ok(list.items[0].manual === false, '非手动安装');

  console.log('\n[4] 更新比对');
  const withUp = local.withUpdates(list.items, [
    { id: 'neon-tools', version: '1.3.0', size: 4096, downloadUrl: 'https://x/y.zip' },
  ]);
  ok(withUp[0].updatable === true, '检测到可更新');
  ok(compareVersion('1.2.0', '1.3.0') < 0, '版本比较 1.2.0 < 1.3.0');
  ok(compareVersion('v2.0.0', '2.0.0') === 0, 'v 前缀视作同版本');

  console.log('\n[5] 禁用 / 启用');
  const rec = local.listAll().items[0];
  installer.setEnabled(rec, false);
  ok(!fs.existsSync(path.join(mods, 'NeonTools')), '禁用后移出 Mods');
  list = local.listAll();
  ok(list.items.length === 1 && list.items[0].enabled === false, '禁用状态仍可见');
  installer.setEnabled(list.items[0], true);
  ok(fs.existsSync(path.join(mods, 'NeonTools', 'NeonTools.dll')), '重新启用后回到 Mods');

  console.log('\n[6] 覆盖安装自动备份 + 回滚');
  const r2 = await installer.install({ ...entry, version: '1.3.0' }, zipPath);
  ok(r2.ok && !!r2.backup, '覆盖前已备份');
  ok(installer.listBackups('neon-tools').length === 1, '备份列表有 1 份');
  const rb = installer.rollback(local.listAll().items[0]);
  ok(rb.ok && fs.existsSync(path.join(mods, 'NeonTools', 'NeonTools.dll')), '回滚后文件仍在');

  console.log('\n[7] 卸载');
  const un = installer.uninstall(local.listAll().items[0], { backup: true });
  ok(un.ok && !fs.existsSync(path.join(mods, 'NeonTools')), '卸载后目录已清理');
  ok(installer.listBackups('neon-tools').length >= 2, '卸载时保留了备份');

  console.log('\n[8] 拒绝非法安装位置');
  let rejected = false;
  try {
    await installer.install({ ...entry, dirName: '../../escape' }, zipPath);
  } catch {
    rejected = true;
  }
  ok(rejected, '目录名越界被拒绝');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自检异常：', e);
  process.exit(1);
});
