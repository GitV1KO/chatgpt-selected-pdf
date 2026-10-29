/* Render frozen DOM with Chromium itself, capture in small tiles, write A4 PDF. */
(() => {
  'use strict';
  const PDF = globalThis.CSPDF ||= {};
  if (PDF.exportBuild === '0.1.2.1') return;
  PDF.exportBuild = '0.1.2.1';
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  async function request(type, payload = {}) {
    const reply = await chrome.runtime.sendMessage({type, ...payload});
    if (!reply?.ok) throw new Error(reply?.error || '扩展没有响应，请刷新网页后重新点击工具栏扩展图标。');
    return reply;
  }
  function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('截图图片无法读取。')); image.src = url; }); }
  function visuallyClipped(el, root) {
    for (let node = el; node && node !== root.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (style.visibility !== 'visible' || Number(style.opacity) === 0 || style.clipPath === 'inset(50%)' || (style.clip !== 'auto' && /rect\(0px,? 0px,? 0px,? 0px\)/.test(style.clip)) || (rect.width <= 2 && rect.height <= 2 && /(hidden|clip)/.test(style.overflow))) return true;
    }
    return false;
  }
  function safeEnd(snapshot, from, ideal) {
    if (ideal >= snapshot.height - .5) return snapshot.height;
    const rects = snapshot.lines.filter(r => r.top >= from - 1 && r.bottom - r.top < (ideal - from) * .8);
    let end = ideal;
    for (let tries = 0; tries < 80; tries++) {
      const crossing = rects.filter(r => r.top < end + 1 && r.bottom > end - 1);
      if (!crossing.length) break;
      const next = Math.min(...crossing.map(r => r.top)) - 2;
      if (next <= from + (ideal - from) * .45) break;
      end = next;
    }
    return Math.max(from + 1, end);
  }
  PDF.exportPDF = async function exportPDF(entries, {title = document.title, onProgress = () => {}, signal} = {}) {
    if (!entries.length) throw new Error('请先选择内容。');
    if (document.querySelector('#cspdf-export-stage')) throw new Error('已有导出正在进行。');
    const geometry = {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href};
    if (innerWidth < 360 || innerHeight < 300) throw new Error('窗口太小，请放大浏览器窗口后导出。');
    let aborted = false, session, stage, pageCanvas, pageY = 0, pages = 0, ratio;
    const abort = () => { aborted = true; };
    const check = () => {
      if (signal?.aborted || aborted) throw new Error('导出已停止，未生成文件。');
      if (document.hidden) throw new Error('导出时离开了当前标签页，已停止，请回到原会话重试。');
      if (innerWidth !== geometry.width || innerHeight !== geometry.height || devicePixelRatio !== geometry.dpr || location.href !== geometry.url) throw new Error('导出时窗口、缩放或会话发生变化，已停止，请重试。');
    };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); abort(); } };
    const onVisibility = () => { if (document.hidden) abort(); };
    signal?.addEventListener('abort', abort);
    document.addEventListener('keydown', onKey, true); document.addEventListener('visibilitychange', onVisibility);
    const pdf = new PDF.RasterPDF();
    const contentWidth = Math.ceil(Math.max(...entries.map(entry => entry.snapshot.width)));
    // The PDF writer places this canvas in a 190 x 277 mm area, inside its
    // existing 10 mm outer margin. Add 10 mm of theme-colored paper on each
    // side, leaving 170 mm for the unchanged browser layout. Both dimensions
    // use the same source scale so text, formulas and images stay proportional.
    const width = contentWidth * 190 / 170;
    const height = contentWidth * 277 / 170;
    const bg = entries[0].snapshot.background;
    async function finishPage() {
      if (!pageCanvas || pageY <= 0) return;
      check(); onProgress(`正在压缩第 ${pages + 1} 页…`);
      await pdf.addPage(pageCanvas); pages++; pageCanvas.width = pageCanvas.height = 1; pageCanvas = null; pageY = 0;
    }
    function canvas() {
      if (!pageCanvas) {
        pageCanvas = document.createElement('canvas'); pageCanvas.width = Math.ceil(width * ratio); pageCanvas.height = Math.ceil(height * ratio);
        if (pageCanvas.width * pageCanvas.height > 35_000_000) throw new Error('当前分辨率过高，请减少浏览器缩放后重试。');
        const ctx = pageCanvas.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      }
      return pageCanvas.getContext('2d');
    }
    try {
      check(); ({session} = await request('CSPDF_BEGIN'));
      stage = document.createElement('div'); stage.id = 'cspdf-export-stage';
      stage.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;overflow:hidden!important;';
      const shadow = stage.attachShadow({mode: 'open'});
      const base = document.createElement('style');
      base.textContent = ':host{color-scheme:normal}*{box-sizing:border-box}.back{position:absolute;inset:0}.bar{position:absolute;top:10px;left:24px;right:24px;height:32px;display:flex;align-items:center;justify-content:space-between;font:13px system-ui;color:#fff;background:#263c32;border-radius:8px;padding:5px 10px}.cancel{font:inherit;border:1px solid #a0b5a8;color:#fff;background:transparent;border-radius:5px;cursor:pointer}.viewport{position:absolute;overflow:hidden;pointer-events:none}.content{position:absolute;top:0;left:0;transform-origin:0 0}.hint{position:absolute;bottom:8px;left:24px;font:12px system-ui;color:#777}';
      const back = document.createElement('div'); back.className = 'back'; back.style.background = bg;
      const bar = document.createElement('div'); bar.className = 'bar';
      const progress = document.createElement('span'); progress.textContent = '正在生成 PDF，请保持此窗口和标签页在前台';
      const stop = document.createElement('button'); stop.className = 'cancel'; stop.textContent = '停止 (Esc)'; stop.onclick = () => { abort(); PDF.app?.stop(); };
      bar.append(progress, stop);
      const viewport = document.createElement('div'); viewport.className = 'viewport';
      const content = document.createElement('div'); content.className = 'content';
      const rules = document.createElement('style');
      const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = '已选消息的渲染预览 · 图片 PDF · 请勿调整窗口或缩放';
      viewport.append(content); shadow.append(base, rules, back, viewport, bar, hint); document.documentElement.append(stage);
      for (let messageIndex = 0; messageIndex < entries.length; messageIndex++) {
        check();
        const snapshot = entries[messageIndex].snapshot;
        const scale = Math.min(1, (innerWidth - 48) / snapshot.width);
        const tileHeight = (innerHeight - 112) / scale;
        viewport.style.cssText = `left:${(innerWidth - snapshot.width * scale) / 2}px;top:56px;width:${snapshot.width * scale}px;height:${tileHeight * scale}px;background:${snapshot.background};`;
        // Only HTML produced by freeze() is accepted; no remote or message HTML is executed.
        content.style.transform = 'none';
        if (snapshot.node instanceof Element) content.replaceChildren(snapshot.node.cloneNode(true));
        else content.innerHTML = snapshot.html;
        rules.textContent = `${snapshot.styles || ''}\n${snapshot.pseudo || ''}`;
        const sourceBoxes = new Map((snapshot.boxes || []).map(box => [String(box.index), box]));
        for (const table of content.querySelectorAll('table')) {
          const cells = [...(table.rows[0]?.cells || [])];
          if (!cells.length || cells.some(cell => cell.colSpan !== 1 || !sourceBoxes.has(cell.dataset.cspdfNode))) continue;
          // Auto table layout re-solves the copied used cell widths and can
          // shift columns. Explicit measured columns keep original wrapping.
          const columns = document.createElement('colgroup');
          for (const cell of cells) {
            const column = document.createElement('col');
            column.style.width = `${sourceBoxes.get(cell.dataset.cspdfNode).width}px`; columns.append(column);
          }
          for (const old of table.querySelectorAll(':scope > colgroup')) old.remove();
          table.prepend(columns); table.style.setProperty('table-layout', 'fixed', 'important');
        }
        // Code toolbars use sticky positioning in the live scroller. A static
        // PDF places each toolbar once in its normal code-block flow; otherwise
        // replaying a scrolled message can pin a toolbar over unrelated text.
        for (const el of content.querySelectorAll('*')) if (getComputedStyle(el).position === 'sticky') {
          el.dataset.cspdfSticky = 'true'; el.style.setProperty('position','relative','important'); el.style.setProperty('inset','auto','important');
        }
        for (const item of snapshot.scrollStates) {
          const el = content.querySelector(`[data-cspdf-node="${item.index}"]`);
          if (el) { el.scrollLeft = item.left; el.scrollTop = item.top; }
        }
        await document.fonts.ready;
        await Promise.all([...content.querySelectorAll('img')].map(image => image.dataset.cspdfBroken || (image.complete && image.naturalWidth) || !image.getBoundingClientRect().width || !image.getBoundingClientRect().height ? Promise.resolve() : image.decode().catch(() => { throw new Error('已选消息中的图片无法重新渲染，请定位图片并重新选择。'); })));
        await paint(); check();
        const clone = content.firstElementChild;
        if (!clone || Math.abs(clone.getBoundingClientRect().height - snapshot.height) > Math.max(3, snapshot.height * .002)) throw new Error('此消息冻结后的布局高度与原文不一致，已停止以免漏内容。请定位原文后重选。');
        const origin = clone.getBoundingClientRect();
        const contentOrigin = content.getBoundingClientRect();
        // A first/last child margin can collapse through a block message. The
        // source border box is our crop, not its parent's positioning origin.
        const insetX = origin.left - contentOrigin.left, insetY = origin.top - contentOrigin.top;
        for (const box of snapshot.boxes || []) {
          if (box.width <= 2 || box.height <= 2) continue;
          const el = content.querySelector(`[data-cspdf-node="${box.index}"]`);
          if (!el || el.closest('[data-cspdf-sticky]') || visuallyClipped(el, clone)) continue;
          const r = el.getBoundingClientRect();
          const delta = [r.left - origin.left - box.left, r.top - origin.top - box.top, r.width - box.width, r.height - box.height];
          if (delta.some(value => Math.abs(value) > 2)) {
            PDF.lastMismatch = {index: box.index, tag: el.tagName, element: el.outerHTML.slice(0, 400), expected: box, actual: {left:r.left-origin.left,top:r.top-origin.top,width:r.width,height:r.height}, delta};
            throw new Error('此消息的布局未能完整复现，已停止以免导出失真。请定位原文后重新选择');
          }
        }
        for (let offset = 0; offset < snapshot.height - .1;) {
          check();
          if (pageY > height - 48) await finishPage();
          const room = height - pageY;
          const ideal = Math.min(snapshot.height, offset + Math.min(tileHeight, room));
          const pageBoundary = room <= tileHeight && ideal < snapshot.height;
          let end = pageBoundary ? safeEnd(snapshot, offset, ideal) : ideal;
          let sliceHeight = end - offset;
          content.style.transform = `scale(${scale}) translate(${-insetX}px,${-offset - insetY}px)`;
          viewport.style.height = `${Math.min(tileHeight, snapshot.height - offset) * scale}px`;
          progress.textContent = `截图第 ${messageIndex + 1}/${entries.length} 条 · 第 ${pages + 1} 页`;
          onProgress(progress.textContent);
          await paint(); check();
          const {dataURL} = await request('CSPDF_CAPTURE', {session}); check();
          const image = await loadImage(dataURL); check();
          const xRatio = image.naturalWidth / innerWidth, yRatio = image.naturalHeight / innerHeight;
          ratio ||= xRatio * scale;
          const frame = viewport.getBoundingClientRect();
          const sx = Math.round(frame.left * xRatio), sy = Math.round(frame.top * yRatio);
          const sw = Math.round(snapshot.width * scale * xRatio), sh = Math.round(sliceHeight * scale * yRatio);
          if (sw < 1 || sh < 1) throw new Error('截图区域尺寸无效，请放大窗口后重试。');
          const ctx = canvas();
          // Destination rows share rounded boundaries: no gaps or duplicate rows.
          const dy = Math.round(pageY * ratio), bottom = Math.round((pageY + sliceHeight) * ratio);
          ctx.drawImage(image, sx, sy, sw, sh, Math.round((width - snapshot.width) / 2 * ratio), dy, Math.round(snapshot.width * ratio), bottom - dy);
          offset = end; pageY += sliceHeight;
          if (pageBoundary) await finishPage();
        }
        pageY += 24;
      }
      await finishPage(); check();
      const blob = pdf.blob(), url = URL.createObjectURL(blob);
      const name = `${String(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'ChatGPT 问答'}-${entries.length}条.pdf`;
      const link = document.createElement('a'); link.href = url; link.download = name; link.style.display = 'none'; document.documentElement.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      onProgress(`PDF 已生成：${entries.length} 条，共 ${pages} 页。请查看浏览器下载记录。`);
      return {pages, messages: entries.length, bytes: blob.size, filename: name};
    } finally {
      stage?.remove(); if (pageCanvas) pageCanvas.width = pageCanvas.height = 1;
      signal?.removeEventListener('abort', abort); document.removeEventListener('keydown', onKey, true); document.removeEventListener('visibilitychange', onVisibility);
      if (session) await request('CSPDF_END', {session}).catch(() => {});
    }
  };
})();
