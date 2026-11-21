'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

/**
 * 校验压缩包条目路径，防 zip slip：
 * - 拒绝绝对路径、盘符路径、`..` 越界、控制字符
 */
function assertSafeEntry(entryName) {
  const name = String(entryName || '');
  if (!name) throw new Error('压缩包存在空路径条目');
  if (/[\x00-\x1f]/.test(name)) throw new Error('压缩包包含非法字符');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) throw new Error(`压缩包包含绝对路径：${name}`);
  if (/^[a-zA-Z]:/.test(normalized)) throw new Error(`压缩包包含盘符路径：${name}`);
  const parts = normalized.split('/');
  if (parts.some((p) => p === '..')) throw new Error(`压缩包包含越界路径：${name}`);
}

function ensureInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('解压路径越界，已拒绝');
}

/** 列出条目（同时做安全校验） */
function list(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(new Error('无法读取压缩包：' + err.message));
      const entries = [];
      zip.on('entry', (entry) => {
        try {
          assertSafeEntry(entry.fileName);
        } catch (e) {
          zip.close();
          return reject(e);
        }
        entries.push({
          name: entry.fileName.replace(/\\/g, '/'),
          size: entry.uncompressedSize,
          isDir: /\/$/.test(entry.fileName),
        });
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', (e) => reject(new Error('读取压缩包失败：' + e.message)));
      zip.readEntry();
    });
  });
}

/**
 * 解压到目标目录（流式，边校验边写盘）
 * @returns {Promise<number>} 解出的文件数
 */
function extract(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return fail(new Error('无法读取压缩包：' + err.message));
      let files = 0;

      zip.on('entry', (entry) => {
        let dest;
        try {
          assertSafeEntry(entry.fileName);
          dest = path.join(destDir, entry.fileName);
          ensureInside(destDir, dest);
        } catch (e) {
          zip.close();
          return fail(e);
        }

        if (/\/$/.test(entry.fileName)) {
          try {
            fs.mkdirSync(dest, { recursive: true });
          } catch (e) {
            zip.close();
            return fail(e);
          }
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamErr, rs) => {
          if (streamErr) {
            zip.close();
            return fail(new Error('解压条目失败：' + streamErr.message));
          }
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
          } catch (e) {
            rs.destroy();
            zip.close();
            return fail(e);
          }
          const ws = fs.createWriteStream(dest);
          ws.on('finish', () => {
            files += 1;
            zip.readEntry();
          });
          ws.on('error', (e) => {
            rs.destroy();
            zip.close();
            fail(new Error('写入文件失败：' + e.message));
          });
          rs.on('error', (e) => {
            ws.destroy();
            zip.close();
            fail(new Error('读取条目失败：' + e.message));
          });
          rs.pipe(ws);
        });
      });

      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(files);
      });
      zip.on('error', (e) => fail(new Error('解压失败：' + e.message)));
      zip.readEntry();
    });
  });
}

module.exports = { list, extract, assertSafeEntry, ensureInside };
