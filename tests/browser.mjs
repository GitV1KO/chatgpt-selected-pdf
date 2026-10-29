import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fixtureHTML } from './fixture.mjs';

const require = createRequire(import.meta.url);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(project, 'extension');
const output = path.join(project, 'tests', 'results');
const results = [], requests = [], pageErrors = [];
const started = new Date().toISOString();
const filter = process.env.CSPDF_TEST_FILTER;
await mkdir(output, { recursive: true });

function loadPlaywright() {
  const candidates = [process.env.CSPDF_PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  for (const candidate of candidates) {
    try { return { ...require(candidate), version: require(`${candidate}/package.json`).version }; } catch { /* Try the next local runtime. */ }
  }
  throw new Error('Playwright is unavailable. Set CSPDF_PLAYWRIGHT_MODULE to a local Playwright module directory.');
}

async function browserExecutable() {
  if (process.env.CSPDF_BROWSER_EXECUTABLE) return process.env.CSPDF_BROWSER_EXECUTABLE;
  for (const candidate of ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/brave-browser', '/usr/bin/chromium']) {
    try { await access(candidate); return candidate; } catch { /* Try the next platform. */ }
  }
  return undefined;
}

const { chromium, version: playwrightVersion } = loadPlaywright();
const profile = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-selected-pdf-test-'));
let context, page, worker, browserCDP, extensionId;
const host = '#cspdf-panel-host';
const ui = id => page.getByTestId(`cspdf-${id}`);
const rows = () => ui('row');

async function waitRows(count) {
  await page.waitForFunction(count => document.querySelector('#cspdf-panel-host')?.shadowRoot?.querySelectorAll('[data-testid="cspdf-row"]').length === count, count);
}

async function waitSelected(count) {
  await page.waitForFunction(count => {
    const root = document.querySelector('#cspdf-panel-host')?.shadowRoot;
    return root?.querySelectorAll('.row.selected').length === count && !/正在保存/.test(root.querySelector('[data-testid="cspdf-count"]').textContent);
  }, count, { timeout: 30_000 });
}

async function openSelection(count) {
  await activateAction();
  await page.locator(host).waitFor();
  await ui('panel').waitFor({ state: 'visible' });
  if (count !== undefined) await waitRows(count);
}

async function select(indices) {
  for (const index of indices) await ui('select').nth(index).check();
  await waitSelected(indices.length);
}

async function downloadPDF(name) {
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await ui('export').click();
  const download = await downloadPromise;
  const pdfPath = path.join(output, `${name}.pdf`);
  await download.saveAs(pdfPath);
  assert.equal(await download.failure(), null);
  const bytes = await readFile(pdfPath);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 1000, 'Expected rendered content in the PDF.');
  await page.waitForFunction(() => /PDF 已生成/.test(document.querySelector('#cspdf-panel-host')?.shadowRoot?.querySelector('[data-testid="cspdf-status"]').textContent || ''), null, { timeout: 120_000 });
  return { pdfPath, bytes: bytes.length, filename: download.suggestedFilename() };
}

function inspectPDF(pdfPath, { minPages = 1, rich = false, sourceScreenshots = [] } = {}) {
  const python = process.env.CSPDF_PYTHON || 'python3';
  const result = spawnSync(python, ['-c', `
import glob,json,os,subprocess,sys
from pypdf import PdfReader
from PIL import Image,ImageChops,ImageStat
p=PdfReader(sys.argv[1]); shapes=[]; colors={'green':0,'gold':0,'blue':0,'dark':0}; images=0; embedded=[]; side_margins=[]
for page in p.pages:
 for obj in page.images:
  im=obj.image.convert('RGB'); shapes.append(list(im.size)); images+=1;embedded.append(im.copy())
  band=max(1,int(im.width*10/190)-2)
  left=im.crop((0,0,band,im.height));right=im.crop((im.width-band,0,im.width,im.height))
  paper=im.getpixel((0,0))
  left_difference=max(pair[1] for pair in ImageChops.difference(left,Image.new('RGB',left.size,paper)).getextrema())
  right_difference=max(pair[1] for pair in ImageChops.difference(right,Image.new('RGB',right.size,paper)).getextrema())
  side_margins.append({'pixels':band,'leftMaxDifference':left_difference,'rightMaxDifference':right_difference,'leftUniform':left_difference<=2,'rightUniform':right_difference<=2})
  for (r,g,b) in im.resize((min(300,im.width),min(300,im.height))).getdata():
   if g>r*1.25 and g>b*1.1 and g>70: colors['green']+=1
   if r>g*1.1 and g>b*1.25 and r>100: colors['gold']+=1
   if b>r*1.2 and b>g*1.1 and b>70: colors['blue']+=1
   if max(r,g,b)<75: colors['dark']+=1
prefix=os.path.splitext(sys.argv[1])[0]+'-page'
subprocess.run(['pdftoppm','-png','-r','96',sys.argv[1],prefix],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
rasters=sorted(glob.glob(prefix+'-*.png')); markers=[]
targets={'red':(221,42,75),'green':(33,170,121),'blue':(35,112,222)}
for filename in rasters:
 im=Image.open(filename).convert('RGB');im.thumbnail((220,100000))
 for y in range(im.height):
  counts={key:0 for key in targets}
  for x in range(im.width):
   color=im.getpixel((x,y))
   for key,target in targets.items():
    if max(abs(a-b) for a,b in zip(color,target))<18: counts[key]+=1
  key=max(counts,key=counts.get)
  if counts[key]>20 and (not markers or markers[-1]!=key):markers.append(key)
comparisons=[]; expected=json.loads(sys.argv[2]); top=0
if expected:
 image=embedded[0];image.save(os.path.splitext(sys.argv[1])[0]+'-embedded.png')
 for item in expected:
  source=Image.open(item['path']).convert('RGB'); width=min(round(item['width']),source.width); height=min(round(item['height']),source.height)
  source=source.crop((0,0,width,height)); x=round((image.width-item['width'])/2); y=round(item.get('top',top)+item.get('offset',0));best=None
  for dx in range(-2,3):
   for dy in range(-2,3):
    if x+dx<0 or y+dy<0:continue
    crop=image.crop((x+dx,y+dy,x+dx+width,y+dy+height));diff=ImageChops.difference(source,crop)
    mean=sum(ImageStat.Stat(diff).mean)/3
    if best is None or mean<best['meanAbsoluteError']:
     gray=diff.convert('L'); histogram=gray.histogram();changed=sum(histogram[36:])/(width*height)
     best={'meanAbsoluteError':mean,'changedPixelFractionOver35':changed,'offset':[dx,dy]}
  comparisons.append({'source':item['path'],**best});top+=item['height']+24
print(json.dumps({'pages':len(p.pages),'images':images,'shapes':shapes,'sideMargins':side_margins,'colors':colors,'markerOrder':markers,'rasters':rasters,'sourcePixelComparisons':comparisons,'textCharacters':sum(len(page.extract_text()) for page in p.pages)}))
`, pdfPath, JSON.stringify(sourceScreenshots)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout.trim());
  assert.ok(info.pages >= minPages, `Expected at least ${minPages} PDF pages, got ${info.pages}.`);
  assert.ok(info.images > 0, 'PDF must contain actual rendered screenshot images.');
  assert.ok(info.shapes.every(([width, height]) => width > 0 && height > 0));
  assert.ok(info.shapes.every(([width, height]) => Math.abs(width / height - 190 / 277) < .002), 'Padding must preserve proportional A4 rendering.');
  assert.ok(info.sideMargins.every(margin => margin.leftUniform && margin.rightUniform), 'Every PDF page must have clean 10mm theme-colored left and right inner margins.');
  if (rich) for (const color of ['green', 'gold', 'blue']) assert.ok(info.colors[color] > 20, `Rendered PDF lost fixture ${color} content.`);
  for (const comparison of info.sourcePixelComparisons) {
    assert.ok(comparison.meanAbsoluteError < 9, `PDF differs from actual source screenshot: ${JSON.stringify(comparison)}`);
    assert.ok(comparison.changedPixelFractionOver35 < .12, `Too many changed pixels in PDF versus actual source screenshot: ${JSON.stringify(comparison)}`);
  }
  return info;
}

async function activateAction(targetPage = page) {
  await targetPage.bringToFront();
  const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const target = targetInfos.find(info => info.url === targetPage.url());
  assert.ok(target, `Browser tab target missing for ${targetPage.url()}`);
  // This is Chromium's native toolbar action path, including its activeTab grant.
  // Dispatching the extension's onClicked listener manually would not grant it.
  await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
}

async function fresh(name, { layout = 'legacy', count = 4, dark = false, domain = 'chatgpt.com' } = {}) {
  await page?.close();
  for (const candidate of context.pages()) if (candidate.url().startsWith(`chrome-extension://${extensionId}/`)) await candidate.close();
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => pageErrors.push({ scenario: name, message: error.message }));
  await page.goto(`https://${domain}/c/${name}?layout=${layout}&count=${count}&dark=${dark ? 1 : 0}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  await page.locator('article').first().waitFor();
}

async function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  const start = performance.now();
  try {
    const details = await fn();
    results.push({ name, passed: true, durationMs: Math.round(performance.now() - start), ...(details ? { details } : {}) });
    await rm(path.join(output, `failure-${name}.png`), { force: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, durationMs: Math.round(performance.now() - start), error: error.stack || String(error) });
    console.error(`FAIL ${name}: ${error.message}`);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, `failure-${name}.png`) }).catch(() => {});
  }
}

try {
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('activeTab'), 'Screenshot export must request activeTab.');
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'), 'The shipped manifest must not acquire a broad test-only permission.');
  context = await chromium.launchPersistentContext(profile, {
    executablePath: await browserExecutable(),
    headless: process.env.CSPDF_HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging'],
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    acceptDownloads: true,
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['chatgpt.com', 'chat.openai.com'].includes(url.hostname) && request.resourceType() === 'document') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHTML() });
    } else if (url.protocol === 'chrome-extension:') {
      await route.continue();
    } else {
      requests.push({ url: request.url(), resourceType: request.resourceType() });
      await route.abort();
    }
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  browserCDP = await context.browser().newBrowserCDPSession();

  await check('original-manifest-native-action-and-real-activeTab-capture', async () => {
    await fresh('permission', { count: 1 });
    const before = await worker.evaluate(async () => {
      try { await chrome.tabs.captureVisibleTab({ format: 'png' }); return 'unexpected-success'; }
      catch (error) { return error.message; }
    });
    assert.match(before, /activeTab|permission|permissions/i, 'Capture must require an actual native action first.');
    await activateAction();
    const captured = await worker.evaluate(async () => await chrome.tabs.captureVisibleTab({ format: 'png' }));
    assert.ok(captured.startsWith('data:image/png;base64,'));
    const data = Buffer.from(captured.split(',')[1], 'base64');
    assert.equal(data.subarray(1, 4).toString(), 'PNG');
    assert.ok(data.length > 20_000, 'Expected real rendered fixture pixels, not an empty or mocked image.');
    await writeFile(path.join(output, 'native-activeTab-capture.png'), data);
    return { permissionGrant: 'Native Extensions.triggerAction in original unmodified manifest', screenshotAPI: 'chrome.tabs.captureVisibleTab', screenshotBytes: data.length };
  });

  await check('legacy-and-modern-layout-independent-message-selection', async () => {
    for (const layout of ['legacy', 'modern']) {
      await fresh(`layout-${layout}`, { layout });
      assert.equal(await page.locator(host).count(), 0, 'Content scripts should wait for explicit extension activation.');
      await openSelection(8);
      assert.match(await rows().first().innerText(), /问题 1/);
      assert.match(await rows().nth(1).innerText(), /渲染后的内容保真检查/);
      await select([0, 3, 6]);
      assert.equal(await ui('select').nth(1).isChecked(), false, 'Answers must be independently selectable.');
      assert.equal(await ui('select').nth(2).isChecked(), false, 'Questions must be independently selectable.');
      await ui('clear').click();
      await waitSelected(0);
      await rows().first().getByTestId('cspdf-group').click();
      await waitSelected(2);
      assert.equal(await ui('select').nth(0).isChecked(), true);
      assert.equal(await ui('select').nth(1).isChecked(), true);
      assert.equal(await ui('select').nth(2).isChecked(), false);
    }
    return { layouts: ['Legacy author roles', 'Modern search-unit and message-id markers'], independentSelections: 3, groupedSelections: 2 };
  });

  await check('search-hidden-duplicate-and-safe-literal-preview', async () => {
    await fresh('search-hidden');
    await page.evaluate(() => {
      window.fixture.hideClone('fixture-u-1');
      window.fixture.inactiveShell();
      document.querySelector('[data-fixture-message="fixture-u-4"]').textContent = '<img src=x onerror=alert(1)> 是纯文本';
    });
    await openSelection(8);
    await ui('search').fill('JavaScript');
    await waitRows(1);
    assert.match(await rows().first().innerText(), /渲染后的内容/);
    await ui('search').fill('<img src=x');
    await waitRows(1);
    assert.equal(await ui('list').locator('img').count(), 0);
    await ui('search').fill('');
    await waitRows(8);
    await ui('select').first().check();
    await waitSelected(1);
    return { renderedMessages: 8, cssHiddenDuplicatesIgnored: 1 };
  });

  await check('selected-snapshot-survives-edit-and-preserves-conversation-order', async () => {
    await fresh('snapshot-order', { count: 2 });
    await page.evaluate(() => {
      const colors = ['rgb(221,42,75)', 'rgb(33,170,121)', 'rgb(35,112,222)', 'rgb(0,0,0)'];
      for (const [index, message] of [...document.querySelectorAll('[data-fixture-message]')].entries()) {
        message.innerHTML = '<p>快照消息 '+index+'</p><div style="height:80px;background:'+colors[index]+'"></div>';
      }
    });
    const sourceScreenshots = [];
    for (let index = 0; index < 3; index++) {
      const target = page.locator('[data-fixture-message]').nth(index);
      const box = await target.boundingBox();
      const screenshotPath = path.join(output, `snapshot-source-${index}.png`);
      await target.screenshot({ path: screenshotPath });
      sourceScreenshots.push({ path: screenshotPath, width: box.width, height: box.height });
    }
    await openSelection(4);
    await select([2, 0, 1]); // Deliberately select out of conversation order.
    await page.evaluate(() => {
      document.querySelector('[data-fixture-message="fixture-u-1"]').innerHTML = '<p>编辑后不应出现在已保存快照中的内容</p><div style="height:80px;background:rgb(0,0,0)"></div>';
      document.querySelector('[data-fixture-message="fixture-u-2"]').closest('article').remove();
    });
    await page.waitForFunction(() => /已缓存 · 原文未挂载/.test(document.querySelector('#cspdf-panel-host')?.shadowRoot?.querySelector('[data-testid="cspdf-list"]').textContent || ''));
    const downloaded = await downloadPDF('snapshot-order');
    const pdf = inspectPDF(downloaded.pdfPath, { sourceScreenshots });
    assert.deepEqual(pdf.markerOrder, ['red', 'green', 'blue'], 'PDF must use frozen selected content in conversation order, regardless of click order.');
    assert.match(await ui('count').innerText(), /已选 3 条/);
    return { ...downloaded, pdf };
  });

  await check('rich-rendered-pdf-with-chinese-formula-code-table-image-and-canvas', async () => {
    await fresh('rich-pdf', { count: 1 });
    const sourceScreenshots = [];
    for (let index = 0; index < 2; index++) {
      const target = page.locator('[data-fixture-message]').nth(index);
      await target.evaluate(element => {
        const main = document.querySelector('main');
        main.scrollTop += element.getBoundingClientRect().top - 80;
      });
      const box = await target.boundingBox();
      const screenshotPath = path.join(output, `rich-source-${index}.png`);
      await page.screenshot({ path: screenshotPath, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(600, box.height) } });
      sourceScreenshots.push({ path: screenshotPath, width: box.width, height: box.height });
    }
    const richTarget = page.locator('[data-fixture-message]').nth(1);
    const tailOffset = 600;
    await richTarget.evaluate((element, offset) => {
      const main = document.querySelector('main');
      main.scrollTop += element.getBoundingClientRect().top + offset - 80;
      document.querySelector('form').style.visibility = 'hidden';
    }, tailOffset);
    const richBox = await richTarget.boundingBox();
    const tailPath = path.join(output, 'rich-source-tail.png');
    await page.screenshot({ path: tailPath, clip: { x: richBox.x, y: richBox.y + tailOffset, width: richBox.width, height: richBox.height - tailOffset } });
    sourceScreenshots.push({ path: tailPath, width: richBox.width, height: richBox.height, offset: tailOffset, top: sourceScreenshots[0].height + 24 });
    await page.locator('form').evaluate(element => { element.style.visibility = ''; });
    await page.locator('.code-title').evaluate(element => {
      element.style.position = 'sticky'; element.style.top = '0px';
      const main = document.querySelector('main');
      main.scrollTop += element.getBoundingClientRect().top - 20;
    });
    await openSelection(2);
    await rows().first().getByTestId('cspdf-group').click();
    await waitSelected(2);
    await page.locator('main').evaluate(node => { node.scrollTop = 120; });
    const scrollBefore = await page.locator('main').evaluate(node => node.scrollTop);
    const downloaded = await downloadPDF('rich-rendered');
    const pdf = inspectPDF(downloaded.pdfPath, { rich: true, sourceScreenshots });
    assert.ok(Math.abs(await page.locator('main').evaluate(node => node.scrollTop) - scrollBefore) < 3, 'Export must restore original reading position.');
    assert.equal(await page.locator('#cspdf-export-stage').count(), 0, 'Temporary export surface must be removed.');
    assert.equal(await page.locator(host).isVisible(), true);
    await page.screenshot({ path: path.join(output, 'rich-after-export.png') });
    return { ...downloaded, pdf, scrollBefore };
  });

  await check('long-answer-pdf-pages-and-dark-rendering', async () => {
    await fresh('long-dark', { layout: 'modern', count: 2, dark: true });
    await openSelection(4);
    await select([3]);
    const downloaded = await downloadPDF('long-dark');
    const pdf = inspectPDF(downloaded.pdfPath, { minPages: 3, rich: true });
    assert.ok(pdf.colors.dark > 2000, 'Dark page appearance must survive PDF export.');
    return { ...downloaded, pdf };
  });

  await check('large-rich-answer-shared-style-snapshot-selection', async () => {
    await fresh('large-rich-answer', { layout: 'modern', count: 1 });
    const source = await page.locator('[data-fixture-message]').nth(1).evaluate(element => {
      // ChatGPT's highlighted code and nested formula spans repeat the same
      // computed declarations thousands of times. The former inline-per-node
      // representation rejected such ordinary long answers at its 32M limit.
      const tokens = document.createElement('style');
      tokens.textContent = ':root{' + Array.from({ length: 80 }, (_, index) =>
        `--fixture-design-token-${index}:color-mix(in oklab, rgb(32 170 121) ${index}%, transparent);`
      ).join('') + '} .fixture-formula{display:block;text-align:center;margin:12px 0;font-family:Georgia,serif}' +
        '.fixture-formula .base{display:inline-block}.fixture-formula .sub{font-size:12px;vertical-align:sub}' +
        '.fixture-formula .sup{font-size:12px;vertical-align:super}';
      document.head.append(tokens);
      const classes = ['kw', 'fn', 'str', 'comment'];
      element.innerHTML = '<h2 data-rich-start>长回答回归：OpenCV PnP 位姿估计与三维坐标变换</h2>' +
        Array.from({ length: 70 }, (_, paragraph) =>
          `<p>段落 ${paragraph + 1}：内参、外参与三维点投影。 ` +
          Array.from({ length: 50 }, (_, token) =>
            `<span class="${classes[token % classes.length]}">${['cv::', 'solvePnP', '(rvec)', ' camera '][token % 4]}</span>`
          ).join('') + '</p>' +
          '<span class="fixture-formula"><span class="base">u = K[R|t]' +
          '<span class="base">X<span class="sub">w</span><span class="sup">T</span></span></span></span>'
        ).join('') + '<p class="accent" data-rich-end>长回答尾部：END-LARGE-PNP-ANSWER</p>';
      const nodes = [element, ...element.querySelectorAll('*')];
      let legacyRepeatedStyleCharacters = 0;
      for (const node of nodes) {
        const style = getComputedStyle(node);
        for (const property of style) if (!property.startsWith('--')) legacyRepeatedStyleCharacters += property.length + style.getPropertyValue(property).length + 2;
      }
      return { nodes: nodes.length, highlightedSpans: element.querySelectorAll('p > span').length,
        nestedFormulaSpans: element.querySelectorAll('.fixture-formula span').length,
        legacyRepeatedStyleCharacters, sourceHTMLCharacters: element.outerHTML.length };
    });
    assert.equal(source.highlightedSpans, 3500);
    assert.ok(source.nodes < 18_000, `Regression must stay below the independent node guard: ${source.nodes}.`);
    assert.ok(source.legacyRepeatedStyleCharacters > 32_000_000,
      `Fixture must reproduce the former repeated-style memory limit: ${JSON.stringify(source)}.`);
    await openSelection(2);
    await select([1]);
    const snapshot = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const state = globalThis.CSPDF.app.getState();
        const saved = state.selected[0]?.snapshot;
        if (!saved) return { selected: state.selected.length, status: state.status };
        const { node, ...serialized } = saved;
        return { selected: state.selected.length, bytes: new TextEncoder().encode(JSON.stringify(serialized)).length,
          frozenNodes: node.querySelectorAll('*').length + 1,
          first: node.querySelector('[data-rich-start]')?.textContent,
          last: node.querySelector('[data-rich-end]')?.textContent,
          status: state.status };
      } });
      return result.result;
    });
    assert.equal(snapshot.selected, 1, `Large rich answer must be selectable: ${JSON.stringify(snapshot)}.`);
    assert.equal(snapshot.frozenNodes, source.nodes, 'Large snapshots must retain all source nodes.');
    assert.match(snapshot.first, /OpenCV PnP/);
    assert.match(snapshot.last, /END-LARGE-PNP-ANSWER/);
    assert.ok(snapshot.bytes < 8_000_000, `Shared computed styles should keep the full frozen representation below 8MB: ${JSON.stringify(snapshot)}.`);
    assert.equal(await ui('select').nth(1).isChecked(), true);
    assert.doesNotMatch(await ui('count').innerText(), /失败 [1-9]/);
    assert.equal(await ui('export').isDisabled(), false);
    return { ...source, snapshot, nativeActivation: true };
  });

  await check('explicit-stop-cancels-export-and-retains-selection', async () => {
    await fresh('cancel-export', { count: 2 });
    await openSelection(4);
    await select([3]);
    let downloads = 0;
    page.on('download', () => downloads++);
    await ui('export').click();
    const stage = page.locator('#cspdf-export-stage');
    await stage.waitFor({ state: 'attached' });
    await stage.getByRole('button', { name: '停止 (Esc)', exact: true }).click();
    await stage.waitFor({ state: 'detached' });
    await ui('panel').waitFor({ state: 'visible' });
    assert.match(await ui('status').innerText(), /停止/);
    await waitSelected(1);
    assert.equal(downloads, 0, 'Cancelled export must not download a partial PDF.');
    assert.equal(await ui('export').isDisabled(), false, 'Selected content should remain available for retry.');
    return { partialDownloads: downloads, selectedForRetry: 1 };
  });

  await check('disjoint-windows-refuse-unproven-order-and-overlap-restores-it', async () => {
    await fresh('unproven-order', { count: 2 });
    await page.evaluate(() => {
      window.fixtureWindowNodes = [...document.querySelector('#turns').children];
      for (const article of window.fixtureWindowNodes) article.removeAttribute('data-testid');
      document.querySelector('#turns').replaceChildren(...window.fixtureWindowNodes.slice(2));
    });
    await openSelection(2);
    await select([0]);
    await page.evaluate(() => document.querySelector('#turns').replaceChildren(...window.fixtureWindowNodes.slice(0, 2)));
    await waitRows(3); // Two mounted messages, plus the cached later selection.
    await ui('select').locator('[data-id="user:message:fixture-u-1"]').count().catch(() => 0);
    await page.locator(`${host} [data-testid="cspdf-select"][data-id="user:message:fixture-u-1"]`).check();
    await waitSelected(2);
    await ui('order-note').waitFor({ state: 'visible' });
    assert.equal(await ui('export').isDisabled(), true);
    assert.match(await ui('order-note').innerText(), /先后顺序尚无法确认/);
    await page.evaluate(() => document.querySelector('#turns').replaceChildren(...window.fixtureWindowNodes));
    await waitRows(4);
    await ui('order-note').waitFor({ state: 'hidden' });
    assert.equal(await ui('export').isDisabled(), false);
    const selectedOrder = await ui('list').locator('.row.selected').evaluateAll(nodes => nodes.map(node => node.dataset.id));
    assert.deepEqual(selectedOrder, ['user:message:fixture-u-1', 'user:message:fixture-u-2']);
    await ui('selected-only').check();
    await waitRows(2);
    return { disjointExportBlocked: true, overlappingWindowRestoresExport: true, selectedOrder };
  });

  await check('ordinal-windows-restore-earlier-message-order-without-overlap', async () => {
    await fresh('ordinal-order', { count: 2 });
    await page.evaluate(() => {
      window.fixtureWindowNodes = [...document.querySelector('#turns').children];
      document.querySelector('#turns').replaceChildren(...window.fixtureWindowNodes.slice(2));
    });
    await openSelection(2);
    await select([0]);
    await page.evaluate(() => document.querySelector('#turns').replaceChildren(...window.fixtureWindowNodes.slice(0, 2)));
    await waitRows(3);
    await page.locator(`${host} [data-testid="cspdf-select"][data-id="user:message:fixture-u-1"]`).check();
    await waitSelected(2);
    assert.equal(await ui('order-note').isVisible(), false);
    assert.equal(await ui('export').isDisabled(), false);
    const selectedOrder = await ui('list').locator('.row.selected').evaluateAll(nodes => nodes.map(node => node.dataset.id));
    assert.deepEqual(selectedOrder, ['user:message:fixture-u-1', 'user:message:fixture-u-2']);
    return { absoluteOrdinalEvidence: 'conversation-turn-N', selectedOrder };
  });

  await check('source-mutation-during-freeze-is-explicit-failure', async () => {
    await fresh('freeze-mutation', { count: 1 });
    await openSelection(2);
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => {
        const original = globalThis.CSPDF.freeze;
        // Hold the asynchronous freeze open, then mutate its source. This
        // exercises the race deterministically rather than hoping an interval
        // fires between a fast freeze's animation frame and its microtask.
        globalThis.CSPDF.freeze = async element => {
          globalThis.CSPDF.freeze = original;
          await new Promise(resolve => setTimeout(() => {
            element.querySelector('p').textContent = '保存期间发生变化的源消息'; resolve();
          }, 70));
          return original(element);
        };
      }});
    });
    // One real click: check() may retry after the expected failure clears the
    // checkbox, accidentally performing a second, now-stable selection.
    await ui('select').first().click();
    await page.waitForFunction(() => /保存期间原文或外观发生变化/.test(document.querySelector('#cspdf-panel-host')?.shadowRoot?.querySelector('[data-testid="cspdf-status"]').textContent || ''));
    await waitSelected(0);
    assert.match(await ui('count').innerText(), /失败 1 条/);
    assert.equal(await ui('export').isDisabled(), true);
    return { frozenSelections: 0, visibleFailures: 1 };
  });

  await check('translucent-background-and-rounded-corners-match-original', async () => {
    await fresh('alpha', {count: 1});
    await page.locator('[data-fixture-message]').first().evaluate(element => {
      element.style.cssText = 'background:rgba(0,0,0,.5);border-radius:20px;padding:24px;color:white;';
      element.innerHTML = '<p>半透明背景与圆角应和原网页一致。</p>';
    });
    const target = page.locator('[data-fixture-message]').first(), box = await target.boundingBox();
    const screenshotPath = path.join(output, 'alpha-source.png');
    await target.screenshot({path: screenshotPath});
    await openSelection(2); await select([0]);
    const downloaded = await downloadPDF('alpha');
    const pdf = inspectPDF(downloaded.pdfPath, {sourceScreenshots: [{path: screenshotPath, width: box.width, height: box.height}]});
    return {...downloaded, pdf};
  });

  await check('spa-route-clears-old-selection-and-rebinds-new-chat', async () => {
    await fresh('spa', { count: 2 });
    await openSelection(4);
    await select([0]);
    await page.evaluate(() => window.fixture.route('/c/second-fixture-chat', 1, 'modern', 1200));
    await page.waitForFunction(() => /已选 0 条/.test(document.querySelector('#cspdf-panel-host')?.shadowRoot?.querySelector('[data-testid="cspdf-count"]').textContent || ''), null, { timeout: 4000 });
    await waitRows(2);
    assert.match(await ui('count').innerText(), /已选 0 条/);
    assert.equal(await ui('export').isDisabled(), true);
    await rows().first().getByTestId('cspdf-group').click();
    await waitSelected(2);
    return { previousConversationSelections: 0, newMessages: 2 };
  });

  await check('collapsed-responsive-panel-and-legacy-domain', async () => {
    await fresh('legacy-domain', { domain: 'chat.openai.com', count: 1 });
    await openSelection(2);
    await ui('collapse').click();
    await ui('open').waitFor({ state: 'visible' });
    await activateAction();
    await ui('panel').waitFor({ state: 'visible' });
    for (const [width, height] of [[390, 844], [720, 540]]) {
      await page.setViewportSize({ width, height });
      const box = await ui('panel').boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
      await page.screenshot({ path: path.join(output, `panel-${width}x${height}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    return { sizes: ['390x844', '720x540'] };
  });

  await check('no-network-exfiltration-or-persisted-conversation-data', async () => {
    assert.deepEqual(requests, [], 'Extension test attempted unexpected external requests.');
    assert.deepEqual(pageErrors, [], 'Page JavaScript errors occurred.');
    const state = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: (await indexedDB.databases()).length }));
    assert.deepEqual(state, { local: 0, session: 0, databases: 0 });
    return { externalRequests: requests.length, browserStorage: state };
  });
} catch (error) {
  results.push({ name: 'browser-harness', passed: false, error: error.stack || String(error) });
  console.error(error.message);
} finally {
  const browserVersion = context?.browser()?.version() || null;
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  const report = {
    started, finished: new Date().toISOString(), browserVersion, playwrightVersion,
    mode: 'Actual unpacked Manifest V3 extension in an isolated temporary browser profile; synthetic locally routed ChatGPT documents. Native toolbar action and real captureVisibleTab, no mocked screenshot API and no test-only host permission.',
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length,
    results, requests, pageErrors,
    remainingManualChecks: ['Current signed-in ChatGPT DOM and site-specific controls.', 'Manual unpacked install and native toolbar click in the user browser.', 'Real history virtualization, branches and attachments outside currently rendered messages.'],
  };
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(output, 'browser-results.md'), [
    '# 浏览器集成测试', '', `浏览器：${browserVersion || '启动失败'}`, `Playwright：${playwrightVersion}`, '', report.mode, '',
    `通过：${report.passed}；失败：${report.failed}。`, '', '| 测试 | 结果 | 耗时 |', '| --- | --- | --- |',
    ...results.map(result => `| ${result.name} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.durationMs ?? '-'} ms |`), '',
    '## 仍需人工验证', '', ...report.remainingManualChecks.map(item => `- ${item}`), '',
  ].join('\n'));
  console.log(`${report.passed} passed, ${report.failed} failed. Report: ${path.join(output, 'browser-results.json')}`);
  process.exitCode = report.failed ? 1 : 0;
}
