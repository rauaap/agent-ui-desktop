/** Optional Chromium regression test. Requires puppeteer-core (or puppeteer).
 * PUPPETEER_MODULE=/path/to/puppeteer-core/lib/puppeteer/puppeteer-core.js
 * CHROME_EXECUTABLE=/path/to/chrome node test/scroll-browser-tests.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const moduleName = process.env.PUPPETEER_MODULE;
const { default: puppeteer } = await import(moduleName ? pathToFileURL(moduleName).href : 'puppeteer');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/app.css"><main id="panes" style="height:700px;width:900px;position:relative"></main><div id="empty"></div>');
    return;
  }
  try {
    const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep)) throw Error('Invalid path');
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(await readFile(filename));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const settle = () => new Promise(resolve => setTimeout(resolve, 500));
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, hasTouch: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    localStorage.setItem('agentUi.serverToken', 'test-only');
    window.WebSocket = class extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      close() { this.readyState = 3; }
      send() {}
    };
    const { Store } = await import('/js/store.js');
    const { Workspace } = await import('/js/workspace.js');
    window.store = new Store();
    window.workspace = new Workspace({ panes: document.querySelector('#panes'), empty: document.querySelector('#empty') }, store,
      { onError: message => { throw Error(message); } }, { subscribe: () => () => {}, lookup: () => ({ state: 'pending' }) });
    workspace.openSession('1');
    window.pane = workspace.pane;
    window.view = pane.transcript;
    window.snapshot = () => ({ top: view.list.scrollTop, bottom: view.isAtBottom(), follow: view.followBottom });
    store.setConnected('1', true);
    store.setMeta('1', { sessionReady: true });
    for (let i = 0; i < 80; i++) {
      store.apply('1', { type: 'input', text: `Message ${i}` });
      store.apply('1', { type: 'output', text: 'Reply '.repeat(100) });
      if (i === 20) store.setMeta('1', { name: 'Session title arriving during replay', workingDir: '/home/user/project' });
      if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).bottom, true, 'queue-free replay follows after header resize');

  for (const width of [900, 620, 480, 400]) {
    await page.evaluate(width => {
      document.querySelector('#panes').style.width = `${width}px`;
      pane.input.value = 'hello';
      pane.input.dispatchEvent(new Event('input'));
    }, width);
    await settle();
    await page.evaluate(width => {
      pane.socket.sendInput = () => true;
      pane.send();
      store.apply('1', { type: 'input', text: 'hello', delivery: 'queued', message_id: width });
      store.apply('1', { type: 'inputs_shipped', messages: [{ message_id: width, text: 'hello' }] });
      store.apply('1', { type: 'status', status: 'running' });
      store.apply('1', { type: 'output', text: 'New output '.repeat(50) });
      store.apply('1', { type: 'status', status: 'idle' });
    }, width);
    await settle();
    assert.deepEqual(await page.evaluate(() => ({ bottom: view.isAtBottom(), follow: view.followBottom })), { bottom: true, follow: true }, `single-line send at width ${width}`);
  }
  await page.evaluate(() => { document.querySelector('#panes').style.width = '900px'; });
  await settle();
  const bounds = await page.$eval('.transcript', list => {
    const r = list.getBoundingClientRect(); return { x: r.left + 100, y: r.top + 100, right: r.right, top: r.top };
  });
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.wheel({ deltaY: -300 });
  await settle();
  const reading = await page.evaluate(() => snapshot());
  assert.equal(reading.follow, false, 'native wheel detaches following');
  await page.evaluate(() => {
    store.apply('1', { type: 'output', text: 'More streamed content '.repeat(50) });
    store.apply('1', { type: 'input', delivery: 'queued', message_id: 9999, text: 'Pending message' });
    store.apply('1', { type: 'inputs_shipped', messages: [{ message_id: 9999, text: 'Pending message' }] });
  });
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).top, reading.top, 'content and queue resizing preserve reader offset');
  await page.click('.scroll-down');
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).follow, true, 'jump button resumes following');

  await page.focus('.transcript');
  await page.keyboard.press('PageUp');
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).follow, false, 'native keyboard scrolling detaches');
  await page.keyboard.press('End');
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).follow, true, 'keyboard reaching bottom resumes following');

  // Mouse click/drag in the native scrollbar track, rather than wheel input.
  await page.mouse.move(bounds.right - 5, bounds.top + 80);
  await page.mouse.down();
  await page.mouse.move(bounds.right - 5, bounds.top + 60, { steps: 4 });
  await page.mouse.up();
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).follow, false, 'native scrollbar interaction detaches');
  await page.click('.scroll-down');
  await settle();

  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x, y: bounds.y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x, y: bounds.y + i * 20 }] });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await page.evaluate(() => snapshot())).follow, false, 'native touch scrolling detaches');
  await page.click('.scroll-down');
  await settle();
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.wheel({ deltaY: -200 });
  await settle();
  await page.mouse.wheel({ deltaY: 100000 });
  await settle();
  assert.equal((await page.evaluate(() => snapshot())).follow, true, 'wheel reaching bottom resumes following');

  await page.evaluate(() => workspace.openSession('2'));
  await settle();
  assert.equal((await page.evaluate(() => pane.transcript.scrolling.listeners.length)), 0, 'switching sessions removes old input listeners');
  // Session/page exits share draft and scroll saving. Restore only once the
  // initial replay is complete, and retain the old save if exited mid-replay.
  await page.evaluate(() => {
    window.openTestSession = id => {
      workspace.openSession(id);
      window.pane = workspace.pane;
      window.view = pane.transcript;
    };
    window.replay = (id, start = 0, end = 60, finish = true) => {
      if (start === 0) {
        store.setConnected(id, true);
        store.setMeta(id, { name: 'Saved reading position', workingDir: '/home/user/project' });
      }
      for (let i = start; i < end; i++) {
        store.apply(id, { type: 'input', text: `Message ${i}` });
        store.apply(id, { type: 'output', text: 'Reply '.repeat(100) });
      }
      if (finish) store.setMeta(id, { sessionReady: true });
    };
    openTestSession('7');
    replay('7');
  });
  await settle();
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.wheel({ deltaY: -350 });
  await settle();
  const savedReading = await page.evaluate(() => {
    pane.input.value = 'unfinished draft';
    return snapshot();
  });
  assert.equal(savedReading.follow, false);
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-ui.session-scroll.7')), null, 'scrolling does not write storage');
  await page.evaluate(() => openTestSession('8'));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('agent-ui.session-scroll.7')));
  assert.deepEqual(saved, { scrollTop: savedReading.top, followBottom: false }, 'session exit saves reading position');
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-ui.session-draft.7')), 'unfinished draft');
  await page.evaluate(() => { openTestSession('7'); replay('7', 0, 5, false); });
  assert.equal(await page.evaluate(() => pane.pendingScrollPosition.scrollTop), savedReading.top, 'wait for complete replay');
  await page.evaluate(() => openTestSession('8'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('agent-ui.session-scroll.7'))), saved, 'early exit does not overwrite saved position');
  await page.evaluate(() => { openTestSession('7'); replay('7'); });
  await settle();
  assert.deepEqual(await page.evaluate(() => snapshot()), savedReading, 'returning restores reader offset and intent');
  assert.equal(await page.evaluate(() => pane.input.value), 'unfinished draft', 'composer restore still works');

  await page.evaluate(() => { pane.input.value = 'page exit draft'; window.dispatchEvent(new Event('beforeunload')); });
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-ui.session-draft.7')), 'page exit draft');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('agent-ui.session-scroll.7'))), saved, 'same beforeunload event saves position');
  await page.evaluate(() => { pane.input.value = 'actual reload draft'; });
  await page.reload(); // Also exercises the real beforeunload event.
  await page.evaluate(async () => {
    window.WebSocket = class extends EventTarget { static OPEN = 1; readyState = 1; close() {} send() {} };
    const { Store } = await import('/js/store.js');
    const { Workspace } = await import('/js/workspace.js');
    window.store = new Store();
    window.workspace = new Workspace({ panes: document.querySelector('#panes'), empty: document.querySelector('#empty') }, store,
      { onError: message => { throw Error(message); } }, { subscribe: () => () => {}, lookup: () => ({ state: 'pending' }) });
    workspace.openSession('7');
    window.pane = workspace.pane;
    window.view = pane.transcript;
    store.setConnected('7', true);
    store.setMeta('7', { name: 'Saved reading position', workingDir: '/home/user/project' });
    for (let i = 0; i < 60; i++) {
      store.apply('7', { type: 'input', text: `Message ${i}` });
      store.apply('7', { type: 'output', text: 'Reply '.repeat(100) });
    }
    store.setMeta('7', { sessionReady: true });
  });
  await settle();
  assert.deepEqual(await page.evaluate(() => ({ top: view.list.scrollTop, follow: view.followBottom })), { top: savedReading.top, follow: false }, 'page reload restores after replay');
  assert.equal(await page.evaluate(() => pane.input.value), 'actual reload draft');

  // Saving at the bottom follows the NEW bottom, not yesterday's pixel offset.
  await page.click('.scroll-down');
  await settle();
  await page.evaluate(() => {
    workspace.openSession('8');
    workspace.openSession('7');
    window.pane = workspace.pane;
    window.view = pane.transcript;
    store.setConnected('7', true);
    for (let i = 0; i < 80; i++) {
      store.apply('7', { type: 'input', text: `Message ${i}` });
      store.apply('7', { type: 'output', text: 'Reply '.repeat(100) });
    }
    store.setMeta('7', { sessionReady: true });
  });
  await settle();
  assert.equal(await page.evaluate(() => view.isAtBottom()), true, 'saved following resumes at latest content');
  await page.evaluate(() => {
    workspace.openSession('8');
    workspace.openSession('7');
    window.pane = workspace.pane;
    window.view = pane.transcript;
    store.setConnected('7', true);
    for (let i = 0; i < 5; i++) {
      store.apply('7', { type: 'input', text: `Message ${i}` });
      store.apply('7', { type: 'output', text: 'Reply '.repeat(100) });
    }
  });
  await settle();
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.wheel({ deltaY: -150 });
  await settle();
  const duringReplay = await page.evaluate(() => ({ top: view.list.scrollTop, pending: pane.pendingScrollPosition }));
  assert.equal(duringReplay.pending, null, 'navigation cancels pending restoration');
  await page.evaluate(() => {
    for (let i = 5; i < 80; i++) {
      store.apply('7', { type: 'input', text: `Message ${i}` });
      store.apply('7', { type: 'output', text: 'Reply '.repeat(100) });
    }
    store.setMeta('7', { sessionReady: true });
  });
  await settle();
  assert.equal(await page.evaluate(() => view.list.scrollTop), duringReplay.top, 'replay completion does not override user navigation');
  console.log('Scroll browser regressions passed');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
