// Renders a page of this server to PDF with headless Chromium, driven over the DevTools protocol.
// The page is opened with a short-lived session cookie for the user who asked, so it sees what they see.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
const chromePath = () => CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

let running = 0; const MAX = 2; const waiters = [];
const slot = () => running < MAX ? (running++, Promise.resolve()) : new Promise(r => waiters.push(r));
const release = () => { const w = waiters.shift(); if (w) w(); else running--; };

async function renderPDF({ url, cookie, readyExpr = 'window.RFQ_READY === true', timeoutMs = 30000 }) {
  const exe = chromePath();
  if (!exe) throw new Error('PDF rendering needs Chromium in the container (set CHROMIUM_PATH)');
  await slot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-pdf-'));
  const ch = spawn(exe, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { ch.kill('SIGKILL'); } catch {} setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 500); };
  const deadline = Date.now() + timeoutMs;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const wsUrl = await new Promise((ok, bad) => {
      let err = '';
      const t = setTimeout(() => bad(new Error('Chromium did not start: ' + err.slice(-300))), 15000);
      ch.stderr.on('data', d => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]); } });
      ch.on('exit', c => { clearTimeout(t); bad(new Error('Chromium exited (' + c + '): ' + err.slice(-300))); });
      ch.on('error', e => { clearTimeout(t); bad(e); });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('DevTools connection failed')); });
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); } };
    const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
      const i = ++id; pend.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => send(m, p, sessionId);
    await S('Network.enable');
    if (cookie) await S('Network.setCookie', { url, ...cookie, httpOnly: true });
    await S('Page.enable');
    await S('Emulation.setEmulatedMedia', { media: 'print' }); // lay out (and fit text) exactly as it will print
    await S('Page.navigate', { url });
    for (;;) {
      if (Date.now() > deadline) throw new Error('Timed out building the PDF');
      const r = await S('Runtime.evaluate', { expression: readyExpr, returnByValue: true });
      if (r.result && r.result.value === true) break;
      const e = await S('Runtime.evaluate', { expression: 'window.RFQ_ERROR||""', returnByValue: true });
      if (e.result && e.result.value) throw new Error(e.result.value);
      await sleep(200);
    }
    const pdf = await S('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    ws.close();
    return Buffer.from(pdf.data, 'base64');
  } finally { kill(); release(); }
}

module.exports = { renderPDF, chromePath };
