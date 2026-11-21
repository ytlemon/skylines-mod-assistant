'use strict';

/**
 * 源聚合自检：清单解析 / 多源去重 / 版本择优 / 搜索筛选 / 依赖解析 / 缓存落盘
 * 通过替换 ./main/services/http 的实现来离线模拟 GitHub / Gitee 响应。
 * 用法：node tools/selftest-catalog.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const http = require(path.join(root, 'main/services/http'));

const MANIFEST_A = {
  name: 'RepoA',
  mods: [
    {
      id: 'neon-tools',
      name: '霓虹工具箱',
      version: '1.2.0',
      downloadUrl: 'https://github.com/a/b/releases/download/v1.2.0/NeonTools.zip',
      tags: ['工具', 'UI'],
      description: '一站式城市面板',
      deps: ['harmony-core'],
    },
    {
      id: 'harmony-core',
      name: 'Harmony 核心库',
      version: '2.3.5',
      downloadUrl: 'https://github.com/a/b/releases/download/v2.3.5/Harmony.zip',
      tags: ['依赖'],
    },
    {
      id: 'maybe-broken',
      name: '没有下载地址的条目',
      version: '1.0.0',
    },
  ],
};

const MANIFEST_B = {
  name: 'RepoB',
  mods: [
    {
      id: 'neon-tools',
      name: '霓虹工具箱',
      version: '1.4.0',
      downloadUrl: 'https://gitee.com/c/d/releases/download/v1.4.0/NeonTools.zip',
      tags: ['工具'],
      description: '另一份源的更新版本',
      type: 'tool',
    },
    {
      id: 'asset-pack',
      name: '霓虹街区建筑包',
      version: '3.0.1',
      installTo: 'Assets',
      downloadUrl: 'assets/pack.zip',
      tags: ['建筑'],
      size: 58720256,
    },
  ],
};

// 在 repos 模块加载前替换 http 实现（repos 是解构 require 的）
http.getText = async (url) => {
  if (url.includes('/a/b/')) return JSON.stringify(MANIFEST_A);
  if (url.includes('/c/d/')) return JSON.stringify(MANIFEST_B);
  const err = new Error(`HTTP 404：${url}`);
  err.statusCode = 404;
  throw err;
};
http.getJson = async (url) => {
  if (url.includes('api.github.com')) return [];
  if (url.includes('gitee.com/api')) return [];
  const err = new Error(`HTTP 404：${url}`);
  err.statusCode = 404;
  throw err;
};

const catalog = require(path.join(root, 'main/services/catalog'));

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

const userData = path.join(os.tmpdir(), 'neon-catalog-' + Date.now());

(async () => {
  const sources = [
    { id: 'github:a/b', platform: 'github', owner: 'a', repo: 'b', branch: 'main', mode: 'manifest', enabled: true },
    { id: 'gitee:c/d', platform: 'gitee', owner: 'c', repo: 'd', branch: 'master', mode: 'manifest', enabled: true },
    { id: 'github:broken/x', platform: 'github', owner: 'broken', repo: 'x', branch: 'main', mode: 'manifest', enabled: true },
  ];

  catalog.init(userData, () => ({ sources, token: '' }));

  console.log('\n[1] 多源聚合');
  const snap = await catalog.refresh({ force: true });
  ok(snap.entries.length === 3, '合并后 3 个条目（已去掉无下载地址的条目）');
  const neon = snap.entries.find((e) => e.id === 'neon-tools');
  ok(neon.version === '1.4.0', '同 id 保留更高版本 1.4.0');
  ok(neon.sources.length === 2, '合并两个来源');
  ok(neon.origin === 'manifest', '标记来源为清单');
  const asset = snap.entries.find((e) => e.id === 'asset-pack');
  ok(asset.type === 'asset', '按 installTo 推断类型');
  ok(asset.downloadUrl === 'https://gitee.com/c/d/raw/master/assets/pack.zip', '相对下载路径已解析为绝对地址');
  ok(snap.errors.length === 1 && snap.errors[0].sourceId === 'github:broken/x', '失败源单独记录，不影响其它源');

  console.log('\n[2] 搜索 / 筛选 / 排序');
  ok(catalog.search({ q: '霓虹' }).length === 2, '中文关键字命中 2 条');
  ok(catalog.search({ q: 'harmony' }).length === 1, '英文关键字不区分大小写');
  ok(catalog.search({ type: 'asset' }).length === 1, '按类型筛选');
  ok(catalog.search({ q: '不存在的关键字' }).length === 0, '无匹配返回空');
  const byName = catalog.search({ sort: 'name' }).map((e) => e.name);
  ok(byName.length === 3, '名称排序返回全部');

  console.log('\n[3] 依赖解析');
  const deps = catalog.resolveDeps('neon-tools', []);
  ok(deps.required.length === 0, '仅依赖已在清单中的条目时不再重复下载');
  const deps2 = catalog.resolveDeps('neon-tools', ['harmony-core']);
  ok(deps2.required.length === 0 && deps2.missing.length === 0, '依赖已安装则无需补齐');
  const deps3 = catalog.resolveDeps('asset-pack', []);
  ok(deps3.required.length === 0, '无依赖条目返回空列表');

  console.log('\n[4] 缓存');
  const cacheFile = path.join(userData, 'cache', 'catalog.json');
  ok(fs.existsSync(cacheFile), '缓存文件已落盘');
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  ok(Array.isArray(cached.entries) && cached.entries.length === 3, '缓存内容完整');
  const again = await catalog.refresh({ force: false });
  ok(again.fromCache === true, 'TTL 内直接命中缓存');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自检异常：', e);
  process.exit(1);
});
