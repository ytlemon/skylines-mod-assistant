'use strict';

/**
 * 用本机 Git 凭据管理器里的令牌，在 GitHub / Gitee 上创建同名仓库。
 * 令牌只在进程内存里流转：不打印、不写文件、不进日志。
 *
 * 逻辑：先查询仓库是否已存在（上次超时可能其实已建成）→ 不存在才创建
 * 每步带 3 次重试，超时 40s。
 *
 * 用法：
 *   node tools/create-repo.js --name=skylines-mod-assistant --desc="..."
 *   可选：--private   --only=gitee|github
 */
const { execFileSync } = require('child_process');
const path = require('path');
const http = require(path.join(__dirname, '..', 'main', 'services', 'http'));

function arg(key, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : fallback;
}
const flag = (key) => process.argv.includes(`--${key}`);

const NAME = arg('name', 'skylines-mod-assistant');
const DESC = arg('desc', '天际线 1 Mod 助手 · 从自建仓库下载并安装 Cities: Skylines 模组');
const OWNER = arg('owner', 'ytlemon');
const PRIVATE = flag('private');
const ONLY = arg('only', '');

function readToken(host) {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      timeout: 10000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const m = /password=(.+)/.exec(out);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

async function call(url, opts) {
  const res = await http.request(url, { timeout: 40000, ...opts });
  const text = await readBody(res);
  return { code: res.statusCode || 0, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, times = 3) {
  let lastErr = null;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < times - 1) {
        const wait = 1500 * (i + 1);
        console.log(`   ${label} 失败：${e.message}，${wait}ms 后重试`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

function headersFor(platform, token, body) {
  if (platform === 'gitee') {
    return {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    };
  }
  return {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'NeonModAssistant/1.0',
  };
}

function parseErr(platform, text) {
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    msg = j.message || j.error || msg;
    if (Array.isArray(j.errors) && j.errors.length) {
      msg += ' — ' + j.errors.map((e) => e.message || e.code).join('; ');
    }
  } catch {
    /* 原文 */
  }
  return msg;
}

async function checkExists(platform, token) {
  const url =
    platform === 'gitee'
      ? `https://gitee.com/api/v5/repos/${OWNER}/${NAME}?access_token=${encodeURIComponent(token)}`
      : `https://api.github.com/repos/${OWNER}/${NAME}`;
  const opts =
    platform === 'gitee'
      ? {}
      : { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'NeonModAssistant/1.0' } };
  const r = await call(url, opts);
  if (r.code === 200) {
    try {
      const d = JSON.parse(r.text);
      return { exists: true, url: d.html_url, https: d.clone_url };
    } catch {
      return { exists: true };
    }
  }
  if (r.code === 404) return { exists: false };
  throw new Error(`查询返回 HTTP ${r.code}：${parseErr(platform, r.text)}`);
}

async function create(platform, token) {
  if (platform === 'gitee') {
    const body = new URLSearchParams({
      access_token: token,
      name: NAME,
      description: DESC,
      private: PRIVATE ? 'true' : 'false',
      auto_init: 'false',
    }).toString();
    const r = await call('https://gitee.com/api/v5/user/repos', {
      method: 'POST',
      headers: headersFor(platform, token, body),
      body,
    });
    if (r.code === 201 || r.code === 200) {
      const d = JSON.parse(r.text);
      return { url: d.html_url, https: d.clone_url };
    }
    throw new Error(`HTTP ${r.code}：${parseErr(platform, r.text)}`);
  }

  const body = JSON.stringify({
    name: NAME,
    description: DESC,
    private: PRIVATE,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  });
  const r = await call('https://api.github.com/user/repos', {
    method: 'POST',
    headers: headersFor(platform, token, body),
    body,
  });
  if (r.code === 201) {
    const d = JSON.parse(r.text);
    return { url: d.html_url, https: d.clone_url };
  }
  throw new Error(`HTTP ${r.code}：${parseErr(platform, r.text)}`);
}

(async () => {
  const targets = [];
  if (!ONLY || ONLY === 'gitee') targets.push('gitee');
  if (!ONLY || ONLY === 'github') targets.push('github');

  let failed = 0;

  for (const platform of targets) {
    const host = platform === 'gitee' ? 'gitee.com' : 'github.com';
    console.log(`\n===== ${platform} =====`);

    const token = readToken(host);
    if (!token) {
      console.log('未找到本机凭据，跳过');
      failed++;
      continue;
    }
    console.log(`凭据已读取（${token.length} 字符，内容不显示）`);

    try {
      const info = await withRetry('查询', () => checkExists(platform, token));
      if (info.exists) {
        console.log('仓库已存在，无需创建');
        console.log(`  URL  : ${info.url || `https://${host}/${OWNER}/${NAME}`}`);
        console.log(`  克隆 : ${info.https || `https://${host}/${OWNER}/${NAME}.git`}`);
        continue;
      }

      console.log('仓库不存在，开始创建…');
      const r = await withRetry('创建', () => create(platform, token));
      console.log('创建成功');
      console.log(`  URL  : ${r.url}`);
      console.log(`  克隆 : ${r.https}`);
    } catch (e) {
      console.log(`失败：${e.message}`);
      failed++;
    }
  }

  console.log(`\n完成${failed ? `（${failed} 个平台失败）` : '，全部就绪'}`);
  process.exit(failed ? 1 : 0);
})();
