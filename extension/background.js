/* A toolbar action grants temporary activeTab access; never request all_urls. */
'use strict';
const jobs = new Map();
let lastCapture = 0, captureQueue = Promise.resolve();
const allowed = url => { try { const u = new URL(url); return u.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(u.hostname); } catch { return false; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !allowed(tab.url)) {
    if (tab.id) {
      await chrome.action.setBadgeText({tabId: tab.id, text: 'GPT'});
      await chrome.action.setTitle({tabId: tab.id, title: '请先打开 ChatGPT 网页中的聊天，再点击此按钮'});
    }
    return;
  }
  try {
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['snapshot.js', 'pdf.js', 'export.js', 'content.js']});
    await chrome.action.setBadgeText({tabId: tab.id, text: ''});
  } catch (error) {
    await chrome.action.setBadgeText({tabId: tab.id, text: '!'});
    await chrome.action.setTitle({tabId: tab.id, title: `无法启动：${error.message}。刷新网页后重试。`});
  }
});

async function verify(job, sender) {
  if (!job || job.tabId !== sender.tab?.id || job.expires < Date.now()) throw new Error('截图会话已失效，请重新点击浏览器工具栏的扩展图标。');
  const tab = await chrome.tabs.get(job.tabId);
  const win = await chrome.windows.get(job.windowId);
  if (!tab.active || !win.focused || tab.windowId !== job.windowId || tab.url !== job.url) throw new Error('导出时切换了标签页、窗口或会话，已停止截图，请回到原会话重试。');
  return tab;
}

async function handle(message, sender) {
  if (!sender.tab?.id || sender.frameId !== 0 || !allowed(sender.url)) throw new Error('只支持 ChatGPT 顶层聊天页面。');
  if (message.type === 'CSPDF_BEGIN') {
    const id = crypto.randomUUID();
    const job = {tabId: sender.tab.id, windowId: sender.tab.windowId, url: sender.url, expires: Date.now() + 15 * 60_000};
    await verify(job, sender);
    jobs.set(id, job);
    return {session: id};
  }
  const job = jobs.get(message.session);
  if (message.type === 'CSPDF_END') { if (job?.tabId === sender.tab.id) jobs.delete(message.session); return {}; }
  if (message.type === 'CSPDF_CAPTURE') {
    const capture = async () => {
      await verify(job, sender);
      await wait(Math.max(0, 620 - (Date.now() - lastCapture)));
      await verify(job, sender);
      lastCapture = Date.now();
      const dataURL = await chrome.tabs.captureVisibleTab(job.windowId, {format: 'png'});
      await verify(job, sender);
      return {dataURL};
    };
    const result = captureQueue.then(capture);
    captureQueue = result.catch(() => {});
    return result;
  }
  throw new Error('未知导出请求。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['CSPDF_BEGIN', 'CSPDF_CAPTURE', 'CSPDF_END'].includes(message?.type)) return;
  handle(message, sender).then(value => respond({ok: true, ...value}), error => respond({ok: false, error: error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { for (const [id, job] of jobs) if (job.tabId === tabId) jobs.delete(id); });
