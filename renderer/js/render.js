/* ============================================================
   渲染层：纯字符串模板 + 格式化工具
   ============================================================ */
(function () {
  'use strict';

  const NM = (window.NM = window.NM || {});
  const R = (NM.render = {});

  const TYPE_LABEL = { mod: '功能', asset: '资产', map: '地图', tool: '工具' };
  const TYPE_EN = { mod: 'FUNCTION', asset: 'ASSET', map: 'MAP', tool: 'TOOL' };
  const STATUS_TEXT = {
    queued: '排队中',
    downloading: '下载中',
    paused: '已暂停',
    verifying: '校验中',
    installing: '安装中',
    done: '已完成',
    error: '失败',
    canceled: '已取消',
  };

  R.esc = function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  R.typeLabel = (t) => TYPE_LABEL[t] || '其它';
  R.typeEn = (t) => TYPE_EN[t] || 'MOD';
  R.statusText = (s) => STATUS_TEXT[s] || s;

  R.fmtSize = function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };

  R.fmtSpeed = function fmtSpeed(bps) {
    const n = Number(bps) || 0;
    if (n <= 0) return '—';
    if (n < 1024) return n.toFixed(0) + ' B/s';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB/s';
    return (n / 1024 / 1024).toFixed(1) + ' MB/s';
  };

  R.fmtEta = function fmtEta(received, total, speed) {
    if (!total || !speed || speed <= 0) return '—';
    const left = Math.max(0, total - received) / speed;
    if (left < 1) return '<1s';
    if (left < 60) return Math.ceil(left) + 's';
    return Math.floor(left / 60) + 'm ' + Math.ceil(left % 60) + 's';
  };

  R.fmtDate = function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  R.monogram = function monogram(name) {
    const s = String(name || '').trim();
    if (!s) return 'M';
    const latin = s.match(/[A-Za-z0-9]/);
    if (/^[\u4e00-\u9fa5]/.test(s)) return s[0];
    return (latin ? latin[0] : s[0]).toUpperCase();
  };

  /* ------------------------------ 卡片 ------------------------------ */
  R.card = function card(entry, installedMap) {
    const installed = installedMap[entry.id];
    const isInstalled = !!installed;
    const tags = (entry.tags || []).slice(0, 3);
    const tagHtml = tags
      .map((t, i) => `<span class="tag${i % 2 ? ' tag--violet' : ''}">${R.esc(t)}</span>`)
      .join('');

    return `
    <article class="card" data-id="${R.esc(entry.id)}" tabindex="0">
      <div class="card-cover cover-${R.esc(entry.type || 'mod')}">
        <span class="cover-mono">${R.esc(R.monogram(entry.name))}</span>
        <span class="cover-type">${R.esc(R.typeEn(entry.type))}</span>
        <span class="cover-ver">v${R.esc(entry.version)}</span>
      </div>
      <div class="card-body">
        <div class="card-title"><span>${R.esc(entry.name)}</span></div>
        <div class="card-author">
          <span>${R.esc(entry.author || '未知作者')}</span>
          <span class="sep">·</span>
          <span>${R.esc(entry.sourceLabel || '')}</span>
        </div>
        <p class="card-desc">${R.esc(entry.description || '暂无简介')}</p>
        <div class="card-tags">${tagHtml}</div>
        <div class="card-foot">
          <div class="card-facts">
            <span>${R.fmtSize(entry.size)}</span>
            <span>${R.esc(entry.updated ? R.fmtDate(entry.updated) : '—')}</span>
          </div>
          ${
            isInstalled
              ? `<button class="card-dl is-installed" disabled>已安装</button>`
              : `<button class="card-dl" data-act="download" data-id="${R.esc(entry.id)}">下载</button>`
          }
        </div>
      </div>
    </article>`;
  };

  R.skeleton = function skeleton(count) {
    return Array.from({ length: count }, () => '<div class="skeleton-card"></div>').join('');
  };

  /* --------------------------- 已安装列表 --------------------------- */
  R.installedRow = function installedRow(item) {
    const statePill = item.updatable
      ? `<span class="state-pill state-update">有新版本 v${R.esc(item.latestVersion)}</span>`
      : item.enabled
      ? `<span class="state-pill state-on">启用中</span>`
      : `<span class="state-pill state-off">已禁用</span>`;

    const sub = item.manual
      ? '手动安装 · 无法比对版本'
      : `${R.esc(item.sourceLabel || item.origin || '本地')} · ${R.fmtDate(item.installedAt)}`;

    return `
    <div class="list-row${item.enabled ? '' : ' is-disabled'}" data-id="${R.esc(item.id)}">
      <div class="row-name">
        <span class="row-mono">${R.esc(R.monogram(item.name))}</span>
        <span class="row-info">
          <span class="row-title">${R.esc(item.name)}</span>
          <span class="row-sub">${sub}${item.hasDll ? '' : ' · 未发现 dll'}</span>
        </span>
      </div>
      <span class="row-ver">${item.version ? 'v' + R.esc(item.version) : '—'}</span>
      <span class="row-size">${R.fmtSize(item.size)}</span>
      <span class="row-state">${statePill}</span>
      <div class="row-ops">
        ${
          item.updatable
            ? `<button class="mini-btn mini-btn--accent" data-act="update" data-id="${R.esc(item.id)}">更新</button>`
            : ''
        }
        <button class="mini-btn" data-act="toggle" data-id="${R.esc(item.id)}">${
      item.enabled ? '禁用' : '启用'
    }</button>
        <button class="mini-btn" data-act="open" data-id="${R.esc(item.id)}">目录</button>
        <button class="mini-btn mini-btn--danger" data-act="uninstall" data-id="${R.esc(item.id)}">卸载</button>
      </div>
    </div>`;
  };

  /* ---------------------------- 队列行 ---------------------------- */
  R.queueRow = function queueRow(task) {
    const pct = Math.max(0, Math.min(100, Number(task.percent) || 0));
    const R_ = 20;
    const C = 2 * Math.PI * R_;
    const offset = C - (C * pct) / 100;
    const ringCls =
      task.status === 'done' ? ' is-done' : task.status === 'error' ? ' is-error' : '';

    let status = '';
    if (task.status === 'downloading') {
      status = `${R.fmtSize(task.received)} / ${R.fmtSize(task.total)} · ${R.fmtSpeed(
        task.speed
      )} · 剩余 ${R.fmtEta(task.received, task.total, task.speed)}`;
    } else if (task.status === 'installing') {
      status = '正在解压并写入游戏目录…';
    } else if (task.status === 'verifying') {
      status = '正在校验文件完整性…';
    } else if (task.status === 'done') {
      status = '下载完成，已安装到游戏目录';
    } else if (task.status === 'error') {
      status = task.error || '下载失败';
    } else if (task.status === 'paused') {
      status = `已暂停 · ${R.fmtSize(task.received)} / ${R.fmtSize(task.total)}`;
    } else {
      status = '排队等待中…';
    }

    const ops = [];
    if (['queued', 'downloading'].includes(task.status)) {
      ops.push(`<button class="mini-btn" data-act="pause" data-task="${R.esc(task.taskId)}">暂停</button>`);
    }
    if (['paused', 'error'].includes(task.status)) {
      ops.push(
        `<button class="mini-btn" data-act="resume" data-task="${R.esc(task.taskId)}">${
          task.status === 'error' ? '重试' : '继续'
        }</button>`
      );
    }
    if (!['done', 'canceled'].includes(task.status)) {
      ops.push(`<button class="mini-btn mini-btn--danger" data-act="cancel" data-task="${R.esc(
        task.taskId
      )}">取消</button>`);
    }
    if (task.status === 'done') {
      ops.push('<span class="state-pill state-on">已安装</span>');
    }

    return `
    <div class="queue-row${task.status === 'done' ? ' is-done' : ''}${
      task.status === 'error' ? ' is-error' : ''
    }" data-task="${R.esc(task.taskId)}">
      <div class="ring${ringCls}">
        <svg width="46" height="46" viewBox="0 0 46 46">
          <circle class="ring-track" cx="23" cy="23" r="${R_}" fill="none" stroke-width="3" />
          <circle class="ring-fill" cx="23" cy="23" r="${R_}" fill="none" stroke-width="3"
            stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />
        </svg>
        <span class="ring-pct">${Math.round(pct)}%</span>
      </div>
      <div class="queue-main">
        <div class="queue-name">${R.esc(task.name)}<span class="v">v${R.esc(task.version)}</span></div>
        <div class="queue-status${task.status === 'error' ? ' is-error' : ''}">${R.esc(status)}</div>
      </div>
      <div class="queue-ops">${ops.join('')}</div>
    </div>`;
  };

  /* ----------------------------- 源卡片 ----------------------------- */
  R.sourceCard = function sourceCard(src, error) {
    const badge = src.platform === 'gitee' ? 'GT' : 'GH';
    return `
    <div class="source-card${error ? ' has-error' : ''}" data-source="${R.esc(src.id)}">
      <span class="source-badge source-badge--${R.esc(src.platform)}">${badge}</span>
      <span class="source-main">
        <span class="source-name">${R.esc(src.owner)}/${R.esc(src.repo)}</span>
        <span class="source-sub${error ? ' is-error' : ''}">${
      error ? R.esc(error) : `${src.mode === 'releases' ? 'Releases 解析' : 'mods.json 清单'} · ${R.esc(src.branch)}`
    }</span>
      </span>
      <span class="source-ops">
        <button class="mini-btn" data-act="refreshSource" data-source="${R.esc(src.id)}">刷新</button>
        <button class="mini-btn mini-btn--danger" data-act="removeSource" data-source="${R.esc(
          src.id
        )}">删除</button>
      </span>
    </div>`;
  };

  R.sourceEmpty = '<div class="source-empty">还没有源，先在下面添加一个仓库</div>';
})();
