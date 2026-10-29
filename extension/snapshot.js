/* Freeze computed browser layout, not Markdown. No network/API/storage access. */
(() => {
  'use strict';
  const PDF = globalThis.CSPDF ||= {};
  if (PDF.freezeBuild === '0.1.1.1') return;
  PDF.freezeBuild = '0.1.1.1';
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  function backgroundOf(el) {
    const layers = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') throw new Error('消息背后有复杂背景图，暂无法保证外观一致，请选其它消息。');
      layers.push(style.backgroundColor);
    }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? '#121212' : '#fff'; ctx.fillRect(0, 0, 1, 1);
    for (const color of layers.reverse()) { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); }
    const [r,g,b] = ctx.getImageData(0,0,1,1).data;
    return `rgb(${r},${g},${b})`;
  }
  function styleText(style) {
    let result = '';
    // Resolved standard properties already contain var() results. ChatGPT has
    // hundreds of inherited design tokens; repeating them at every node can
    // make a normal long answer exceed tens of megabytes without adding pixels.
    for (const key of style) if (!key.startsWith('--')) result += `${key}:${style.getPropertyValue(key)};`;
    return result;
  }
  PDF.freeze = async function freeze(element) {
    if (!element?.isConnected) throw new Error('原文已离开页面，请滚动加载后重新选择。');
    await document.fonts.ready;
    const images = [...element.querySelectorAll('img')].filter(image => image.getBoundingClientRect().width > 0 && image.getBoundingClientRect().height > 0 && getComputedStyle(image).visibility === 'visible');
    for (const image of images) {
      if (!image.complete) {
        const loading = image.getAttribute('loading');
        try {
          image.loading = 'eager';
          let timer;
          await Promise.race([image.decode().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 8000); })]).finally(() => clearTimeout(timer));
        } finally { if (loading === null) image.removeAttribute('loading'); else image.setAttribute('loading', loading); }
      }
      if (!image.complete) throw new Error('消息中有图片仍在加载，请等图片完整出现后重选。');
    }
    if (element.querySelector('iframe, video, audio, object, embed')) throw new Error('此消息含嵌入窗口、音视频或插件内容，暂不支持保真冻结。请选择普通正文消息。');
    if (element.querySelector('[aria-busy="true"], [data-is-streaming="true"]')) throw new Error('回答仍在生成，请等待完成后选择。');
    await paint();
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) throw new Error('原文尚未渲染，请先定位原文再重选。');
    const originals = [element, ...element.querySelectorAll('*')];
    if (originals.length > 18_000) throw new Error('单条消息过大，请拆分选择。');
    const clone = element.cloneNode(true);
    const copies = [clone, ...clone.querySelectorAll('*')];
    const pseudo = [], scrollStates = [], lines = [], boxes = [];
    const styleIds = new Map(), styleRules = [], pseudoIds = new Map();
    let unsharedCharacters = 0;
    function shareStyle(css) {
      unsharedCharacters += css.length;
      let id = styleIds.get(css);
      if (id === undefined) {
        id = String(styleIds.size); styleIds.set(css, id);
        styleRules.push(`[data-cspdf-style="${id}"]{${css}}`);
      }
      return id;
    }
    function sharePseudo(kind, css) {
      const key = `${kind}\n${css}`;
      let id = pseudoIds.get(key);
      if (id === undefined) {
        id = String(pseudoIds.size); pseudoIds.set(key, id);
        pseudo.push(`[data-cspdf-${kind.slice(2)}="${id}"]${kind}{${css}animation:none!important;transition:none!important;}`);
      }
      return id;
    }
    for (let index = 0; index < originals.length; index++) {
      const source = originals[index], copy = copies[index], style = getComputedStyle(source);
      const box = source.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && style.visibility === 'visible') boxes.push({index, left: box.left - rect.left, top: box.top - rect.top, width: box.width, height: box.height});
      // Repeating hundreds of resolved declarations on every token turns a
      // long formula/code answer into tens of MB. Equal styles share one rule;
      // keep every computed property rather than approximating typography.
      copy.removeAttribute('style');
      copy.dataset.cspdfStyle = shareStyle(styleText(style));
      if (style.position === 'sticky') {
        copy.dataset.cspdfSticky = 'true';
        copy.style.setProperty('position', 'relative', 'important');
        copy.style.setProperty('inset', 'auto', 'important');
      }
      copy.removeAttribute('autofocus');
      for (const attr of [...copy.attributes]) if (/^on/i.test(attr.name) || attr.name === 'srcdoc') copy.removeAttribute(attr.name);
      if (source.matches('script, style, link, noscript')) { copy.remove(); continue; }
      copy.dataset.cspdfNode = String(index);
      if (source.tagName === 'IMG') {
        copy.removeAttribute('srcset'); copy.removeAttribute('sizes'); copy.removeAttribute('loading');
        if (source.complete && !source.naturalWidth) {
          // Keep an already broken image's native placeholder instead of silently
          // dropping it or retrying a remote resource and changing its appearance.
          copy.src = 'data:image/png;base64,AA=='; copy.dataset.cspdfBroken = 'true';
        } else copy.src = source.currentSrc || source.src;
      }
      if (source.tagName === 'CANVAS') {
        let png;
        try { png = source.toDataURL('image/png'); } catch { throw new Error('消息包含受跨域保护的画布，无法完整冻结，请选其它消息。'); }
        const image = document.createElement('img');
        image.src = png; image.style.cssText = copy.style.cssText; image.dataset.cspdfStyle = copy.dataset.cspdfStyle; image.dataset.cspdfNode = String(index);
        image.width = source.width; image.height = source.height; copy.replaceWith(image);
      }
      if (source.scrollLeft || source.scrollTop) scrollStates.push({index, left: source.scrollLeft, top: source.scrollTop});
      for (const kind of ['::before', '::after', '::marker']) {
        const ps = getComputedStyle(source, kind);
        if ((kind === '::marker' && style.display === 'list-item') || (ps.content && !['none', 'normal', '""'].includes(ps.content))) {
          copy.setAttribute(`data-cspdf-${kind.slice(2)}`, sharePseudo(kind, styleText(ps)));
        }
      }
      if (source.matches('img,svg,canvas,tr,.katex-display,math')) {
        const r = source.getBoundingClientRect();
        if (r.height > 0) lines.push({top: r.top - rect.top, bottom: r.bottom - rect.top});
      }
    }
    // Text rects are line boxes, so page boundaries can avoid cutting a line.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && lines.length < 25_000) {
      if (!node.nodeValue.trim() || node.parentElement.closest('script,style,noscript')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.height > 0 && r.width > 0) lines.push({top: r.top - rect.top, bottom: r.bottom - rect.top});
    }
    clone.style.setProperty('margin', '0', 'important');
    clone.style.setProperty('position', 'relative', 'important');
    clone.style.setProperty('top', 'auto', 'important'); clone.style.setProperty('left', 'auto', 'important');
    clone.style.setProperty('right', 'auto', 'important'); clone.style.setProperty('bottom', 'auto', 'important');
    clone.style.setProperty('width', `${rect.width}px`, 'important');
    clone.style.setProperty('min-width', `${rect.width}px`, 'important');
    clone.style.setProperty('max-width', `${rect.width}px`, 'important');
    clone.style.setProperty('box-sizing', 'border-box', 'important');
    // Never carry copied executable elements or site-control focus into the stage.
    for (const input of clone.querySelectorAll('input,textarea,select,button')) { input.tabIndex = -1; }
    styleRules.push('[data-cspdf-node]{animation:none!important;transition:none!important;content-visibility:visible!important;contain:none!important;caret-color:transparent!important;}');
    const snapshot = {html: clone.outerHTML, node: clone, styles: styleRules.join('\n'), pseudo: pseudo.join('\n'), width: rect.width, height: rect.height,
      background: backgroundOf(element), lines, boxes, scrollStates, capturedAt: Date.now(), sourceDPR: devicePixelRatio};
    const representationCharacters = snapshot.html.length + snapshot.styles.length + snapshot.pseudo.length;
    snapshot.styleStats = {nodeCount: originals.length, uniqueStyles: styleIds.size, unsharedCharacters, sharedCharacters: snapshot.styles.length + snapshot.pseudo.length, representationCharacters};
    if (representationCharacters > 32_000_000) throw new Error('这条回答的页面元素过于复杂，暂时无法完整保存外观');
    return snapshot;
  };
})();
