'use strict';

/**
 * 下载引擎自检：本地 HTTP 服务（支持 Range）+ 断点续传 + 自动安装 + 暂停/继续
 * 用法：node tools/selftest-net.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const downloader = require(path.join(root, 'main/services/downloader'));
const installer = require(path.join(root, 'main/services/installer'));

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

const work = path.join(os.tmpdir(), 'neon-net-' + Date.now());
const userData = path.join(work, 'userData');
const addons = path.join(work, 'Cities_Skylines', 'Addons');
const paths = {
  valid: true,
  addons,
  mods: path.join(addons, 'Mods'),
  assets: path.join(addons, 'Assets'),
  maps: path.join(addons, 'Maps'),
};
fs.mkdirSync(paths.mods, { recursive: true });
fs.mkdirSync(paths.assets, { recursive: true });
fs.mkdirSync(paths.maps, { recursive: true });

// 造一个约 300KB 的 zip（含 dll）
const srcDir = path.join(work, 'src', 'TrafficManager');
fs.mkdirSync(srcDir, { recursive: true });
// 随机内容保证 zip 不可压缩，才能稳定测出「下载中」状态
fs.writeFileSync(path.join(srcDir, 'TrafficManager.dll'), require('crypto').randomBytes(2 * 1024 * 1024));
fs.writeFileSync(path.join(srcDir, 'readme.txt'), 'traffic test', 'utf8');
const zipPath = path.join(work, 'TrafficManager.zip');
execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', path.join(work, 'src'), 'TrafficManager'], {
  stdio: 'pipe',
});
const zipBuf = fs.readFileSync(zipPath);

let requestCount = 0;

/** 分块慢速回写，模拟真实网络以便观察下载中 / 暂停状态 */
function slowWrite(res, body) {
  const CHUNK = 64 * 1024;
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= body.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(body.subarray(offset, offset + CHUNK));
    offset += CHUNK;
  }, 30);
  res.on('close', () => clearInterval(timer));
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/TrafficManager.zip')) {
    res.writeHead(404).end('nope');
    return;
  }
  requestCount++;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const body = zipBuf.subarray(start);
    res.writeHead(206, {
      'Content-Type': 'application/zip',
      'Content-Length': body.length,
      'Content-Range': `bytes ${start}-${zipBuf.length - 1}/${zipBuf.length}`,
      'Accept-Ranges': 'bytes',
    });
    slowWrite(res, body);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zipBuf.length,
    'Accept-Ranges': 'bytes',
  });
  slowWrite(res, zipBuf);
});

const waitFor = (fn, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('等待超时'));
      }
    }, 60);
  });

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const entry = {
    id: 'traffic-manager',
    name: '交通调度中枢',
    version: '2.1.0',
    installTo: 'Mods',
    dirName: 'TrafficManager',
    type: 'mod',
    downloadUrl: `http://127.0.0.1:${port}/TrafficManager.zip`,
    size: zipBuf.length,
  };

  installer.init({ userDataDir: userData, getPaths: () => paths });
  downloader.init({
    userDataDir: userData,
    getSettings: () => ({ concurrency: 2, mirror: '' }),
    installHandler: (e, zip) => installer.install(e, zip),
  });

  const events = [];
  downloader.on('task', (t) => events.push(t));

  try {
    console.log('\n[1] 完整下载 + 自动安装');
    const taskId = downloader.enqueue(entry);
    await waitFor(() => {
      const t = downloader.tasks.get(taskId);
      return t && ['done', 'error'].includes(t.status);
    });
    const task = downloader.tasks.get(taskId);
    ok(task.status === 'done', '任务完成（' + (task.error || '无错误') + '）');
    ok(fs.existsSync(path.join(paths.mods, 'TrafficManager', 'TrafficManager.dll')), '已自动安装到 Addons\\Mods');
    ok(task.received === zipBuf.length, `字节数一致 ${task.received}/${zipBuf.length}`);
    ok(events.length > 3, '收到多个进度事件（' + events.length + ' 个）');
    ok(events.some((e) => e.status === 'installing'), '进度事件包含安装阶段');

    console.log('\n[2] 断点续传');
    const t2 = 'resume-test';
    const taskId2 = downloader.enqueue({ ...entry, id: 'resume-mod', dirName: 'ResumeMod', name: '续传测试' });
    const t2task = downloader.tasks.get(taskId2);
    await waitFor(() => t2task.status === 'downloading' && t2task.received > 0);
    downloader.pause(taskId2);
    await new Promise((r) => setTimeout(r, 250));
    ok(t2task.status === 'paused', '暂停生效');
    const partSize = fs.statSync(t2task.partPath).size;
    ok(partSize > 0 && partSize < zipBuf.length, '已保留 .part 片段 ' + partSize + ' 字节');
    const before = requestCount;
    downloader.resume(taskId2);
    await waitFor(() => ['done', 'error'].includes(t2task.status));
    ok(t2task.status === 'done', '续传后完成');
    ok(requestCount > before, '续传发起了新的 Range 请求');

    console.log('\n[3] 404 失败路径');
    const badId = downloader.enqueue({ ...entry, id: 'bad-mod', name: '坏链接', downloadUrl: `http://127.0.0.1:${port}/missing.zip` });
    await waitFor(() => ['done', 'error'].includes(downloader.tasks.get(badId).status), 20000);
    ok(downloader.tasks.get(badId).status === 'error', '404 归类为失败');
    ok(/404/.test(downloader.tasks.get(badId).error || ''), '错误信息包含状态码');

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  } catch (e) {
    console.error('自检异常：', e.message);
    fail++;
  } finally {
    server.close();
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    process.exit(fail ? 1 : 0);
  }
});
