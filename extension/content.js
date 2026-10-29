/* Current-page selection UI. Conversation text and frozen DOM stay in memory. */
(() => {
  'use strict';
  const PDF = globalThis.CSPDF ||= {};
  if (PDF.app?.open) { PDF.app.open(); return; }

  const HOST_ID = 'cspdf-panel-host';
  const ROLES = ['user', 'assistant'];
  const roleSelector = role => `[data-message-author-role="${role}"], [data-turn="${role}"], [data-chatgpt-search-unit-key$=":${role}"], [data-content-search-unit-key$=":${role}"]`;
  const ROLE_SELECTOR = ROLES.map(roleSelector).join(',');
  const TURN = '[data-turn-key], [data-content-search-turn-key], [data-testid^="conversation-turn-"], article, [role="article"]';
  const SELECTOR = `${ROLES.map(roleSelector).join(',')}, [data-conversation-role], article[aria-label], [role="article"][aria-label]`;
  const BLOCKED = '[data-app-shell-active-page="false"], [hidden], [aria-hidden="true"], [inert], aside, nav, [role="dialog"], form, [contenteditable="true"]';
  const mounted = new Map(), selected = new Map(), known = new Map(), pending = new Map(), errors = new Map();
  const order = [], anonymous = new WeakMap(), revisions = new WeakMap();
  const observedEdges = new Map(), dirtyMessages = new Set(), invalidOrdinalFamilies = new Set();
  let orderGraph = new Map(), fullScanNeeded = false, visualRevision = 0;
  let anonymousSequence = 0, requestSequence = 0, selectionSequence = 0, batchSequence = 0;
  let route = routeKey(), generation = 0, root = null, quarantined = new WeakMap();
  let open = true, destroyed = false, busy = false, status = '正在识别本页已加载的问答…';
  let timer = 0, routeTimer = 0, freezeQueue = Promise.resolve(), controller = null;

  function routeKey() { return location.pathname.replace(/\/+$/, '') || '/'; }
  function active(el) {
    return el instanceof Element && el.isConnected && !el.closest(BLOCKED) && !!el.getClientRects().length;
  }
  function conversationRoot() {
    const roots = [...document.querySelectorAll('[data-thread-find-target="conversation"]')];
    const conversationId = /\/c\/([^/]+)(?:\/|$)/.exec(location.pathname)?.[1];
    const identified = roots.filter(el => el.hasAttribute('data-chatgpt-conversation-selection-target'));
    if (conversationId && identified.length) return identified.find(el =>
      el.getAttribute('data-chatgpt-conversation-selection-target')?.toLowerCase() === conversationId.toLowerCase() && active(el)
    ) || null;
    if (roots.length) return roots.find(active) || null;
    return [...document.querySelectorAll('main, [role="main"]')].find(active) || null;
  }
  function roleOf(el) {
    for (const role of ROLES) if (el.matches(roleSelector(role))) return role;
    const heading = el.getAttribute('data-conversation-role');
    if (ROLES.includes(heading)) return heading;
    const label = el.getAttribute('aria-label') || '';
    if (/^(you said\s*[:：]|你说\s*[:：]|您说\s*[:：])/i.test(label)) return 'user';
    if (/^(chatgpt said\s*[:：]|chatgpt\s*说\s*[:：]|助手说\s*[:：])/i.test(label)) return 'assistant';
    return null;
  }
  function canonical(candidate, role) {
    if (candidate.hasAttribute('data-conversation-role')) {
      candidate = candidate.closest(TURN)?.querySelector(roleSelector(role));
      if (!candidate) return null;
    }
    const outer = candidate.closest(`[data-chatgpt-search-unit-key$=":${role}"]`);
    if (outer) return outer;
    const unit = candidate.matches(`[data-content-search-unit-key$=":${role}"]`) ? candidate : candidate.querySelector(`[data-content-search-unit-key$=":${role}"]`);
    if (unit) return unit;
    return candidate.matches(`[data-message-author-role="${role}"]`) ? candidate : candidate.querySelector(`[data-message-author-role="${role}"]`) || candidate;
  }
  function rendered(el) {
    if (el.getClientRects().length) return true;
    const turn = el.closest(TURN);
    if (!turn?.getClientRects().length) return false;
    for (let current = el; current && current !== turn.parentElement; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }
  function identity(el, role) {
    const unit = el.closest('[data-chatgpt-search-unit-key], [data-content-search-unit-key]');
    const raw = el.getAttribute('data-chatgpt-search-message-ids') || el.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids');
    let ids = [];
    if (raw?.trim()) {
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) ids = parsed.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()); } catch { /* A single UUID is also used. */ }
      if (!ids.length) ids = raw.trim().split(/[\s,]+/).filter(Boolean);
    }
    const messageId = el.getAttribute('data-message-id') || el.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (ids.length) return `${role}:messages:${JSON.stringify([...new Set(ids)].sort())}`;
    if (messageId) return `${role}:message:${messageId}`;
    const key = unit?.getAttribute('data-chatgpt-search-unit-key') || unit?.getAttribute('data-content-search-unit-key');
    const turnKey = el.closest('[data-turn-key]')?.getAttribute('data-turn-key') || el.closest('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key');
    if (turnKey) return `${role}:turn:${turnKey}:slot:${/:(\d+):(?:user|assistant)$/.exec(key || '')?.[1] || '0'}`;
    if (key) return `${role}:unit:${key}`;
    const turn = el.closest(TURN);
    const testId = turn?.getAttribute('data-testid');
    if (/^conversation-turn-\d+$/.test(testId || '')) return `${role}:${testId}`;
    if (el.id || turn?.id) return `${role}:anchor:${el.id || turn.id}`;
    if (!anonymous.has(el)) anonymous.set(el, `${role}:local:${++anonymousSequence}`);
    return anonymous.get(el);
  }
  function orderHint(el, role) {
    const turn = el.closest(TURN), unit = el.closest('[data-chatgpt-search-unit-key], [data-content-search-unit-key]');
    const key = unit?.getAttribute('data-chatgpt-search-unit-key') || unit?.getAttribute('data-content-search-unit-key') || '';
    const slot = Number(/:(\d+):(?:user|assistant)$/.exec(key)?.[1] || 0);
    const testId = turn?.getAttribute('data-testid') || '';
    const ordinal = /^conversation-turn-(\d+)$/.exec(testId);
    if (ordinal) return { family: 'conversation-turn', turn: Number(ordinal[1]), slot, role: ROLES.indexOf(role) };
    // An explicitly named conversation-turn is an ordinal; the trailing
    // message slot and fallback-turn-N are not absolute chronology evidence.
    const explicit = /(?:^|:)conversation-turn-(\d+)(?=:|$)/.exec(key) ||
      /^conversation-turn-(\d+)$/.exec(turn?.getAttribute('data-turn-key') || turn?.getAttribute('data-content-search-turn-key') || '');
    return explicit ? { family: 'conversation-turn', turn: Number(explicit[1]), slot, role: ROLES.indexOf(role) } : null;
  }
  function compareHints(a, b) { return a.turn - b.turn || a.slot - b.slot || a.role - b.role; }
  function messageText(el) {
    const parts = [];
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.nodeValue); return; }
      if (!(node instanceof Element) || node.matches('script, style, noscript, button, svg, textarea, input, select, [hidden], [aria-hidden="true"], [data-conversation-role], [contenteditable="true"]')) return;
      if (node.tagName === 'IMG') { parts.push(` [图片${node.getAttribute('alt') ? `：${node.getAttribute('alt')}` : ''}] `); return; }
      if (/^(P|DIV|PRE|LI|TR|H[1-6]|BR|BLOCKQUOTE|SECTION)$/.test(node.tagName)) parts.push('\n');
      for (const child of node.childNodes) visit(child);
      if (/^(TD|TH)$/.test(node.tagName)) parts.push('\t');
    }
    visit(el);
    return parts.join('').replace(/\s+/g, ' ').trim() || (el.querySelector('img, picture, canvas, svg') ? '[图片或图形内容]' : '[非文本消息或附件]');
  }
  function candidates(currentRoot) {
    if (!currentRoot) return [];
    const found = new Map();
    for (const candidate of currentRoot.querySelectorAll(SELECTOR)) {
      const role = roleOf(candidate);
      if (!role) continue;
      const el = canonical(candidate, role);
      if (!el || !currentRoot.contains(el) || el.closest(BLOCKED) || !rendered(el)) continue;
      if (['hidden', 'collapse'].includes(getComputedStyle(el).visibility)) continue;
      const id = identity(el, role), text = messageText(el);
      if (quarantined.get(el) === `${id}\n${text}`) continue;
      quarantined.delete(el);
      const prior = found.get(id);
      // Nested semantic wrappers refer to the same message, never separate rows.
      if (!prior || el.contains(prior.element)) found.set(id, { id, role, element: el, text, ordinal: orderHint(el, role) });
    }
    return [...found.values()].sort((a, b) => a.element === b.element ? 0 : a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  function updateOrder(records) {
    for (const record of records) {
      if (!order.includes(record.id)) order.push(record.id);
      const prior = known.get(record.id);
      if (prior?.ordinal && record.ordinal && (prior.ordinal.family !== record.ordinal.family || compareHints(prior.ordinal, record.ordinal))) invalidOrdinalFamilies.add(prior.ordinal.family);
      known.set(record.id, { ...prior, id: record.id, role: record.role, text: record.text, ordinal: record.ordinal || prior?.ordinal || null });
    }
    for (let index = 1; index < records.length; index++) {
      const before = records[index - 1], after = records[index];
      if (!observedEdges.has(before.id)) observedEdges.set(before.id, new Set());
      observedEdges.get(before.id).add(after.id);
      if (before.ordinal && after.ordinal && before.ordinal.family === after.ordinal.family && compareHints(before.ordinal, after.ordinal) > 0) invalidOrdinalFamilies.add(before.ordinal.family);
    }
    const graph = new Map(order.map(id => [id, new Set(observedEdges.get(id) || [])]));
    const families = new Map();
    for (const record of known.values()) if (record.ordinal && !invalidOrdinalFamilies.has(record.ordinal.family)) {
      if (!families.has(record.ordinal.family)) families.set(record.ordinal.family, []);
      families.get(record.ordinal.family).push(record);
    }
    for (const recordsWithHints of families.values()) {
      recordsWithHints.sort((a, b) => compareHints(a.ordinal, b.ordinal));
      let previousGroup = [], group = [];
      for (const record of recordsWithHints) {
        if (group.length && compareHints(group[0].ordinal, record.ordinal)) { previousGroup = group; group = []; }
        for (const before of previousGroup) graph.get(before.id).add(record.id);
        group.push(record);
      }
    }
    const rank = new Map(order.map((id, index) => [id, index])), indegree = new Map(order.map(id => [id, 0]));
    for (const next of graph.values()) for (const id of next) if (indegree.has(id)) indegree.set(id, indegree.get(id) + 1);
    const ready = order.filter(id => indegree.get(id) === 0), sorted = [];
    while (ready.length) {
      ready.sort((a, b) => rank.get(a) - rank.get(b));
      const id = ready.shift(); sorted.push(id);
      for (const next of graph.get(id) || []) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) ready.push(next);
      }
    }
    // Retain a deterministic display for a changed/branched DOM, but the
    // reachability check below refuses to export an unproven selected order.
    order.splice(0, order.length, ...sorted, ...order.filter(id => !sorted.includes(id)));
    orderGraph = graph;
  }
  function reaches(from, to) {
    const seen = new Set(), todo = [from];
    while (todo.length) {
      const id = todo.pop(); if (id === to) return true;
      if (seen.has(id)) continue; seen.add(id);
      todo.push(...(orderGraph.get(id) || []));
    }
    return false;
  }
  function orderIssue() {
    if (selected.size < 2) return '';
    const ids = order.filter(id => selected.has(id));
    for (let index = 1; index < ids.length; index++) if (!reaches(ids[index - 1], ids[index]) || reaches(ids[index], ids[index - 1])) {
      return '所选消息的先后顺序尚无法确认。请沿聊天连续滚动，让相邻区域重叠加载后重新识别；也可减少跨区域选择。';
    }
    return '';
  }
  function checkRoute() {
    const next = routeKey();
    if (next === route) return false;
    const stale = new WeakMap();
    for (const record of mounted.values()) stale.set(record.element, `${record.id}\n${record.text}`);
    route = next; generation++; controller?.abort(); controller = null;
    mounted.clear(); selected.clear(); known.clear(); pending.clear(); errors.clear(); order.length = 0;
    observedEdges.clear(); orderGraph.clear(); invalidOrdinalFamilies.clear(); dirtyMessages.clear(); fullScanNeeded = false;
    batchSequence++; quarantined = stale; root = null; search.value = ''; selectedOnly.checked = false; status = '已切换会话，已清空之前的选择。正在识别当前会话…';
    render(); return true;
  }
  function scan() {
    if (destroyed) return [];
    checkRoute(); root = conversationRoot();
    const records = candidates(root);
    updateOrder(records); mounted.clear(); dirtyMessages.clear(); fullScanNeeded = false;
    let groupId = null;
    for (const record of records) {
      if (record.role === 'user') groupId = record.id;
      record.groupId = record.role === 'user' ? record.id : groupId || known.get(record.id)?.groupId || null;
      record.order = order.indexOf(record.id);
      mounted.set(record.id, record);
      known.set(record.id, { ...known.get(record.id), groupId: record.groupId });
    }
    if (status.startsWith('正在识别') || status.includes('正在识别当前会话')) status = records.length ? '可独立勾选问题、回答；“整组”选择已加载的对应问答。' : '尚未识别到问答。请打开聊天，或滚动加载消息后重新识别。';
    render(); return records;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, testId, handler, className = '') {
    const node = element('button', className, text); node.type = 'button'; node.dataset.testid = testId;
    node.addEventListener('click', handler); return node;
  }
  const host = element('div'); host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style');
  style.textContent = `
    :host{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:light dark}
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.48}
    .panel,.launcher{pointer-events:auto;color:#182126;background:#fff;border:1px solid #d8dfdc;box-shadow:0 12px 40px #0002}
    .panel{position:absolute;right:16px;top:64px;width:380px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 90px);display:flex;flex-direction:column;border-radius:15px;overflow:hidden;font-size:13px;line-height:1.5}
    .head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e8edeb}.title{margin:0;font-size:16px;font-weight:700}
    button{border:1px solid #d9e0dd;border-radius:8px;background:#f5f8f6;color:inherit;padding:6px 10px}.compact{padding:3px 8px;font-size:12px}.plain{border-color:transparent;background:transparent}
    .intro{margin:12px 16px 8px;color:#59645e;font-size:12px}.intro strong{font-weight:600;color:#35483c}.search{margin:0 16px 10px;padding:8px 10px;width:calc(100% - 32px);border:1px solid #cbd5cf;border-radius:8px;background:transparent;color:inherit}
    .toolbar{display:flex;gap:6px;padding:0 16px 10px;flex-wrap:wrap}.selection-filter{display:flex;align-items:center;gap:4px;font-size:12px}.count{margin:0 16px 8px;font-size:12px;font-weight:600}.order-note{margin:0 16px 8px;padding:8px;border-radius:8px;background:#fff3d8;color:#77501c;font-size:12px}.list{overflow:auto;min-height:64px;max-height:48vh;overscroll-behavior:contain;padding:0 10px 8px;scrollbar-width:thin}
    .row{padding:10px 6px;border-top:1px solid #edf0ee}.row.selected{background:#eaf5ed;border-radius:9px}.choose{display:flex;gap:8px;align-items:flex-start;cursor:pointer}.choose input{flex:none;margin:4px 0 0;accent-color:#157c49;width:16px;height:16px}.body{min-width:0;flex:1}.meta{display:flex;align-items:center;gap:6px;margin-bottom:3px}.role{font-size:11px;padding:1px 6px;border-radius:5px;background:#eaf0ec;color:#3b5747}.cached{font-size:11px;color:#767f79}.text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#34433a}.row-actions{display:flex;gap:6px;padding-left:24px;margin-top:6px}.failure{margin:5px 0 0 24px;font-size:12px;color:#aa3030}.empty{padding:18px 9px;color:#6c756f;font-size:12px}
    .foot{border-top:1px solid #e1e8e3;padding:10px 16px 14px}.status{font-size:12px;color:#637167;min-height:36px;margin-bottom:8px;overflow-wrap:anywhere}.actions{display:flex;gap:8px}.primary{background:#167c4a;border-color:#167c4a;color:white;flex:1;font-weight:600}.danger{color:#a12e2e}.launcher{position:absolute;right:16px;bottom:150px;border-radius:20px;font-size:13px;padding:10px 15px;font-weight:600}
    [hidden]{display:none!important}button:focus-visible,input:focus-visible{outline:3px solid #72b58d;outline-offset:2px}
    @media(max-width:560px){.panel{top:18px;right:12px;max-height:calc(100dvh - 36px)}.list{max-height:45vh}}
    @media(prefers-color-scheme:dark){.panel,.launcher{background:#202723;color:#e7eee9;border-color:#46534b}.head,.foot{border-color:#3a463e}.intro,.status,.cached,.empty{color:#b2c1b6}.intro strong{color:#cfddd3}button{background:#2a352d;border-color:#46564b}.search{border-color:#536459}.text{color:#d1ddd5}.role{background:#35473a;color:#c3d6c9}.row{border-color:#37453b}.row.selected{background:#233c2c}.primary{background:#278558}.failure,.danger{color:#ffabab}}
  `;
  const panel = element('section', 'panel'); panel.dataset.testid = 'cspdf-panel'; panel.setAttribute('aria-label', 'ChatGPT 问答 PDF 导出');
  const head = element('div', 'head'); head.append(element('h2', 'title', '选择问答 · 导出 PDF'), button('收起', 'cspdf-collapse', () => setOpen(false), 'compact plain'));
  const intro = element('p', 'intro'); intro.append(document.createTextNode('独立勾选问题或回答。'), element('strong', '', '已选内容保持勾选时外观；编辑后重选。'), document.createTextNode('向上滚动可加载更早消息。'));
  const search = element('input', 'search'); search.type = 'search'; search.placeholder = '搜索已加载与已选内容'; search.setAttribute('aria-label', search.placeholder); search.dataset.testid = 'cspdf-search'; search.addEventListener('input', render);
  const toolbar = element('div', 'toolbar');
  const selectAllButton = button('全选当前挂载', 'cspdf-select-all', () => selectMany([...mounted.values()]));
  const clearButton = button('清空', 'cspdf-clear', clearSelection);
  const refreshButton = button('重新识别', 'cspdf-refresh', () => { scan(); setStatus(`当前识别到 ${mounted.size} 条问答。未加载历史需手动滚动。`); });
  const selectedOnly = element('input'); selectedOnly.type = 'checkbox'; selectedOnly.dataset.testid = 'cspdf-selected-only';
  selectedOnly.addEventListener('change', () => { if (selectedOnly.checked) search.value = ''; render(); });
  const selectionFilter = element('label', 'selection-filter'); selectionFilter.append(selectedOnly, document.createTextNode('只看已选'));
  toolbar.append(selectAllButton, clearButton, refreshButton, selectionFilter);
  const count = element('p', 'count'); count.dataset.testid = 'cspdf-count';
  const orderNote = element('p', 'order-note'); orderNote.dataset.testid = 'cspdf-order-note'; orderNote.setAttribute('role', 'alert'); orderNote.hidden = true;
  const list = element('div', 'list'); list.dataset.testid = 'cspdf-list'; list.setAttribute('role', 'list');
  const footer = element('div', 'foot'), statusNode = element('div', 'status'); statusNode.dataset.testid = 'cspdf-status'; statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
  const actions = element('div', 'actions');
  const exportButton = button('保存 PDF', 'cspdf-export', startExport, 'primary');
  const stopButton = button('停止', 'cspdf-stop', stop, 'danger');
  actions.append(exportButton, stopButton); footer.append(statusNode, actions);
  panel.append(head, intro, search, toolbar, count, orderNote, list, footer);
  const launcher = button('选择问答 · PDF', 'cspdf-open', () => setOpen(true), 'launcher'); launcher.hidden = true;
  shadow.append(style, panel, launcher); document.documentElement.append(host);

  function setStatus(message) { status = String(message); statusNode.textContent = status; }
  function setOpen(value) { open = value; panel.hidden = !open; launcher.hidden = open; if (open) scan(); }
  function visibleRecords() {
    const combined = new Map(mounted);
    for (const [id, record] of selected) if (!combined.has(id)) combined.set(id, record);
    const query = search.value.trim().toLocaleLowerCase();
    return [...combined.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .filter(record => !selectedOnly.checked || selected.has(record.id) || pending.has(record.id))
      .filter(record => !query || `${selected.get(record.id)?.text || record.text} ${record.role === 'user' ? '问题 用户' : '回答 助手'}`.toLocaleLowerCase().includes(query));
  }
  function render() {
    if (destroyed) return;
    const waiting = pending.size;
    const uncertain = orderIssue(); orderNote.hidden = !uncertain; orderNote.textContent = uncertain;
    count.textContent = `已选 ${selected.size} 条 · 当前加载 ${mounted.size} 条${waiting ? ` · 正在保存 ${waiting} 条快照` : ''}${errors.size ? ` · 失败 ${errors.size} 条` : ''}`;
    launcher.textContent = `问答 PDF${selected.size ? ` · ${selected.size}` : ''}`;
    statusNode.textContent = status;
    selectAllButton.disabled = busy || !mounted.size;
    clearButton.disabled = busy || (!selected.size && !waiting && !errors.size);
    refreshButton.disabled = busy;
    exportButton.disabled = busy || !!waiting || !selected.size || !!uncertain;
    exportButton.title = uncertain;
    stopButton.hidden = !busy && !waiting;
    if (!open) return;
    const rows = [];
    for (const record of visibleRecords()) {
      const saved = selected.get(record.id), isPending = pending.has(record.id), live = mounted.get(record.id);
      const row = element('div', `row${saved ? ' selected' : ''}`); row.dataset.testid = 'cspdf-row'; row.dataset.id = record.id; row.setAttribute('role', 'listitem');
      const choose = element('label', 'choose'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.id = record.id; checkbox.dataset.testid = 'cspdf-select'; checkbox.checked = !!saved || isPending; checkbox.disabled = busy;
      checkbox.setAttribute('aria-label', `选择${record.role === 'user' ? '问题' : '回答'}：${(saved?.text || record.text).slice(0, 80)}`);
      checkbox.addEventListener('change', () => toggleSelection(record.id, checkbox.checked));
      const body = element('div', 'body'), meta = element('div', 'meta'); meta.append(element('span', 'role', record.role === 'user' ? '问题' : '回答'));
      if (isPending) meta.append(element('span', 'cached', '正在保存外观…'));
      else if (saved) meta.append(element('span', 'cached', live ? '已保存外观' : '已缓存 · 原文未挂载'));
      body.append(meta, element('div', 'text', saved?.text || record.text)); choose.append(checkbox, body);
      const rowActions = element('div', 'row-actions');
      const locateButton = button(live ? '定位原文' : '原文未加载', 'cspdf-locate', () => locate(record.id), 'compact plain'); locateButton.disabled = busy || !live;
      const groupButton = button('整组', 'cspdf-group', () => selectGroup(record), 'compact plain'); groupButton.disabled = busy || !record.groupId; groupButton.title = record.groupId ? '选中本组已加载的问题与回答；全部选中时再次点击可取消本组' : '请向上滚动加载对应问题后再整组选取';
      rowActions.append(locateButton, groupButton); row.append(choose, rowActions);
      if (errors.has(record.id)) row.append(element('p', 'failure', `快照失败：${errors.get(record.id)}。请定位原文后重试。`));
      rows.push(row);
    }
    if (!rows.length) rows.push(element('div', 'empty', search.value ? '没有匹配内容。' : '当前没有可选消息。请打开一段聊天，滚动加载内容后重新识别。'));
    const scrollTop = list.scrollTop; list.replaceChildren(...rows); list.scrollTop = scrollTop;
  }
  function validLive(id) {
    const record = mounted.get(id);
    return record && record.element.isConnected && root?.contains(record.element) && !record.element.closest(BLOCKED) && identity(record.element, record.role) === id ? record : null;
  }
  function locate(id) {
    const record = validLive(id);
    if (!record) { scan(); setStatus('原文已被页面卸载，请滚动加载后重新定位。'); return; }
    record.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    setStatus('已定位原文。已缓存的选择不会随原文编辑而更新。');
  }
  function clearSelection() {
    if (busy) return;
    requestSequence++; batchSequence++; pending.clear(); selected.clear(); errors.clear();
    setStatus('已清空选择。'); render();
  }
  function stop() {
    controller?.abort(); requestSequence++; batchSequence++; pending.clear();
    setStatus('已停止，已完成的选择仍保留。'); render();
  }
  function toggleSelection(id, value) {
    if (busy) return;
    if (!value) { pending.delete(id); selected.delete(id); errors.delete(id); render(); return; }
    const record = validLive(id);
    if (!record) { setStatus('此消息的原文暂未挂载，无法重新保存外观。请先滚动加载。'); render(); return; }
    if (selected.has(id) || pending.has(id)) return;
    const token = ++requestSequence, version = generation;
    pending.set(id, token); errors.delete(id); render();
    const capture = async () => {
      if (destroyed || generation !== version || pending.get(id) !== token) return;
      let position = null;
      try {
        checkRoute();
        if (generation !== version || pending.get(id) !== token) return;
        const current = validLive(id);
        if (!current) throw new Error('保存前原文已卸载');
        const rect = current.element.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          const scroller = scrollParent(current.element);
          position = { scroller, top: scroller.scrollTop, left: scroller.scrollLeft };
          current.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          await nextFrame(); await nextFrame();
        }
        if (typeof PDF.freeze !== 'function') throw new Error('快照模块尚未加载，请重新点击扩展按钮');
        if (!validLive(id) || generation !== version) throw new Error('保存时原文已变化，请重新选择');
        if (current.element.closest('[aria-busy="true"], [data-is-streaming="true"]') || current.element.querySelector('[aria-busy="true"], [data-is-streaming="true"]')) throw new Error('回答仍在生成，请等待完成后选择');
        const sourceVersion = revisions.get(current.element) || 0, sourceVisualVersion = visualRevision;
        const text = messageText(current.element);
        const snapshot = await PDF.freeze(current.element);
        if (destroyed || generation !== version || pending.get(id) !== token) return;
        if (!snapshot || typeof snapshot.html !== 'string' || !(snapshot.width > 0) || !(snapshot.height > 0)) throw new Error('快照为空或没有可见尺寸');
        const after = validLive(id);
        if (!after || after.element !== current.element || (revisions.get(current.element) || 0) !== sourceVersion || visualRevision !== sourceVisualVersion || messageText(current.element) !== text) throw new Error('保存期间原文或外观发生变化，请等待回答完成后重选');
        selected.set(id, { id, role: current.role, snapshot, text, groupId: current.groupId, order: order.indexOf(id), selectedAt: ++selectionSequence });
        setStatus(`已保存 ${selected.size} 条消息的外观。编辑原文后请取消并重新勾选。`);
      } catch (error) {
        if (!destroyed && generation === version && pending.get(id) === token) {
          const reason = (error?.message || String(error)).replace(/[。.!\s]+$/, ''); errors.set(id, reason);
          setStatus(`快照失败：${reason}。此消息未加入导出，请定位原文后重新勾选。`);
        }
      } finally {
        if (position && generation === version && position.scroller.isConnected) position.scroller.scrollTo({ top: position.top, left: position.left, behavior: 'instant' });
        if (pending.get(id) === token) pending.delete(id);
        render();
      }
    };
    freezeQueue = freezeQueue.then(capture, capture);
  }
  function selectMany(records, label = '批量选择') {
    if (busy) return;
    const requested = records.filter(record => !selected.has(record.id) && !pending.has(record.id));
    const version = generation, batch = ++batchSequence;
    for (const record of requested) toggleSelection(record.id, true);
    if (!requested.length) return;
    freezeQueue.then(() => {
      if (destroyed || generation !== version || batchSequence !== batch) return;
      const success = records.filter(record => selected.has(record.id)).length;
      const failed = records.filter(record => errors.has(record.id)).length;
      if (failed) { setStatus(`${label}：${success} 条成功、${failed} 条失败。导出只包含已选 ${selected.size} 条；可用“只看已选”核对，清除搜索可查看失败项。`); render(); }
    });
  }
  function selectGroup(record) {
    if (busy || !record.groupId) return;
    const records = [...mounted.values()].filter(item => item.groupId === record.groupId);
    const cached = [...selected.values()].filter(item => item.groupId === record.groupId);
    const ids = new Set([...records, ...cached].map(item => item.id));
    if (ids.size && [...ids].every(id => selected.has(id) || pending.has(id))) {
      for (const id of ids) { selected.delete(id); pending.delete(id); errors.delete(id); }
      setStatus('已取消本组选择。'); render();
    } else { selectMany(records, '本组选择'); if (!records.length) setStatus('本组原文未挂载，请滚动加载后再选取。'); }
  }
  async function startExport() {
    if (busy || pending.size) return;
    checkRoute();
    if (!selected.size) { setStatus('请先选择至少一条消息。'); return; }
    const uncertain = orderIssue();
    if (uncertain) { setStatus(uncertain); render(); return; }
    if (typeof PDF.exportPDF !== 'function') { setStatus('导出模块尚未加载，请重新点击扩展按钮。'); return; }
    const version = generation, currentController = new AbortController(); controller = currentController; busy = true;
    const entries = [...selected.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(({ id, role, snapshot }) => ({ id, role, snapshot }));
    const title = document.title.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT 对话';
    setStatus(`正在导出 ${entries.length} 条消息…`); render(); host.hidden = true;
    try {
      await PDF.exportPDF(entries, { title, signal: currentController.signal, onProgress: message => { if (generation === version) setStatus(message); } });
      if (generation === version && !currentController.signal.aborted) setStatus('PDF 已生成，已交给浏览器下载。');
    } catch (error) {
      if (generation === version) setStatus(currentController.signal.aborted || error?.name === 'AbortError' ? '导出已停止，已选内容仍保留。' : `导出失败：${(error?.message || String(error)).replace(/[。.!\s]+$/, '')}。已选内容仍保留，可重试。`);
    } finally {
      if (controller === currentController) controller = null;
      busy = false; if (!destroyed) { host.hidden = false; render(); if (fullScanNeeded || dirtyMessages.size) schedule(); }
    }
  }
  function scrollParent(el) {
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 4) return parent;
    }
    return document.scrollingElement || document.documentElement;
  }
  function nextFrame() { return new Promise(resolve => requestAnimationFrame(resolve)); }
  function sourceRecord(target) {
    if (!root?.contains(target)) return null;
    const candidate = target.closest(ROLE_SELECTOR);
    const role = candidate && roleOf(candidate), el = role && canonical(candidate, role);
    if (!el?.contains(target)) return null;
    const record = mounted.get(identity(el, role));
    return record?.element === el ? record : null;
  }
  function flush() {
    timer = 0;
    if (destroyed || busy) return;
    if (checkRoute() || fullScanNeeded || conversationRoot() !== root) { scan(); return; }
    let changed = false;
    for (const el of dirtyMessages) {
      const record = sourceRecord(el);
      if (!record || !rendered(el)) { scan(); return; }
      const text = messageText(el);
      if (text !== record.text) {
        record.text = text; known.get(record.id).text = text;
        if (!selected.has(record.id)) changed = true;
      }
    }
    dirtyMessages.clear();
    if (changed) render();
  }
  function schedule(structural = false) {
    fullScanNeeded ||= structural;
    if (!timer && !destroyed) timer = setTimeout(flush, 240);
  }
  const structuralAttributes = new Set(['data-message-author-role', 'data-turn', 'data-message-id', 'data-testid', 'data-chatgpt-search-unit-key', 'data-content-search-unit-key', 'data-chatgpt-search-message-ids', 'data-turn-key', 'data-content-search-turn-key', 'data-thread-find-target', 'data-chatgpt-conversation-selection-target', 'data-app-shell-active-page', 'data-conversation-role']);
  const rootOrMessageSelector = `main, [role="main"], [data-thread-find-target="conversation"], ${SELECTOR}`;
  function containsStructure(node) {
    return node instanceof Element && !node.matches('script,style,link,noscript') && (node.matches(rootOrMessageSelector) || !!node.querySelector(rootOrMessageSelector));
  }
  const observer = new MutationObserver(mutations => {
    if (destroyed) return;
    checkRoute();
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (!target || target.closest(`#${HOST_ID}, #cspdf-export-stage`)) continue;
      const record = sourceRecord(target);
      if (record) {
        revisions.set(record.element, (revisions.get(record.element) || 0) + 1);
        dirtyMessages.add(record.element);
        const changesIdentity = mutation.type === 'attributes' && structuralAttributes.has(mutation.attributeName);
        const changesAvailability = mutation.type === 'attributes' && target === record.element && ['hidden', 'aria-hidden', 'class', 'style'].includes(mutation.attributeName);
        schedule(changesIdentity || changesAvailability);
      } else if (mutation.type === 'attributes') {
        const containsSource = [...mounted.values()].some(item => target.contains(item.element));
        if (containsSource && ['class', 'style', 'hidden', 'aria-hidden', 'aria-busy', 'data-is-streaming'].includes(mutation.attributeName)) visualRevision++;
        if ((structuralAttributes.has(mutation.attributeName) && (!root || root.contains(target) || target.contains(root))) || containsSource) schedule(true);
      } else if (mutation.type === 'childList') {
        if (target === root || [...mutation.addedNodes, ...mutation.removedNodes].some(containsStructure) || root && !root.isConnected) schedule(true);
      }
    }
  });
  observer.observe(document.body || document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...structuralAttributes, 'hidden', 'aria-hidden', 'aria-label', 'aria-busy', 'data-is-streaming', 'class', 'style', 'src', 'srcset', 'sizes', 'alt', 'width', 'height', 'open', 'value', 'checked'] });
  const themeObserver = new MutationObserver(() => { visualRevision++; });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] });
  const onRoute = () => { if (checkRoute()) scan(); };
  const onVisibility = () => { if (document.hidden) { if (busy) controller?.abort(); } else scan(); };
  const onMessage = (message, _sender, sendResponse) => {
    if (message?.type !== 'CSPDF_OPEN') return;
    setOpen(true); sendResponse?.({ ok: true, mounted: mounted.size, selected: selected.size });
  };
  const onPageHide = () => app.destroy();
  window.addEventListener('popstate', onRoute); window.addEventListener('hashchange', onRoute); window.addEventListener('pagehide', onPageHide); document.addEventListener('visibilitychange', onVisibility);
  chrome.runtime.onMessage.addListener(onMessage);
  const app = {
    open: () => setOpen(true), scan, stop,
    getState: () => ({ route, mounted: [...mounted.values()].map(({ id, role, text, groupId, ordinal }) => ({ id, role, text, groupId, ordinal })), selected: [...selected.values()], pending: [...pending.keys()], order: [...order], orderIssue: orderIssue(), busy, status }),
    destroy() {
      if (destroyed) return;
      destroyed = true; generation++; controller?.abort(); observer.disconnect(); themeObserver.disconnect(); clearTimeout(timer); clearInterval(routeTimer);
      window.removeEventListener('popstate', onRoute); window.removeEventListener('hashchange', onRoute); window.removeEventListener('pagehide', onPageHide); document.removeEventListener('visibilitychange', onVisibility); chrome.runtime.onMessage.removeListener(onMessage);
      mounted.clear(); selected.clear(); known.clear(); pending.clear(); errors.clear(); observedEdges.clear(); orderGraph.clear(); dirtyMessages.clear(); invalidOrdinalFamilies.clear(); order.length = 0; host.remove();
      if (PDF.app === app) delete PDF.app;
    }
  };
  PDF.app = app; scan();
  routeTimer = setInterval(() => { if (!destroyed && !document.hidden) { if (checkRoute() || conversationRoot() !== root) scan(); if (!host.isConnected) document.documentElement.append(host); } }, 650);
})();
