// Burner Selection Matrix server: public page + login-protected admin.
// No dependencies; Node 20+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Schema = require('./html/schema.js');
const Mail = require('./lib/mail.js');
const { renderPDF } = require('./lib/pdf.js');
const XLSX = require('./lib/xlsx.js');
const Push = require('./lib/push.js');
const Specs = require('./lib/specs.js');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || '/data';
const HTML = path.join(__dirname, 'html');
const COOKIE_SECURE = /^true$/i.test(process.env.COOKIE_SECURE || '');
const TRUST_PROXY = /^true$/i.test(process.env.TRUST_PROXY || '');
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;
const REMEMBER_DAYS = +process.env.REMEMBER_DAYS || 30; // "Keep me signed in"
const HISTORY_KEEP = 200;
const RFQ_TO_ENV = process.env.RFQ_TO || '';   // fallback default "send to" address(es) for RFQ PDFs
// Admin settings (Admin → Settings) override the container variables
const getSettings = () => readJSON(F.settings, {});
const rfqTo = () => { const s = getSettings(); return typeof s.rfqTo === 'string' && s.rfqTo.trim() ? s.rfqTo : RFQ_TO_ENV; };
const followUpDays = () => { const d = getSettings().followUpDays; return Number.isInteger(d) && d >= 0 && d <= 90 ? d : 7; }; // 0 = off
const stepDownWarn = () => getSettings().stepDownWarn !== false; // default on
const LOST_REASONS = ['Price', 'Lead time', 'Went with a competitor', 'Job cancelled / on hold', 'Technical fit', 'No response', 'Other'];

const F = {
  burners: path.join(DATA, 'burners.json'),
  users: path.join(DATA, 'users.json'),
  secret: path.join(DATA, '.secret'),
  history: path.join(DATA, 'history'),
  photos: path.join(DATA, 'photos'),
  rfqs: path.join(DATA, 'rfqs'),
  settings: path.join(DATA, 'settings.json'),
  customers: path.join(DATA, 'customers.json'),
  xref: path.join(DATA, 'xref.json'),
  xmiss: path.join(DATA, 'xref-misses.json'),
  quotes: path.join(DATA, 'quotes'),
  vapid: path.join(DATA, '.vapid.json'),
  push: path.join(DATA, 'push.json'),
  specs: path.join(DATA, 'specs'),
  smiss: path.join(DATA, 'specs-misses.json'),
  qtpl: path.join(DATA, 'quote-templates.json'),
  activity: path.join(DATA, 'activity.jsonl'),
};

// ---------- storage ----------
fs.mkdirSync(F.history, { recursive: true });
fs.mkdirSync(F.quotes, { recursive: true });
fs.mkdirSync(F.photos, { recursive: true });
fs.mkdirSync(F.rfqs, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v, pretty) => {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, pretty ? '[\n' + v.map(o => '  ' + JSON.stringify(o)).join(',\n') + '\n]\n' : JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
  if (path.dirname(f) === F.rfqs && typeof RFQ_CACHE !== 'undefined') RFQ_CACHE.delete(path.basename(f)); // never serve an older copy
};
if (!fs.existsSync(F.burners)) fs.copyFileSync(path.join(HTML, 'burners.json'), F.burners);
if (!fs.existsSync(F.secret)) fs.writeFileSync(F.secret, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(F.secret, 'utf8').trim();
// ---------- phone notifications (web push) ----------
const VAPID = Push.loadKeys(F.vapid);
const pushContact = () => process.env.PUSH_CONTACT || (Mail.isEmail(Mail.config().from) ? 'mailto:' + Mail.config().from : 'mailto:burner-matrix@example.com');
const getSubs = () => { const l = readJSON(F.push, []); return Array.isArray(l) ? l.filter(s => s && s.user && s.endpoint && s.keys) : []; };
// tell these users on every device they turned notifications on; never blocks the request that caused it
function notify(names, data) {
  const want = new Set(names.filter(Boolean)), subs = getSubs().filter(s => want.has(s.user));
  if (!subs.length) return;
  Promise.all(subs.map(s => Push.send(VAPID, pushContact(), s, data).then(r => { if (!r.ok) console.warn(`Push to ${s.user} failed: HTTP ${r.status}`); return r.gone ? s.endpoint : null; },
    e => { console.warn(`Push to ${s.user} failed: ${e.message}`); return null; })))
    .then(gone => { const g = new Set(gone.filter(Boolean)); if (g.size) writeJSON(F.push, getSubs().filter(s => !g.has(s.endpoint))); });
}
const SPECS = Specs.store(F.specs); // appliance spec guides, any number per burner brand
// ---------- activity log: who changed what (one JSON line per change; trimmed to the newest 5,000) ----------
function logAct(who, text) {
  try {
    fs.appendFileSync(F.activity, JSON.stringify({ at: new Date().toISOString(), by: who, t: String(text).slice(0, 300) }) + '\n');
    if (fs.statSync(F.activity).size > 1.5e6) { const l = fs.readFileSync(F.activity, 'utf8').trim().split('\n').slice(-5000); fs.writeFileSync(F.activity + '.tmp', l.join('\n') + '\n'); fs.renameSync(F.activity + '.tmp', F.activity); }
  } catch (e) { console.warn('Activity log:', e.message); }
}
const readAct = () => { try { return fs.readFileSync(F.activity, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const getTpl = () => { const l = readJSON(F.qtpl, []); return Array.isArray(l) ? l : []; };
const getSMiss = () => { const m = readJSON(F.smiss, {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; };
const quoters = () => users.filter(u => u.role === 'quoter').map(u => u.name);

// ---------- users ----------
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
let users = readJSON(F.users, []);
const saveUsers = () => writeJSON(F.users, users);
if (!users.length) {
  const u = (process.env.ADMIN_USER || '').trim().toLowerCase();
  const p = process.env.ADMIN_PASSWORD || '';
  if (u && p.length >= 8) {
    users.push({ name: u, role: 'admin', hash: hashPw(p), created: new Date().toISOString() });
    saveUsers();
    console.log(`Created admin user "${u}".`);
  } else {
    console.warn('No users yet. Set ADMIN_USER and ADMIN_PASSWORD (8+ characters) and restart to create the first admin.');
  }
}
const validName = n => /^[a-z0-9._-]{2,32}$/.test(n) || (n.length <= 100 && Mail.isEmail(n));

// ---------- sessions (signed cookie) ----------
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = (name, ver, ms = SESSION_HOURS * 3600e3) => {
  const body = Buffer.from(JSON.stringify({ n: name, v: ver, e: Date.now() + ms })).toString('base64url');
  return body + '.' + sign(body);
};
const readSession = req => {
  const m = /(?:^|;\s*)bm_s=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p || p.e < Date.now()) return null;
  const u = users.find(x => x.name === p.n);
  if (!u || (u.ver || 0) !== p.v) return null; // password change / removal logs out
  return u;
};
const cookie = (val, maxAge) =>
  `bm_s=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;

// ---------- login rate limit ----------
const attempts = new Map();
const clientIp = req => (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const limited = ip => {
  const a = attempts.get(ip); const now = Date.now();
  if (!a || now - a.t > 15 * 60e3) return false;
  return a.n >= 8;
};
setInterval(() => { const now = Date.now(); for (const [ip, a] of attempts) if (now - a.t > 15 * 60e3) attempts.delete(ip); }, 10 * 60e3).unref();
const failed = ip => { const a = attempts.get(ip); const now = Date.now();
  if (!a || now - a.t > 15 * 60e3) attempts.set(ip, { n: 1, t: now }); else a.n++; };

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
// HTML pages get versioned script/style links so browsers never use a stale copy after an update.
const VERSIONED = ['schema.js', 'favicon.svg'];
const ver = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(HTML, f))).digest('hex').slice(0, 10); } catch { return '0'; } };
const VER = Object.fromEntries(VERSIONED.map(f => [f, ver(f)]));
// app version = hash of the page files; a new version makes installed apps refresh their offline copy
const APP_VER = crypto.createHash('sha1').update(['index.html', 'login.html', 'schema.js', 'sw.js', 'manifest.webmanifest']
  .map(f => { try { return fs.readFileSync(path.join(HTML, f)); } catch { return ''; } }).join('|')).digest('hex').slice(0, 12);
const SW_JS = (() => { try { return fs.readFileSync(path.join(HTML, 'sw.js'), 'utf8').replace('__VERSION__', APP_VER); } catch { return ''; } })();
const sendPage = (res, file) => fs.readFile(file, 'utf8', (err, html) => {
  if (err) return send(res, 404, 'Not found', 'text/plain');
  for (const f of VERSIONED) html = html.split(`="${f}"`).join(`="${f}?v=${VER[f]}"`);
  send(res, 200, html, 'text/html; charset=utf-8');
});
const sendFile = (res, file, cache) => {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache || 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
};
const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((ok, bad) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > limit) { bad(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { const v = n ? JSON.parse(Buffer.concat(chunks).toString()) : {}; ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { bad(Object.assign(new Error('Bad JSON'), { code: 400 })); } });
  req.on('error', bad);
});
const ROLES = ['rep', 'quoter', 'editor', 'admin'];
const canEditData = u => u.role === 'editor' || u.role === 'admin'; // burners, cross-reference, history
const canQuote = u => u.role === 'quoter' || u.role === 'admin';     // attach quotes to RFQs
const normRole = r => ROLES.includes(r) ? r : 'rep';
const clip = v => String(v ?? '').trim().slice(0, 100);
const contact = (u, b) => { for (const k of ['full', 'phone', 'email']) if (b[k] !== undefined) u[k] = clip(b[k]); };
const pub = u => ({ name: u.name, role: u.role, full: u.full || '', phone: u.phone || '', email: u.email || '', created: u.created });
const keyOf = b => (b.brand + '|' + b.name).toLowerCase();

// ---------- burners + history ----------
const getBurners = () => readJSON(F.burners, []);
const saveBurners = (list, who, action) => {
  const errs = Schema.checkAll(list);
  if (errs.length) return errs;
  const stamp = new Date().toISOString();
  const prev = fs.readFileSync(F.burners);
  fs.writeFileSync(path.join(F.history, stamp.replace(/[:.]/g, '-') + '.json'),
    JSON.stringify({ at: stamp, by: who, action, burners: JSON.parse(prev) }));
  writeJSON(F.burners, list, true);
  const hs = fs.readdirSync(F.history).filter(f => f.endsWith('.json')).sort();
  hs.slice(0, Math.max(0, hs.length - HISTORY_KEEP)).forEach(f => fs.unlinkSync(path.join(F.history, f)));
  return null;
};

// ---------- photos: keep a local copy of any web-hosted burner photo ----------
const IMG_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const sniff = buf => buf[0] === 0xff && buf[1] === 0xd8 ? '.jpg' : buf.slice(1, 4).toString() === 'PNG' ? '.png'
  : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' ? '.webp' : null;
async function fetchImage(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8', Referer: new URL(url).origin + '/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) throw new Error('too large');
    const ext = sniff(buf) || IMG_TYPES[(r.headers.get('content-type') || '').split(';')[0]];
    if (!ext || !sniff(buf)) throw new Error('not an image');
    return { buf, ext };
  } finally { clearTimeout(t); }
}
let localizing = null;
function localizePhotos(who = 'server') {
  if (localizing) return localizing;
  localizing = (async () => {
    const list = getBurners(), done = new Map(), failed = [];
    let stored = 0;
    for (const b of list) {
      if (!/^https?:\/\//i.test(b.image || '')) continue;
      const url = b.image;
      if (!done.has(url)) {
        try {
          const { buf, ext } = await fetchImage(url);
          const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'photo').replace(/\.[a-z0-9]+$/i, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'photo';
          const brand = String(b.brand).toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const file = `${brand}-${base}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 6)}${ext}`;
          fs.writeFileSync(path.join(F.photos, file), buf);
          done.set(url, 'photos/' + file);
        } catch (e) { done.set(url, null); console.warn(`Photo for ${b.brand} ${b.name} not stored (${e.message}): ${url}`); }
      }
      if (done.get(url)) { b.image = done.get(url); stored++; } else failed.push(`${b.brand} ${b.name}`);
    }
    if (stored) {
      const cur = getBurners(); // apply to the current list in case it changed while downloading
      for (const c of cur) { const n = list.find(x => keyOf(x) === keyOf(c)); if (n && c.image && done.get(c.image)) c.image = done.get(c.image); }
      const errs = saveBurners(cur, who, `Stored ${stored} web photo${stored === 1 ? '' : 's'} on the server`);
      if (errs) { console.warn('Photos downloaded but the burner list could not be saved:', errs.join('; ')); return { stored: 0, failed: list.map(b => `${b.brand} ${b.name}`) }; }
      console.log(`Stored ${stored} web photos locally.`);
    }
    return { stored, failed };
  })().finally(() => { localizing = null; });
  return localizing;
}

// ---------- nightly backup (1:00 a.m. server time) ----------
const BACKUP_DIR = path.join(DATA, 'backups'), BACKUP_KEEP = 14;
const listBackups = () => { try { return fs.readdirSync(BACKUP_DIR).filter(n => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(n)).sort().reverse(); } catch { return []; } };
function runBackup(why) {
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const dest = path.join(BACKUP_DIR, name), tmp = dest + '.partial';
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const e of fs.readdirSync(DATA)) { // everything except the backups folder itself (and half-written .tmp files)
    if (e === 'backups' || e.endsWith('.tmp')) continue;
    if (e === 'photos' || e === 'quotes') { // these files are never changed in place, so hard-link them instead of copying 14 times
      fs.mkdirSync(path.join(tmp, e), { recursive: true });
      for (const f of fs.readdirSync(path.join(DATA, e))) {
        const src = path.join(DATA, e, f), dst = path.join(tmp, e, f);
        if (f.endsWith('.tmp') || !fs.statSync(src).isFile()) continue;
        try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
      }
      continue;
    }
    fs.cpSync(path.join(DATA, e), path.join(tmp, e), { recursive: true, filter: src => !src.endsWith('.tmp') });
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  for (const old of listBackups().slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  const s = getSettings(); s.lastBackup = { at: d.toISOString(), name, why }; writeJSON(F.settings, s);
  console.log(`Backup saved: backups/${name} (${why})`);
  return s.lastBackup;
}
function scheduleBackup() {
  const now = new Date(), next = new Date(now); next.setHours(1, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  console.log(`Next backup: ${next.toString()}`);
  setTimeout(() => { try { runBackup('nightly'); } catch (e) { console.error('Nightly backup failed:', e.message); } scheduleBackup(); }, next - now);
}

// ---------- RFQs ----------
const rfqFile = id => path.join(F.rfqs, id + '.json');
// After any await (reading an upload, building a PDF, sending mail) re-read the RFQ before changing it, so a change
// someone else saved in the meantime (a comment, a status, a quote) isn't overwritten by our older copy.
const reloadRfq = r => { const cur = readJSON(rfqFile(r.id), null); if (!cur) throw Object.assign(new Error('RFQ not found'), { code: 404 });
  for (const k of Object.keys(r)) delete r[k]; return Object.assign(r, cur); };
const getRfq = id => /^[a-f0-9]{12}$/.test(id) ? readJSON(rfqFile(id), null) : null;
// Parsed RFQs are kept in memory and only re-read when a file's size or time changes (or it's new), so lists,
// Jobs and Customers stay fast with thousands of RFQs even on slow array disks. Treat the results as read-only:
// anything that changes an RFQ reads its own fresh copy with getRfq().
var RFQ_CACHE = new Map(); // file name -> { m: mtimeMs, s: size, i: inode, r: record }
const allRfqs = () => {
  const names = fs.readdirSync(F.rfqs).filter(f => f.endsWith('.json')), live = new Set(names), out = [];
  for (const f of names) {
    let st; try { st = fs.statSync(path.join(F.rfqs, f)); } catch { continue; }
    let c = RFQ_CACHE.get(f);
    if (!c || c.m !== st.mtimeMs || c.s !== st.size || c.i !== st.ino) { c = { m: st.mtimeMs, s: st.size, i: st.ino, r: readJSON(path.join(F.rfqs, f), null) }; RFQ_CACHE.set(f, c); }
    if (c.r && c.r.burner && c.r.fields) out.push(c.r);
  }
  for (const f of RFQ_CACHE.keys()) if (!live.has(f)) RFQ_CACHE.delete(f);
  return out;
};
// cross-reference: another maker's (or an old) burner model -> the Beckett/Wayne burner(s) to replace it with
const getXref = () => { const l = readJSON(F.xref, []); return Array.isArray(l) ? l.filter(x => x && x.id && x.brand && x.model && Array.isArray(x.to)) : []; };
const cleanXref = b => {
  const str = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const brand = str(b.brand, 60), model = str(b.model, 80), note = str(b.note, 400);
  if (!brand) return { error: 'Enter the brand of the burner being replaced.' };
  if (!model) return { error: 'Enter the model being replaced.' };
  const keys = new Set(getBurners().map(keyOf));
  const to = [...new Set((Array.isArray(b.to) ? b.to : []).map(k => String(k).toLowerCase()))].slice(0, 6);
  const none = b.none === true; // "we don't currently make anything that replaces this"
  if (none) return { brand, model, note, to: [], none: true };
  if (!to.length) return { error: 'Pick at least one replacement burner, or tick “No current replacement”.' };
  if (to.some(k => !keys.has(k))) return { error: 'One of the replacement burners isn’t in the burner list any more.' };
  return { brand, model, note, to, none: false };
};
// searches reps made in "Replacing a burner?" that found nothing, so editors know what to add next
const xnorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const xrefMatches = (q, list) => { const toks = String(q).toLowerCase().split(/\s+/).map(xnorm).filter(Boolean), all = xnorm(q);
  return toks.length > 0 && list.some(x => { const hay = xnorm(x.brand + ' ' + x.model); return toks.every(t => hay.includes(t)) || hay.includes(all); }); };
const getMisses = () => { const m = readJSON(F.xmiss, {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; };
const xrefKey = x => (x.brand + '|' + x.model).toLowerCase().replace(/[\s-]+/g, '');

// saved customers (Customers → Add customer); RFQs add to these automatically
const getCustomers = () => { const l = readJSON(F.customers, []); return Array.isArray(l) ? l.filter(c => c && typeof c.company === 'string' && Array.isArray(c.contacts)) : []; };
const saveCustomers = l => writeJSON(F.customers, l, true);
const cleanCustomer = b => {
  const str = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  const company = str(b.company, 120).replace(/\s+/g, ' ');
  if (!company) return { error: 'Enter a company name.' };
  const contacts = (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 20).map(x => ({ name: str(x && x.name, 80), phone: str(x && x.phone, 40), email: str(x && x.email, 120) }))
    .filter(x => x.name || x.phone || x.email);
  if (contacts.some(x => !x.name)) return { error: 'Each contact needs a name.' };
  if (contacts.some(x => x.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email))) return { error: 'Check the contact email addresses.' };
  const seen = new Set(); for (const x of contacts) { const n = x.name.toLowerCase(); if (seen.has(n)) return { error: `${x.name} is listed twice.` }; seen.add(n); }
  return { company, address: String(b.address == null ? '' : b.address).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 300), contacts, notes: str(b.notes, 1000) };
};
const custKey = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const effSt = r => r.status || ((r.sends || []).length ? 'sent' : 'draft');
// what anyone may see about an RFQ that isn't theirs: no customer details, contacts, values or notes
const limitedRfq = r => ({ id: '', no: r.no, date: r.date, by: r.by, byFull: r.byFull || r.by, burner: `${r.burner.brand} ${r.burner.name}`, fuel: r.burner.fuel,
  status: effSt(r), sentAt: ((r.sends || []).slice(-1)[0] || {}).at || '', limited: true });
// quoters only see RFQs once they're emailed (or already have a status or quote), never someone's draft
const isDraft = r => !(r.sends || []).length && !r.status && !r.quote;
const canSee = (me, r) => !!r && (r.by === me.name || (me.role !== 'rep' && !(me.role === 'quoter' && isDraft(r))));
const hiddenDraft = (me, r) => me.role === 'quoter' && r.by !== me.name && isDraft(r);
const quoteInfo = q => q ? { no: q.no || '', value: typeof q.value === 'number' ? q.value : null, note: q.note || '', at: q.at, by: q.by, byFull: q.byFull || q.by, file: !!q.file, fname: q.fname || '' } : null;
// quote turnaround: first time the RFQ was emailed -> first quote the office attached (later replacements don't count)
const turnaround = r => { const s = ((r.sends || [])[0] || {}).at || ''; if (!s) return { firstSent: '', firstQuoted: '', quotedBy: '' };
  const q = (r.quoteLog || []).find(x => !x.removed && x.at >= s) || (r.quote && r.quote.at >= s ? { at: r.quote.at, by: r.quote.by } : null);
  const u = q && users.find(x => x.name === q.by);
  return { firstSent: s, firstQuoted: q ? q.at : '', quotedBy: q ? (u && u.full) || q.by : '' }; };
const unreadFor = (r, me) => me ? (r.comments || []).filter(c => c.by !== me.name && c.at > ((r.seen || {})[me.name] || '')).length : 0;
const rfqSummary = (r, me) => ({ id: r.id, no: r.no, date: r.date, by: r.by, byFull: r.byFull, updated: r.updated,
  burner: `${r.burner.brand} ${r.burner.name}`, fuel: r.burner.fuel,
  company: r.fields['q-co'] || '', contact: r.fields['q-ct'] || '', job: r.fields['q-job'] || '',
  sent: (r.sends || []).slice(-1)[0] || null, status: r.status || '', statusAt: r.statusAt || '',
  value: typeof r.value === 'number' ? r.value : null, lostReason: r.status === 'lost' ? r.lostReason || '' : '', lostNote: r.status === 'lost' ? r.lostNote || '' : '',
  quote: quoteInfo(r.quote), comments: (r.comments || []).length, unread: unreadFor(r, me), ...turnaround(r),
  app: r.fields['q-app'] || '', archived: !!r.archived, claim: r.claim && !r.quote ? { by: r.claim.by, byFull: r.claim.byFull, at: r.claim.at } : null,
  // everything the RFQ search box looks through besides the columns shown
  find: [r.fields['q-app'], r.fields['q-addr'], r.fields['q-em'], r.fields['q-ph'], r.fields['q-po'], r.fields['q-notes'], r.fields['q-opt'], r.quote && r.quote.no].filter(Boolean).join(' ').slice(0, 1500),
  // the rep hasn't opened or acted on it since it was quoted (marking it Won or Lost settles it)
  newQuote: !!(me && r.quote && r.by === me.name && r.status !== 'won' && r.status !== 'lost' && r.quote.at > ((r.seen || {})[me.name] || '')),
  ...followUp(r) });
// Emailed or Quoted RFQs with no activity for N days need a follow-up. Activity = last email, status change or "followed up".
function followUp(r) {
  const st = r.status || ((r.sends || []).length ? 'sent' : 'draft'), days = followUpDays();
  if (!(st === 'sent' || st === 'quoted')) return { followUp: false, idleDays: 0, followedUpAt: r.followedUpAt || '' };
  const t = [((r.sends || []).slice(-1)[0] || {}).at, r.statusAt, r.followedUpAt].filter(Boolean).map(Date.parse).filter(isFinite);
  const idle = t.length ? Math.floor((Date.now() - Math.max(...t)) / 864e5) : 0;
  return { followUp: days > 0 && idle >= days, idleDays: idle, followedUpAt: r.followedUpAt || '' };
}
const cleanFields = f => {
  const out = {};
  for (const [k, v] of Object.entries(f && typeof f === 'object' ? f : {}))
    if (/^q-[a-z0-9-]{1,20}$/.test(k) && Object.keys(out).length < 80) out[k] = String(v ?? '').slice(0, 4000);
  return out;
};
const rfqText = r => {
  const f = r.fields, b = r.burner, L = [];
  L.push(`Burner Request for Quotation ${r.no}`, '');
  if (f['q-co'] || f['q-job']) L.push(`Customer: ${[f['q-co'], f['q-job']].filter(Boolean).join(' – ')}`);
  L.push(`Burner: ${b.brand} ${b.name}`);
  L.push(`Prepared by: ${[f['q-rep'], f['q-repp'], f['q-repe']].filter(Boolean).join(' · ') || r.byFull || r.by}`);
  if (f['q-notes']) L.push('', 'Notes:', f['q-notes']);
  L.push('', 'The full RFQ specification sheet is attached as a PDF.');
  return L.join('\n');
};
const rfqPdf = (r, me) => renderPDF({
  url: `http://127.0.0.1:${PORT}/?rfq=${r.id}&pdf=1`,
  cookie: { name: 'bm_s', value: makeToken(me.name, me.ver || 0, 120e3) },
});
const pdfName = r => `RFQ-${r.no}.pdf`.replace(/[^A-Za-z0-9._-]/g, '');

// ---------- data check: things that are missing or don't line up ----------
// a guide's burner name -> matrix burner of the same brand (same rule the matrix page uses: exact, one part of "AF/AFG", else longest prefix)
function specBurnerKey(brand, burner, list) {
  const nrm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''), s = nrm(burner), br = String(brand).toLowerCase(); if (!s) return null;
  const c = list.filter(b => b.brand.toLowerCase() === br).map(b => ({ b, parts: [b.name, ...b.name.split(/[\/,]/)].map(nrm).filter(Boolean) }));
  const ex = c.find(o => o.parts.includes(s)); if (ex) return keyOf(ex.b);
  let best = null, len = 0; for (const o of c) for (const p of o.parts) if (p.length >= 2 && s.startsWith(p) && p.length > len) { best = o.b; len = p.length; }
  return best ? keyOf(best) : null;
}
function dataCheck() {
  const list = getBurners(), keys = new Set(list.map(keyOf)), out = [];
  const add = (area, level, title, items, fix) => { if (items.length) out.push({ area, level, title, count: items.length, items: items.slice(0, 200), fix }); };
  const nm = b => `${b.brand} ${b.name}`;
  add('Burners', 'warn', 'No photo', list.filter(b => !b.image).map(nm), 'Add a photo in the Burners tab.');
  add('Burners', 'warn', 'No dimensions', list.filter(b => !Array.isArray(b.dims)).map(b => nm(b) + (typeof b.dims === 'string' && b.dims ? ` (${b.dims})` : '')), 'Add H × W × D in the Burners tab, so the "Fits in" filters can use it.');
  add('Burners', 'info', 'No air tube lengths for the RFQ dropdown', list.filter(b => b.fuel === 'oil' && !(Array.isArray(b.airTubes) && b.airTubes.length)).map(nm), 'Add the available lengths in the Burners tab.');
  add('Burners', 'info', 'No flame size', list.filter(b => b.flameLength == null && b.flameWidth == null).map(nm), 'Add flame length and width, so the "Flame must fit" filter can use it.');
  add('Burners', 'warn', 'No product page link', list.filter(b => !b.link).map(nm), 'Add the product page in the Burners tab.');
  const xs = getXref();
  add('Cross-reference', 'error', 'Points at a burner that’s no longer in the matrix', xs.filter(x => x.to.some(k => !keys.has(k))).map(x => `${x.brand} ${x.model} → ${x.to.filter(k => !keys.has(k)).join(', ')}`), 'Edit the entry in the Cross-reference tab.');
  add('Cross-reference', 'warn', 'No replacement picked (and not marked “no current replacement”)', xs.filter(x => !x.to.length && !x.none).map(x => `${x.brand} ${x.model}`), 'Pick a replacement or tick “No current replacement”.');
  for (const set of SPECS.sets()) {
    const t = Specs.title(set), miss = new Map();
    for (const row of set.rows) { const bn = Specs.burnerOf(set, row); if (!specBurnerKey(set.brand, bn, list)) miss.set(bn || '(blank)', (miss.get(bn || '(blank)') || 0) + 1); }
    add('Spec guides', 'error', `${t}: burner not in the matrix (these specs can’t start an RFQ)`, [...miss].map(([b, n]) => `${b} (${n} spec${n > 1 ? 's' : ''})`), 'Add the burner in the Burners tab, or correct the burner name in the guide.');
    const cm = set.cols.findIndex(c => c.toLowerCase() === 'spec match'), cs = set.cols.findIndex(c => c.toLowerCase() === 'beckett spec');
    if (cs < 0) add('Spec guides', 'info', `${t}: no Beckett Spec column`, ['Reps won’t see spec numbers for this guide'], 'Load a copy of the guide with Beckett Spec / Spec Match columns.');
    else add('Spec guides', 'warn', `${t}: linked to an inactive spec`, set.rows.filter(r => /inactive/i.test(r.v[cm] || '')).map(r => `${r.v[set.roles.mfg]} ${r.v[set.roles.model]} → ${r.v[cs]}`), 'Reject it in Settings → Review spec links, or load a guide linked to active specs only.');
  }
  const order = { error: 0, warn: 1, info: 2 };
  return { at: new Date().toISOString(), issues: out.sort((a, b) => order[a.level] - order[b.level]) };
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  // all writes must be same-origin JSON with our header (CSRF guard on top of SameSite=Lax)
  if (m !== 'GET' && (req.headers['x-bm'] !== '1' || !/application\/json/.test(req.headers['content-type'] || '')))
    return send(res, 403, { error: 'Bad request' });

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const { name = '', password = '', remember = false } = await readBody(req, 4096);
    const u = users.find(x => x.name === String(name).trim().toLowerCase());
    if (!u || !checkPw(String(password), u.hash)) { failed(ip); return send(res, 401, { error: 'Wrong username or password' }); }
    attempts.delete(ip);
    const life = remember ? REMEMBER_DAYS * 86400 : SESSION_HOURS * 3600; // seconds
    return send(res, 200, { name: u.name, role: u.role }, undefined, { 'Set-Cookie': cookie(makeToken(u.name, u.ver || 0, life * 1000), life) });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('', 0) });

  const me = readSession(req);
  const act = t => { if (me) req.act = { by: me.name, t }; }; // recorded in the activity log once the change succeeds
  const meInfo = u => ({ ...pub(u), setup: true, mail: Mail.configured(), rfqTo: rfqTo(), followUpDays: followUpDays(), stepDownWarn: stepDownWarn(), lostReasons: LOST_REASONS });
  if (p === '/api/me') return me ? send(res, 200, meInfo(me)) : send(res, 401, { error: 'Not signed in', setup: users.length > 0 });
  if (!me) return send(res, 401, { error: 'Not signed in' });

  if (p === '/api/push/key' && m === 'GET') return send(res, 200, { key: Push.b64u(Push.publicKey(VAPID)) });
  if (p === '/api/push/subscribe' && m === 'POST') {
    const b = await readBody(req, 8192), s = b.sub || {};
    if (!Push.okEndpoint(s.endpoint) || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return send(res, 422, { error: 'Bad subscription' });
    const list = getSubs().filter(x => x.endpoint !== s.endpoint);
    list.push({ user: me.name, endpoint: String(s.endpoint).slice(0, 1000), keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) },
      device: String(b.device || '').slice(0, 80), added: new Date().toISOString() });
    writeJSON(F.push, list.slice(-500)); return send(res, 200, { ok: true, devices: list.filter(x => x.user === me.name).length });
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const b = await readBody(req, 4096), list = getSubs();
    writeJSON(F.push, list.filter(x => !(x.endpoint === b.endpoint && x.user === me.name))); return send(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && m === 'POST') {
    const mine = getSubs().filter(s => s.user === me.name);
    if (!mine.length) return send(res, 404, { error: 'Notifications aren’t turned on for any of your devices yet' });
    const rs = await Promise.all(mine.map(s => Push.send(VAPID, pushContact(), s, { title: 'Burner Matrix', body: 'Notifications are working on this device.', url: '/' }).catch(e => ({ ok: false, error: e.message }))));
    const gone = new Set(mine.filter((s, i) => rs[i].gone).map(s => s.endpoint)); if (gone.size) writeJSON(F.push, getSubs().filter(s => !gone.has(s.endpoint)));
    const ok = rs.filter(r => r.ok).length;
    return ok ? send(res, 200, { ok, of: mine.length }) : send(res, 502, { error: 'The push service didn’t accept it' + (rs[0] && (rs[0].status ? ` (HTTP ${rs[0].status})` : rs[0].error ? ` (${rs[0].error})` : '')) });
  }
  // next RFQ sequence number for the day (shared by every rep using this server)
  if (p === '/api/rfq-seq' && m === 'POST') {
    const { date = '' } = await readBody(req, 256);
    if (!/^\d{6}$/.test(String(date))) return send(res, 400, { error: 'Bad date' });
    // one counter per day (kept for the last 14 days) so reps in different time zones near midnight never share a number
    const f = path.join(DATA, 'rfq-seq.json');
    const cur = readJSON(f, {});
    const days = cur.days && typeof cur.days === 'object' ? cur.days : (cur.date ? { [cur.date]: cur.n || 0 } : {});
    const n = (+days[date] || 0) + 1;
    days[date] = n;
    const keep = Object.keys(days).sort().slice(-14);
    writeJSON(f, { days: Object.fromEntries(keep.map(k => [k, days[k]])) });
    return send(res, 200, { date, n });
  }
  // ----- RFQs: reps see their own, editors and admins see everyone's -----
  if (p === '/api/rfqs' && m === 'GET') {
    const list = allRfqs().filter(r => canSee(me, r)).map(r => rfqSummary(r, me)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return send(res, 200, list);
  }
  if (p === '/api/rfqs/export.xlsx' && m === 'GET') { // everything the user can see, as a spreadsheet
    const all = allRfqs().filter(r => canSee(me, r)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const F_ = (r, k) => r.fields[k] || '';
    const STL = { '': 'Draft', sent: 'Emailed', quoted: 'Quoted', won: 'Won', lost: 'Lost' };
    const cols = [
      ['RFQ #', 16], ['Date', 11, 'date'], ['Rep', 18], ['Status', 10], ['Status date', 11, 'date'], ['Quote value', 13, 'money'], ['Lost reason', 20], ['Lost note', 30],
      ['Follow-up due', 13], ['Days idle', 9, 'number'], ['Emailed on', 11, 'date'], ['Emailed to', 28],
      ['Company', 28], ['Contact', 20], ['Phone', 15], ['Email', 26], ['Project / job', 28], ['Site address', 34], ['Quantity', 9], ['Required by', 13], ['Customer ref / PO', 16],
      ['Burner brand', 12], ['Burner model', 16], ['Fuel', 6], ['Appliance make / model', 24], ['Appliance type', 20], ['Required input', 20], ['Fuel type', 18], ['Power on site', 18],
      ['Voltage', 16], ['Firing mode', 12], ['Mounting', 16], ['Air tube length', 14], ['Insertion depth', 14], ['Controls / panel', 20], ['Other options', 20], ['Notes', 40],
      ['Quote #', 14], ['Quoted by', 18], ['Quoted on', 11, 'date'], ['Comments', 10, 'number'],
    ].map(([header, width, type]) => ({ header, width, type }));
    const rows = all.map(r => { const s = rfqSummary(r), last = (r.sends || []).slice(-1)[0];
      const st = r.status || (last ? 'sent' : '');
      return [r.no, r.date, r.byFull || r.by, STL[st] || st, r.statusAt || '', s.value, s.lostReason, s.lostNote,
        s.followUp ? 'Yes' : '', st === 'sent' || st === 'quoted' ? s.idleDays : '', last ? last.at : '', last ? last.to.join(', ') : '',
        F_(r, 'q-co'), F_(r, 'q-ct'), F_(r, 'q-ph'), F_(r, 'q-em'), F_(r, 'q-job'), F_(r, 'q-addr'), F_(r, 'q-qty'), F_(r, 'q-need'), F_(r, 'q-po'),
        r.burner.brand, r.burner.name, r.burner.fuel, F_(r, 'q-app'), F_(r, 'q-type'), F_(r, 'q-rate'), F_(r, 'q-fuel'), F_(r, 'q-pwr'),
        F_(r, 'q-v'), F_(r, 'q-m'), F_(r, 'q-mount'), F_(r, 'q-tube'), F_(r, 'q-ins'), F_(r, 'q-ctl'), F_(r, 'q-opt'), F_(r, 'q-notes'),
        r.quote ? r.quote.no || '' : '', r.quote ? r.quote.byFull || r.quote.by : '', r.quote ? r.quote.at : '', (r.comments || []).length]; });
    const name = `RFQs-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return send(res, 200, XLSX.build({ sheet: 'RFQs', cols, rows }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { 'Content-Disposition': `attachment; filename="${name}"` });
  }
  if (p === '/api/customers' && m === 'GET') { // address book + per-customer totals: saved customers + everyone's RFQs (newest details win)
    const by = new Map(), staff = me.role !== 'rep', saved = getCustomers();
    for (const r of allRfqs().filter(r => !hiddenDraft(me, r)).sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      const co = String(r.fields['q-co'] || '').trim(); if (!co) continue;
      const k = custKey(co), c = by.get(k) || { company: co, address: '', contacts: new Map(), rfqs: 0, won: 0, lost: 0, valueWon: 0, last: '', lastBurner: '', mine: 0 };
      c.company = co; if (r.fields['q-addr']) c.address = r.fields['q-addr'];
      const ct = String(r.fields['q-ct'] || '').trim();
      if (ct) { const p0 = c.contacts.get(ct.toLowerCase()) || {}; c.contacts.delete(ct.toLowerCase()); c.contacts.set(ct.toLowerCase(), { name: ct, phone: r.fields['q-ph'] || p0.phone || '', email: r.fields['q-em'] || p0.email || '', at: r.date }); }
      const st = effSt(r); c.rfqs++; if (st === 'won') { c.won++; if (typeof r.value === 'number' && (staff || r.by === me.name)) c.valueWon += r.value; } if (st === 'lost') c.lost++;
      c.last = r.date; c.lastBurner = `${r.burner.brand} ${r.burner.name}`; if (r.by === me.name) c.mine++;
      by.set(k, c);
    }
    const out = [...by.entries()].map(([k, c]) => ({ key: k, ...c, contacts: [...c.contacts.values()].reverse() }));
    for (const sc of saved) { // saved details: their address and contacts come first; RFQ contacts not already listed follow
      const k = custKey(sc.company); let c = out.find(x => x.key === k);
      if (!c) out.push(c = { key: k, company: sc.company, address: '', contacts: [], rfqs: 0, won: 0, lost: 0, valueWon: 0, last: '', lastBurner: '', mine: 0 });
      if (sc.address) c.address = sc.address;
      const names = new Set(sc.contacts.map(x => x.name.toLowerCase())), hid = sc.hidden && typeof sc.hidden === 'object' ? sc.hidden : {};
      c.contacts = [...sc.contacts.map(x => { const r = c.contacts.find(y => y.name.toLowerCase() === x.name.toLowerCase()) || {}; return { name: x.name, phone: x.phone || r.phone || '', email: x.email || r.email || '' }; }),
        // RFQ contacts someone removed stay hidden unless an RFQ made after the removal uses them again
        ...c.contacts.filter(x => !names.has(x.name.toLowerCase()) && !(hid[x.name.toLowerCase()] && String(x.at) <= hid[x.name.toLowerCase()]))];
      Object.assign(c, { saved: true, notes: sc.notes || '', addedBy: sc.byFull || sc.by, added: sc.added, canEdit: staff || sc.by === me.name || c.mine > 0 });
    }
    for (const c of out) { if (!c.saved) c.canEdit = true; delete c.key; c.contacts = c.contacts.map(({ at, ...x }) => x); }
    return send(res, 200, out.sort((a, b) => a.company.localeCompare(b.company)));
  }
  if (p === '/api/customers' && (m === 'POST' || m === 'PUT')) { // add a customer, or save/edit the details of one
    const b = (await readBody(req, 64 * 1024)) || {}, list = getCustomers();
    const v = cleanCustomer(b); if (v.error) return send(res, 422, v);
    const staff = me.role !== 'rep', k = custKey(v.company), now = new Date().toISOString();
    const rfqNames = new Set(allRfqs().map(r => custKey(r.fields['q-co'])).filter(Boolean));
    if (m === 'POST') {
      const ex = list.find(c => custKey(c.company) === k) || (rfqNames.has(k) && { company: String(allRfqs().find(r => custKey(r.fields['q-co']) === k).fields['q-co']).trim() });
      if (ex) return send(res, 409, { error: `${ex.company} is already in the customer list. Open it to change its details.`, company: ex.company });
      list.push({ ...v, by: me.name, byFull: me.full || me.name, added: now, updated: now });
      saveCustomers(list); return send(res, 201, { ok: true, company: v.company });
    }
    const ok_ = custKey(b.original || v.company), i = list.findIndex(c => custKey(c.company) === ok_);
    if (i < 0 && !rfqNames.has(ok_)) return send(res, 404, { error: 'No such customer' });
    const quoted = k2 => allRfqs().some(r => r.by === me.name && custKey(r.fields['q-co']) === k2);
    if (i >= 0 && !staff && list[i].by !== me.name && !quoted(ok_)) return send(res, 403, { error: 'Only the person who added this customer, a rep who has quoted it, an editor or an admin can change it.' });
    if (k !== ok_) { // renaming is only for customers with no RFQs yet (RFQs keep the name they were made with)
      if (rfqNames.has(ok_)) return send(res, 409, { error: 'This customer already has RFQs, so its name can’t be changed here.' });
      if (list.some((c, j) => j !== i && custKey(c.company) === k) || rfqNames.has(k)) return send(res, 409, { error: `${v.company} is already in the customer list.` });
    }
    const hidden = { ...((i >= 0 && list[i].hidden) || {}) };
    for (const n of (Array.isArray(b.removed) ? b.removed : []).slice(0, 50)) { const k2 = String(n || '').trim().toLowerCase().slice(0, 80); if (k2) hidden[k2] = now; }
    for (const x of v.contacts) delete hidden[x.name.toLowerCase()]; // typed back in = shown again
    v.hidden = hidden;
    if (i >= 0) list[i] = { ...list[i], ...v, updated: now, updatedBy: me.name };
    else list.push({ ...v, by: me.name, byFull: me.full || me.name, added: now, updated: now });
    saveCustomers(list); return send(res, 200, { ok: true, company: v.company });
  }
  if (p === '/api/customers' && m === 'DELETE') { // removes the saved details only; RFQs (and the customer, if it has any) stay
    const b = (await readBody(req, 4096)) || {}, list = getCustomers(), k = custKey(b.company), i = list.findIndex(c => custKey(c.company) === k);
    if (i < 0) return send(res, 404, { error: 'No saved details for that customer' });
    if (me.role === 'rep' && list[i].by !== me.name && !allRfqs().some(r => r.by === me.name && custKey(r.fields['q-co']) === k)) return send(res, 403, { error: 'Only the person who added this customer, a rep who has quoted it, an editor or an admin can remove it.' });
    act(`Removed saved details for customer ${list[i].company}`); list.splice(i, 1); saveCustomers(list); return send(res, 200, { ok: true });
  }
  if (p === '/api/customers/history' && m === 'GET') { // every RFQ for one customer; others' RFQs are summary-only for reps
    const k = custKey(url.searchParams.get('company'));
    if (!k) return send(res, 400, { error: 'Missing company' });
    const rows = allRfqs().filter(r => custKey(r.fields['q-co']) === k && !hiddenDraft(me, r)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const sc = getCustomers().find(c => custKey(c.company) === k);
    if (!rows.length && !sc) return send(res, 404, { error: 'No such customer' });
    return send(res, 200, { company: rows.length ? String(rows[0].fields['q-co']).trim() : sc.company, rfqs: rows.map(r => canSee(me, r) ? { ...rfqSummary(r), open: true } : limitedRfq(r)) });
  }
  if (p === '/api/customers/recent' && m === 'GET') { // for the duplicate warning: same customer in the last 90 days
    const k = custKey(url.searchParams.get('company')), skip = url.searchParams.get('exclude') || '', since = Date.now() - 90 * 864e5;
    if (!k) return send(res, 200, []);
    return send(res, 200, allRfqs().filter(r => r.id !== skip && custKey(r.fields['q-co']) === k && Date.parse(r.date) >= since && !hiddenDraft(me, r))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5).map(r => ({ ...limitedRfq(r), mine: r.by === me.name })));
  }
  if (p === '/api/rfqs' && m === 'POST') { // create
    const b = await readBody(req, 512 * 1024);
    const burner = b.burner && typeof b.burner === 'object' ? b.burner : null;
    if (!burner || Schema.check(burner).length) return send(res, 422, { error: 'Missing or invalid burner' });
    const no = String(b.no || '').slice(0, 40);
    if (!/^[0-9A-Za-z-]{6,40}$/.test(no)) return send(res, 422, { error: 'Bad RFQ number' });
    const now = new Date().toISOString();
    const r = { id: crypto.randomBytes(6).toString('hex'), no, date: now, updated: now, by: me.name, byFull: me.full || '',
      burner, fit: ['ok', 'min', 'max', 'out'].includes(b.fit) ? b.fit : '', fields: cleanFields(b.fields), sends: [],
      locks: Array.isArray(b.locks) ? b.locks.filter(k => /^q-[a-z0-9-]{1,20}$/.test(k)).slice(0, 10) : [] };
    // step-down transformer note: set once when the RFQ is made, never changed afterwards (PUT ignores it)
    const xf = typeof b.xfmr === 'string' ? b.xfmr.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400) : '';
    if (xf) r.xfmr = xf;
    writeJSON(rfqFile(r.id), r);
    return send(res, 200, r);
  }
  if (p === '/api/rfqs/bulk' && m === 'POST') { // the same change to several RFQs at once: mark lost, followed up, archive / unarchive
    const b = (await readBody(req, 64 * 1024)) || {}, ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string').slice(0, 500) : [];
    if (!['lost', 'followup', 'archive', 'unarchive'].includes(b.action)) return send(res, 422, { error: 'Unknown action' });
    if (b.action === 'lost' && !LOST_REASONS.includes(b.lostReason)) return send(res, 422, { error: 'Pick a lost reason' });
    const now = new Date().toISOString(), out = []; let skipped = 0;
    for (const id of ids) {
      const r = /^[\w-]+$/.test(id) ? getRfq(id) : null;
      if (!canSee(me, r) || (me.role === 'rep' && r.by !== me.name)) { skipped++; continue; }
      if (b.action === 'followup') { if (!followUp(r).followUp) { skipped++; continue; } r.followedUpAt = now; (r.followLog = r.followLog || []).push({ at: now, by: me.name }); }
      else if (b.action === 'lost') { if (r.status === 'won' || r.status === 'lost') { skipped++; continue; } r.status = 'lost'; r.lostReason = b.lostReason; r.lostNote = String(b.lostNote || '').trim().slice(0, 500); r.statusAt = now; r.statusBy = me.name;
        (r.statusLog = r.statusLog || []).push({ at: now, by: me.name, status: 'lost', value: r.value, lostReason: r.lostReason }); }
      else { if (!!r.archived === (b.action === 'archive')) { skipped++; continue; } r.archived = b.action === 'archive'; }
      if (r.by === me.name) r.seen = { ...(r.seen || {}), [me.name]: now };
      writeJSON(rfqFile(r.id), r); out.push(rfqSummary(r, me));
    }
    if (out.length) act(`${{ lost: 'Marked lost (' + b.lostReason + ')', followup: 'Marked followed up', archive: 'Archived', unarchive: 'Unarchived' }[b.action]}: ${out.map(x => x.no).join(', ')}`);
    return send(res, 200, { changed: out, skipped });
  }
  if (p === '/api/quote-templates') { // saved price + note for common quotes (quoters and admins)
    if (!canQuote(me)) return send(res, 403, { error: 'Only quoters and admins use quote templates' });
    if (m === 'GET') return send(res, 200, getTpl());
    const b = (await readBody(req, 16 * 1024)) || {}, list = getTpl();
    if (m === 'DELETE') { const i = list.findIndex(t => t.id === b.id); if (i < 0) return send(res, 404, { error: 'Template not found' }); act(`Deleted quote template "${list[i].name}"`); list.splice(i, 1); writeJSON(F.qtpl, list); return send(res, 200, { ok: true }); }
    if (m === 'POST') {
      const name = String(b.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
      if (!name) return send(res, 422, { error: 'Give the template a name' });
      let value = null;
      if (b.value !== undefined && b.value !== null && String(b.value).trim() !== '') { value = Number(String(b.value).replace(/[$,\s]/g, '')); if (!isFinite(value) || value < 0 || value > 1e9) return send(res, 422, { error: 'Price must be a dollar amount' }); value = Math.round(value * 100) / 100; }
      const t = { id: crypto.randomBytes(5).toString('hex'), name, burner: String(b.burner || '').toLowerCase().slice(0, 80), value,
        note: String(b.note || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 1000), by: me.name, at: new Date().toISOString() };
      const i = list.findIndex(x => x.id === b.id || x.name.toLowerCase() === name.toLowerCase()); if (i >= 0) { t.id = list[i].id; list[i] = t; } else list.push(t);
      list.sort((a, c) => a.name.localeCompare(c.name)); writeJSON(F.qtpl, list); act(`${i >= 0 ? 'Updated' : 'Added'} quote template "${name}"`); return send(res, 200, t);
    }
    return send(res, 405, { error: 'Method not allowed' });
  }
  const rm = /^\/api\/rfqs\/([a-f0-9]{12})(\/pdf|\/send|\/status|\/followup|\/quote|\/comments|\/seen|\/claim)?$/.exec(p);
  if (rm) {
    const r = getRfq(rm[1]);
    if (!canSee(me, r)) return send(res, 404, { error: 'RFQ not found' });
    if (!rm[2] && m === 'GET') return send(res, 200, r);
    if (!rm[2] && m === 'PUT') {
      // A draft can be changed by the rep who made it until it's emailed. After that it's a record:
      // it opens read-only, and "Copy to new RFQ" starts a revision.
      if ((r.sends || []).length) return send(res, 409, { error: 'This RFQ was emailed, so it can’t be changed. Use “Copy to new RFQ” to make a revised one.' });
      if (r.by !== me.name) return send(res, 403, { error: 'Only the rep who made this RFQ can change it.' });
      const b = await readBody(req, 512 * 1024); reloadRfq(r);
      if ((r.sends || []).length) return send(res, 409, { error: 'This RFQ was emailed, so it can’t be changed. Use “Copy to new RFQ” to make a revised one.' });
      r.fields = cleanFields(b.fields); r.updated = new Date().toISOString(); r.editedBy = me.name;
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, r);
    }
    if (rm[2] === '/status' && m === 'POST') { // quoted / won / lost tracking; '' = automatic (draft or emailed)
      if (r.by !== me.name && me.role === 'rep') return send(res, 403, { error: 'Only the rep who made it can change its status' });
      const b = await readBody(req, 4096), status = b.status || ''; reloadRfq(r);
      if (!['', 'quoted', 'won', 'lost'].includes(status)) return send(res, 422, { error: 'Unknown status' });
      if (b.value !== undefined && b.value !== null && b.value !== '') {
        const n = Number(String(b.value).replace(/[$,\s]/g, ''));
        if (!isFinite(n) || n < 0 || n > 1e9) return send(res, 422, { error: 'Quote value must be a dollar amount' });
        r.value = Math.round(n * 100) / 100;
      } else if (b.value === null || b.value === '') delete r.value;
      if (status === 'lost') {
        if (b.lostReason !== undefined && b.lostReason !== '' && !LOST_REASONS.includes(b.lostReason)) return send(res, 422, { error: 'Unknown lost reason' });
        if (b.lostReason !== undefined) r.lostReason = b.lostReason || '';
        if (b.lostNote !== undefined) r.lostNote = String(b.lostNote || '').trim().slice(0, 500);
      } else { delete r.lostReason; delete r.lostNote; }
      r.status = status; r.statusAt = new Date().toISOString(); r.statusBy = me.name;
      if (r.by === me.name) r.seen = { ...(r.seen || {}), [me.name]: r.statusAt }; // the rep has dealt with it
      (r.statusLog = r.statusLog || []).push({ at: r.statusAt, by: me.name, status, value: r.value, lostReason: r.lostReason });
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, rfqSummary(r, me));
    }
    if (rm[2] === '/claim' && m === 'POST') { // a quoter says "I'm on it" (or lets it go), so two people don't quote the same RFQ
      if (!canQuote(me)) return send(res, 403, { error: 'Only quoters and admins can take an RFQ' });
      const b = (await readBody(req, 1024)) || {}; reloadRfq(r);
      if (b.on) { if (r.claim && r.claim.by !== me.name && !b.force) return send(res, 409, { error: `${r.claim.byFull || r.claim.by} is already on it` }); r.claim = { by: me.name, byFull: me.full || me.name, at: new Date().toISOString() }; }
      else { if (r.claim && r.claim.by !== me.name && me.role !== 'admin') return send(res, 403, { error: 'Only the person who took it (or an admin) can let it go' }); delete r.claim; }
      writeJSON(rfqFile(r.id), r); return send(res, 200, rfqSummary(r, me));
    }
    if (rm[2] === '/followup' && m === 'POST') { // "I followed up": restarts the follow-up clock
      if (r.by !== me.name && me.role === 'rep') return send(res, 403, { error: 'Only the rep who made it can do this' });
      r.followedUpAt = new Date().toISOString();
      if (r.by === me.name) r.seen = { ...(r.seen || {}), [me.name]: r.followedUpAt };
      (r.followLog = r.followLog || []).push({ at: r.followedUpAt, by: me.name });
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, rfqSummary(r, me));
    }
    if (rm[2] === '/pdf' && m === 'GET') {
      let pdf; try { pdf = await rfqPdf(r, me); } catch (e) { console.error('PDF:', e.message); return send(res, 502, { error: 'Could not build the PDF: ' + e.message }); }
      return send(res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="${pdfName(r)}"` });
    }
    // ----- the office's quote for this RFQ (quoters and admins) -----
    if (rm[2] === '/quote' && m === 'GET') {
      if (!r.quote || !r.quote.file) return send(res, 404, { error: 'No quote PDF on this RFQ' });
      const f = path.join(F.quotes, path.basename(r.quote.file));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'The quote file is missing' });
      return send(res, 200, fs.readFileSync(f), 'application/pdf', { 'Content-Disposition': `attachment; filename="${(r.quote.fname || 'Quote-' + r.no + '.pdf').replace(/[^A-Za-z0-9._ -]/g, '')}"` });
    }
    if (rm[2] === '/quote' && (m === 'POST' || m === 'DELETE')) {
      if (!canQuote(me)) return send(res, 403, { error: 'Only quoters and admins can add quotes' });
      const old = r.quote && r.quote.file ? path.join(F.quotes, path.basename(r.quote.file)) : null;
      if (m === 'DELETE') {
        if (!r.quote) return send(res, 404, { error: 'No quote on this RFQ' });
        if (old) fs.rmSync(old, { force: true });
        (r.quoteLog = r.quoteLog || []).push({ at: new Date().toISOString(), by: me.name, removed: true });
        delete r.quote; writeJSON(rfqFile(r.id), r); act(`Removed the quote on ${r.no}`); return send(res, 200, rfqSummary(r, me));
      }
      const b = (await readBody(req, 16 * 1024 * 1024)) || {}, now = new Date().toISOString(); reloadRfq(r); delete r.claim; act(`Quoted ${r.no}`);
      const qno = String(b.no || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40), note = String(b.note || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
      let value = null;
      if (b.value !== undefined && b.value !== null && String(b.value).trim() !== '') {
        value = Number(String(b.value).replace(/[$,\s]/g, ''));
        if (!isFinite(value) || value < 0 || value > 1e9) return send(res, 422, { error: 'Price must be a dollar amount' });
        value = Math.round(value * 100) / 100;
      }
      let file = null, fname = '';
      if (b.file && b.file.data) {
        const buf = Buffer.from(String(b.file.data), 'base64');
        if (buf.length > 10 * 1024 * 1024) return send(res, 413, { error: 'The quote PDF must be 10 MB or smaller' });
        if (buf.slice(0, 5).toString() !== '%PDF-') return send(res, 422, { error: 'The quote file must be a PDF' });
        file = `${r.id}-${Date.now()}.pdf`; fname = String(b.file.name || '').replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 80) || `Quote-${r.no}.pdf`;
        fs.writeFileSync(path.join(F.quotes, file), buf);
      } else if (b.keepFile && r.quote && r.quote.file) { file = r.quote.file; fname = r.quote.fname; }
      if (!file && value === null && !qno) return send(res, 422, { error: 'Add the quote PDF, a quote number or the price.' });
      const prev = r.quote && r.quote.file ? path.join(F.quotes, path.basename(r.quote.file)) : null; // current file, after reload
      if (prev && (!file || path.basename(prev) !== file)) fs.rmSync(prev, { force: true });
      r.quote = { no: qno, value, note, file, fname, by: me.name, byFull: me.full || me.name, at: now };
      (r.quoteLog = r.quoteLog || []).push({ at: now, by: me.name, no: qno, value });
      if (value !== null) r.value = value;
      if (r.status !== 'won' && r.status !== 'lost') { // quoting moves it to Quoted
        r.status = 'quoted'; r.statusAt = now; r.statusBy = me.name;
        (r.statusLog = r.statusLog || []).push({ at: now, by: me.name, status: 'quoted', value: r.value });
      }
      writeJSON(rfqFile(r.id), r);
      if (r.by !== me.name) notify([r.by], { title: 'Quote ready', tag: 'q-' + r.id, url: '/?rfq=' + r.id,
        body: `RFQ ${r.no}${r.fields['q-co'] ? ' – ' + r.fields['q-co'] : ''}${value !== null ? ': $' + value.toLocaleString('en-US') : ''}${qno ? ' (' + qno + ')' : ''}` });
      let mailed = null, mailError = null;
      if (b.emailRep && Mail.configured()) { // let the rep know, with the quote attached
        const owner = users.find(u => u.name === r.by), to = [owner && owner.email, r.fields['q-repe']].filter(Mail.isEmail).slice(0, 1);
        if (to.length) {
          const lines = [`The quote for RFQ ${r.no} (${r.burner.brand} ${r.burner.name}${r.fields['q-co'] ? ', ' + r.fields['q-co'] : ''}) is ready.`, '',
            qno ? `Quote number: ${qno}` : '', value !== null ? `Price: $${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '', note ? `Note: ${note}` : '',
            '', `Quoted by ${me.full || me.name}.`].filter((l, i, a) => l || (a[i - 1] && i < a.length - 1));
          try { const out = await Mail.sendMail({ to, replyTo: me.email, subject: `Quote ready: RFQ ${r.no}` + (r.fields['q-co'] ? ` – ${r.fields['q-co']}` : ''), text: lines.join('\n'),
              attachments: file ? [{ filename: fname, type: 'application/pdf', content: fs.readFileSync(path.join(F.quotes, file)) }] : [] }); mailed = out.to; }
          catch (e) { console.error('Mail:', e.message); mailError = e.message; }
        } else mailError = 'The rep has no email address on file';
      }
      return send(res, 200, { ...rfqSummary(r, me), mailed, mailError });
    }
    // ----- internal comments between the rep and the office (never on the PDF) -----
    if (rm[2] === '/seen' && m === 'POST') { r.seen = { ...(r.seen || {}), [me.name]: new Date().toISOString() }; writeJSON(rfqFile(r.id), r); return send(res, 200, { ok: true }); }
    if (rm[2] === '/comments' && m === 'GET') return send(res, 200, r.comments || []);
    if (rm[2] === '/comments' && m === 'POST') {
      const b = (await readBody(req, 16 * 1024)) || {}; reloadRfq(r); const text = String(b.text || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 2000);
      if (!text) return send(res, 422, { error: 'Write a comment first' });
      const now = new Date().toISOString(), c = { id: crypto.randomBytes(4).toString('hex'), by: me.name, byFull: me.full || me.name, at: now, text };
      (r.comments = r.comments || []).push(c); if (r.comments.length > 300) r.comments = r.comments.slice(-300);
      r.seen = { ...(r.seen || {}), [me.name]: now }; writeJSON(rfqFile(r.id), r);
      { // phone notification to the other side: the rep, or the office people on this RFQ (or every quoter if none yet)
        let who = me.name !== r.by ? [r.by] : [...new Set([r.quote && r.quote.by, ...(r.comments || []).map(x => x.by)].filter(n => n && n !== r.by))];
        if (!who.length) who = quoters();
        notify(who.filter(n => n !== me.name), { title: `${me.full || me.name} commented`, tag: 'c-' + r.id, url: '/?rfq=' + r.id,
          body: `RFQ ${r.no}${r.fields['q-co'] ? ' – ' + r.fields['q-co'] : ''}: ${text.length > 120 ? text.slice(0, 117) + '…' : text}` });
      }
      let mailed = null, mailError = null;
      if (b.notify !== false && Mail.configured()) { // tell the other side: the rep, or the office people on this RFQ
        const emailOf = n => { const u = users.find(x => x.name === n); return u && Mail.isEmail(u.email) ? u.email : null; };
        let to;
        if (me.name !== r.by) to = [emailOf(r.by) || (Mail.isEmail(r.fields['q-repe']) ? r.fields['q-repe'] : null)];
        else { const office = new Set([r.quote && r.quote.by, ...(r.comments || []).map(x => x.by)].filter(n => n && n !== r.by));
          to = [...office].map(emailOf); if (!to.filter(Boolean).length) to = Mail.splitList(rfqTo()); }
        to = [...new Set(to.filter(Mail.isEmail))].slice(0, 10);
        if (to.length) {
          try { const out = await Mail.sendMail({ to, replyTo: me.email, subject: `Comment on RFQ ${r.no}` + (r.fields['q-co'] ? ` – ${r.fields['q-co']}` : ''),
              text: `${me.full || me.name} wrote on RFQ ${r.no} (${r.burner.brand} ${r.burner.name}):\n\n${text}\n\nOpen the RFQ in the Burner Matrix to reply.` }); mailed = out.to; }
          catch (e) { console.error('Mail:', e.message); mailError = e.message; }
        }
      }
      return send(res, 200, { comments: r.comments, mailed, mailError });
    }
    if (rm[2] === '/comments' && m === 'DELETE') {
      const b = (await readBody(req, 1024)) || {}; reloadRfq(r); const i = (r.comments || []).findIndex(c => c.id === b.id);
      if (i < 0) return send(res, 404, { error: 'Comment not found' });
      if (r.comments[i].by !== me.name && me.role !== 'admin') return send(res, 403, { error: 'You can only delete your own comments' });
      r.comments.splice(i, 1); writeJSON(rfqFile(r.id), r); return send(res, 200, { comments: r.comments });
    }
    if (rm[2] === '/send' && m === 'POST') {
      if (!Mail.configured()) return send(res, 503, { error: 'Email is not set up on the server yet (SMTP settings)' });
      const REQ = { 'q-co': 'Company', 'q-ct': 'Contact', 'q-ph': 'Phone', 'q-v': 'Voltage', 'q-m': 'Firing mode', 'q-mount': 'Mounting' };
      const miss = Object.keys(REQ).filter(k => !String(r.fields[k] || '').trim());
      if (miss.length) { const n = miss.map(k => REQ[k]); return send(res, 422, { error: `Fill in ${n.length < 2 ? n[0] : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]} before emailing.` }); }
      const b = await readBody(req, 8192);
      const to = Mail.splitList(b.to || rfqTo());
      if (!to.length || !to.every(Mail.isEmail) || to.length > 10) return send(res, 422, { error: 'Enter valid email address(es)' });
      const cc = b.ccMe && Mail.isEmail(me.email) ? [me.email] : [];
      let pdf, out;
      try { pdf = await rfqPdf(r, me); } catch (e) { console.error('PDF:', e.message); return send(res, 502, { error: 'Could not build the PDF: ' + e.message }); }
      const subj = `RFQ ${r.no} – ${r.burner.brand} ${r.burner.name}` + (r.fields['q-co'] ? ` – ${r.fields['q-co']}` : '') + (r.fields['q-job'] ? ` – ${r.fields['q-job']}` : '');
      try { out = await Mail.sendMail({ to, cc, replyTo: r.fields['q-repe'] || me.email, subject: subj, text: rfqText(r),
        attachments: [{ filename: pdfName(r), type: 'application/pdf', content: pdf }] }); }
      catch (e) { console.error('Mail:', e.message); return send(res, 502, { error: 'Email failed: ' + e.message }); }
      reloadRfq(r); // building the PDF and sending take a few seconds
      const firstSend = !(r.sends || []).length;
      (r.sends = r.sends || []).push({ at: new Date().toISOString(), by: me.name, to: out.to, cc: out.cc });
      writeJSON(rfqFile(r.id), r);
      if (firstSend) notify(quoters().filter(n => n !== me.name), { title: 'New RFQ to quote', tag: 'n-' + r.id, url: '/?rfq=' + r.id,
        body: `${r.no} – ${r.burner.brand} ${r.burner.name}${r.fields['q-co'] ? ' for ' + r.fields['q-co'] : ''} (from ${me.full || me.name})` });
      return send(res, 200, { ok: true, ...out });
    }
    if (!rm[2] && m === 'DELETE') { // admins can delete any RFQ; anyone else only their own drafts that were never emailed
      if (me.role !== 'admin') {
        if (r.by !== me.name) return send(res, 403, { error: 'Only the person who made it (or an admin) can delete it' });
        if ((r.sends || []).length) return send(res, 409, { error: 'Emailed RFQs can only be deleted by an admin' });
      }
      if (r.quote && r.quote.file) fs.rmSync(path.join(F.quotes, path.basename(r.quote.file)), { force: true });
      fs.unlinkSync(rfqFile(r.id)); act(`Deleted RFQ ${r.no}${(r.sends || []).length ? ' (emailed)' : ''}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Not allowed' });
  }
  if (p === '/api/profile' && m === 'POST') { // anyone can update their own name / phone / email
    contact(me, await readBody(req, 4096)); saveUsers(); return send(res, 200, meInfo(me));
  }
  if (p === '/api/burners' && m === 'GET') return send(res, 200, getBurners());
  if (p === '/api/xref' && m === 'GET') return send(res, 200, getXref());
  if (p === '/api/specs/search' && m === 'GET') { // appliance spec lookup for everyone
    const q = String(url.searchParams.get('q') || '').slice(0, 100), hits = SPECS.search(q, 120);
    return send(res, 200, { guides: SPECS.sets().map(Specs.title), suggest: hits.length ? [] : SPECS.suggest(q), hits: hits.map(({ set, row }) => { const r = set.roles, v = row.v;
      return { brand: set.brand, guide: Specs.title(set), gid: set.id, id: row.id, mfg: v[r.mfg], model: v[r.model], burner: Specs.burnerOf(set, row), rate: r.rate >= 0 && parseFloat(v[r.rate]) > 0 ? v[r.rate] : '',
        rateCol: r.rate >= 0 ? set.cols[r.rate] : '', unit: set.rateUnit || '',
        f: set.cols.map((c, i) => [c, v[i]]).filter(([, x]) => x && x !== '0' && x !== '-').concat(r.burner < 0 && set.burner ? [['Burner', set.burner]] : []) }; }) });  }
  if (p === '/api/specs/miss' && m === 'POST') { // any signed-in user: an appliance lookup that found no spec
    const b = (await readBody(req, 1024)) || {}, q = String(b.q || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80), k = Specs.norm(q);
    if (k.length < 2 || SPECS.search(q, 1).length) return send(res, 200, { ok: true });
    const mm = getSMiss(), now = new Date().toISOString(), e = mm[k] || { q, n: 0, users: [], first: now };
    e.q = q; e.n++; e.last = now; delete e.dismissed; if (!e.users.includes(me.name)) e.users = [...e.users, me.name].slice(-20); mm[k] = e;
    const keys = Object.keys(mm); if (keys.length > 500) keys.sort((a, c) => String(mm[a].last).localeCompare(String(mm[c].last))).slice(0, keys.length - 500).forEach(x => delete mm[x]);
    writeJSON(F.smiss, mm); return send(res, 200, { ok: true });
  }
  if (p === '/api/burners/sheet.pdf' && m === 'GET') { // one-page spec sheet for a burner, to send to a contractor
    const k = String(url.searchParams.get('k') || '').toLowerCase(), b = getBurners().find(x => keyOf(x) === k);
    if (!b) return send(res, 404, { error: 'No such burner' });
    let pdf; try { pdf = await renderPDF({ url: `http://127.0.0.1:${PORT}/?sheet=${encodeURIComponent(k)}&pdf=1`, cookie: { name: 'bm_s', value: makeToken(me.name, me.ver || 0, 120e3) } }); }
    catch (e) { console.error('PDF:', e.message); return send(res, 502, { error: 'Could not build the PDF: ' + e.message }); }
    return send(res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="${(b.brand + '-' + b.name + '-spec-sheet.pdf').replace(/[^A-Za-z0-9._-]+/g, '-')}"` });
  }
  if (p === '/api/xref/miss' && m === 'POST') { // any signed-in user: a lookup that matched nothing
    const b = (await readBody(req, 1024)) || {}, q = String(b.q || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80), k = xnorm(q);
    if (k.length < 2 || xrefMatches(q, getXref())) return send(res, 200, { ok: true });
    const mm = getMisses(), now = new Date().toISOString(), e = mm[k] || { q, n: 0, users: [], first: now };
    e.q = q; e.n++; e.last = now; delete e.dismissed; if (!e.users.includes(me.name)) e.users = [...e.users, me.name].slice(-20); mm[k] = e;
    const keys = Object.keys(mm); if (keys.length > 500) keys.sort((a, c) => String(mm[a].last).localeCompare(String(mm[c].last))).slice(0, keys.length - 500).forEach(x => delete mm[x]);
    writeJSON(F.xmiss, mm); return send(res, 200, { ok: true });
  }

  if (!canEditData(me) && p !== '/api/password') return send(res, 403, { error: me.role === 'quoter' ? 'Quoters can’t change burner data' : 'Your account can view the matrix only' });
  if (p === '/api/activity' && m === 'GET') { // who changed what, newest first
    const q = String(url.searchParams.get('q') || '').toLowerCase().trim(), who = url.searchParams.get('who') || '', names = new Map(users.map(u => [u.name, u.full || u.name]));
    const all = readAct().reverse(), list = all.filter(a => (!who || a.by === who) && (!q || (a.t + ' ' + (names.get(a.by) || a.by)).toLowerCase().includes(q)));
    return send(res, 200, { total: all.length, people: [...new Set(all.map(a => a.by))].map(n => ({ name: n, full: names.get(n) || n })), rows: list.slice(0, 300).map(a => ({ ...a, byFull: names.get(a.by) || a.by })) });
  }
  if (p === '/api/data-check' && m === 'GET') return send(res, 200, dataCheck());
  if (p === '/api/xref/misses' && m === 'GET') { // still-unmatched searches, most asked first
    const xs = getXref(), names = new Map(users.map(u => [u.name, u.full || u.name]));
    return send(res, 200, Object.entries(getMisses()).filter(([, e]) => !e.dismissed && !xrefMatches(e.q, xs))
      .map(([k, e]) => ({ k, q: e.q, n: e.n, last: e.last, first: e.first, users: e.users.map(u => names.get(u) || u) }))
      .sort((a, c) => c.n - a.n || String(c.last).localeCompare(String(a.last))));
  }
  if (p === '/api/xref/misses' && m === 'DELETE') { // dismiss one (it stays dismissed unless searched again later)
    const b = (await readBody(req, 1024)) || {}, mm = getMisses();
    if (!mm[b.k]) return send(res, 404, { error: 'Not found' });
    mm[b.k].dismissed = true; mm[b.k].n = 0; writeJSON(F.xmiss, mm); return send(res, 200, { ok: true });
  }
  const xm = /^\/api\/xref(?:\/([a-f0-9]{10}))?$/.exec(p);
  if (xm && m !== 'GET') { // editors and admins keep the cross-reference list
    const body = m === 'DELETE' ? {} : (await readBody(req, 16 * 1024)) || {}, list = getXref(), now = new Date().toISOString();
    if (m === 'POST' && !xm[1]) {
      const v = cleanXref(body); if (v.error) return send(res, 422, v);
      const ex = list.find(x => xrefKey(x) === xrefKey(v));
      if (ex) return send(res, 409, { error: `${ex.brand} ${ex.model} is already in the list.` });
      const x = { id: crypto.randomBytes(5).toString('hex'), ...v, by: me.name, added: now, updated: now };
      list.push(x); writeJSON(F.xref, list, true); act(`Added cross-reference ${x.brand} ${x.model}`); return send(res, 201, x);
    }
    const i = xm[1] ? list.findIndex(x => x.id === xm[1]) : -1;
    if (i < 0) return send(res, 404, { error: 'Not found' });
    if (m === 'PUT') {
      const v = cleanXref(body); if (v.error) return send(res, 422, v);
      const ex = list.find((x, j) => j !== i && xrefKey(x) === xrefKey(v));
      if (ex) return send(res, 409, { error: `${ex.brand} ${ex.model} is already in the list.` });
      list[i] = { ...list[i], ...v, updated: now, updatedBy: me.name }; writeJSON(F.xref, list, true); act(`Edited cross-reference ${list[i].brand} ${list[i].model}`); return send(res, 200, list[i]);
    }
    if (m === 'DELETE') { act(`Deleted cross-reference ${list[i].brand} ${list[i].model}`); list.splice(i, 1); writeJSON(F.xref, list, true); return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (p === '/api/burners' && m === 'PUT') { // save one burner (add or replace); body {original?:key, burner}
    const { original, burner } = await readBody(req);
    const list = getBurners();
    const i = original ? list.findIndex(b => keyOf(b) === String(original).toLowerCase()) : -1;
    if (original && i < 0) return send(res, 409, { error: 'That burner was changed or removed by someone else. Reload and try again.' });
    const errs = Schema.check(burner);
    if (errs.length) return send(res, 422, { errors: errs });
    const dup = list.findIndex(b => keyOf(b) === keyOf(burner));
    if (dup >= 0 && dup !== i) return send(res, 422, { errors: [`${burner.brand} ${burner.name} already exists`] });
    if (i >= 0) list[i] = burner; else list.push(burner);
    const e = saveBurners(list, me.name, (i >= 0 ? 'Edited ' : 'Added ') + burner.brand + ' ' + burner.name); if (!e) act((i >= 0 ? 'Edited burner ' : 'Added burner ') + burner.brand + ' ' + burner.name);
    if (!e && i >= 0 && keyOf(burner) !== String(original).toLowerCase()) { // renamed: keep cross-references pointing at it
      const xs = getXref(), ok = String(original).toLowerCase(), nk = keyOf(burner); let ch = false;
      for (const x of xs) if (x.to.includes(ok)) { x.to = [...new Set(x.to.map(k => k === ok ? nk : k))]; ch = true; }
      if (ch) writeJSON(F.xref, xs, true);
    }
    if (!e && /^https?:/i.test(burner.image || '')) setTimeout(() => localizePhotos(me.name).catch(() => {}), 100);
    return e ? send(res, 422, { errors: e }) : send(res, 200, { ok: true });
  }
  if (p === '/api/burners' && m === 'DELETE') {
    const { key } = await readBody(req, 4096);
    const list = getBurners(); const i = list.findIndex(b => keyOf(b) === String(key).toLowerCase());
    if (i < 0) return send(res, 404, { error: 'Not found' });
    const [gone] = list.splice(i, 1);
    saveBurners(list, me.name, 'Deleted ' + gone.brand + ' ' + gone.name); act('Deleted burner ' + gone.brand + ' ' + gone.name);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/history' && m === 'GET') {
    const out = fs.readdirSync(F.history).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 100).map(f => {
      const h = readJSON(path.join(F.history, f), {}); return { id: f.replace(/\.json$/, ''), at: h.at, by: h.by, action: h.action };
    });
    return send(res, 200, out);
  }
  if (p === '/api/restore' && m === 'POST') { // restores the list as it was BEFORE the chosen change
    const { id } = await readBody(req, 4096);
    if (!/^[\w-]+$/.test(String(id))) return send(res, 400, { error: 'Bad id' });
    const h = readJSON(path.join(F.history, id + '.json'), null);
    if (!h) return send(res, 404, { error: 'Not found' });
    const e = saveBurners(h.burners, me.name, `Undid "${h.action}" (${h.at.slice(0, 16).replace('T', ' ')})`); if (!e) act(`Undid burner change "${h.action}"`);
    return e ? send(res, 422, { errors: e }) : send(res, 200, { ok: true });
  }
  if (p === '/api/photos/localize' && m === 'POST') return send(res, 200, await localizePhotos(me.name));
  if (p === '/api/photo' && m === 'POST') { // {name, data: dataURL}
    const { name = '', data = '' } = await readBody(req);
    const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(data);
    if (!mm) return send(res, 400, { error: 'Photo must be a JPG, PNG or WebP' });
    const buf = Buffer.from(mm[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) return send(res, 413, { error: 'Photo is over 4 MB' });
    const base = String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'photo';
    const file = `${base}-${Date.now().toString(36)}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`;
    fs.writeFileSync(path.join(F.photos, file), buf);
    return send(res, 200, { path: 'photos/' + file });
  }
  if (p === '/api/password' && m === 'POST') {
    const { current = '', next = '' } = await readBody(req, 4096);
    if (!checkPw(String(current), me.hash)) return send(res, 401, { error: 'Current password is wrong' });
    if (String(next).length < 8) return send(res, 422, { error: 'New password must be at least 8 characters' });
    me.hash = hashPw(String(next)); me.ver = (me.ver || 0) + 1; saveUsers();
    // keep the same kind of session (a "keep me signed in" session stays long)
    let life = SESSION_HOURS * 3600;
    try { const t = /(?:^|;\s*)bm_s=([^;.]+)/.exec(req.headers.cookie || ''); const e = JSON.parse(Buffer.from(t[1], 'base64url').toString()).e;
      if (e - Date.now() > SESSION_HOURS * 3600e3) life = REMEMBER_DAYS * 86400; } catch {}
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie(makeToken(me.name, me.ver, life * 1000), life) });
  }

  // ----- admin-only: appliance spec guides -----
  if (p.startsWith('/api/specs')) {
    if (me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    const okStr = (b, n) => typeof b === 'string' && b.trim() && b.trim().length <= n;
    const meta = s => ({ id: s.id, brand: s.brand, name: s.name || '', title: Specs.title(s), count: s.rows.length, cols: s.cols, roles: s.roles, burner: s.burner || '', rateUnit: s.rateUnit || '', updated: s.updated, by: s.by, hasPrevious: SPECS.hasPrevious(s.id) });
    if (p === '/api/specs' && m === 'GET') return send(res, 200, SPECS.sets().map(meta).concat(SPECS.removed().map(r => ({ id: r.id, brand: r.brand, name: r.name, title: Specs.title(r), count: 0, removed: true, prevCount: r.count, hasPrevious: true }))));
    if (p === '/api/specs/import' && m === 'POST') { // one file = one guide; a guide with the same brand + name is replaced (and kept for Restore)
      const b = (await readBody(req, 25 * 1024 * 1024)) || {};
      if (!okStr(b.brand, 40)) return send(res, 422, { error: 'Pick the brand these specs are for' });
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 40) : Specs.guideName(b.file);
      const out = SPECS.importCSV(b.brand.trim(), name, String(b.csv || ''), me.name, typeof b.burner === 'string' ? b.burner : '', b.dryRun === true);
      if (out.error) return send(res, 422, { error: out.error, needBurner: !!out.needBurner });
      const m = b.dryRun === true ? { id: out.set.id, title: Specs.title(out.set), count: out.set.rows.length } : meta(out.set);
      if (b.dryRun !== true) act(`Loaded the ${Specs.title(out.set)} spec guide (${out.set.rows.length} specs${out.diff ? `: ${out.diff.added} added, ${out.diff.removed} removed, ${out.diff.changed} changed` : ''})`);
      return send(res, 200, { ...m, dryRun: b.dryRun === true, skipped: out.skipped, warnings: out.warnings, diff: out.diff, kept: out.kept, replaces: out.replaces });
    }
    const one = id => SPECS.get(String(id || ''));
    if (p === '/api/specs/export' && m === 'GET') {
      const s = one(url.searchParams.get('id')); if (!s) return send(res, 404, { error: 'No such spec guide' });
      return send(res, 200, Specs.toCSV(s.cols, s.rows.map(r => r.v)), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${s.id}-specs.csv"` });
    }
    if (p === '/api/specs/restore' && m === 'POST') { const b = (await readBody(req, 1024)) || {}; act(`Restored the previous version of spec guide ${String(b.id || '')}`); return SPECS.restorePrevious(String(b.id || '')) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No previous version to restore' }); }
    if (p === '/api/specs' && m === 'DELETE') { const b = (await readBody(req, 1024)) || {}; if (!one(b.id)) return send(res, 404, { error: 'No such spec guide' }); act(`Removed the ${Specs.title(one(b.id))} spec guide`); SPECS.remove(b.id); return send(res, 200, { ok: true }); }
    if (p === '/api/specs/rows' && m === 'GET') { // find rows to edit
      const s = one(url.searchParams.get('id')); if (!s) return send(res, 404, { error: 'No such spec guide' });
      const q = String(url.searchParams.get('q') || '').slice(0, 100), hits = q ? SPECS.search(q, 200, s).map(h => h.row) : s.rows.slice(0, 50);
      return send(res, 200, { cols: s.cols, roles: s.roles, burner: s.burner || '', total: s.rows.length, rows: hits.slice(0, 100) });
    }
    if (p === '/api/specs/misses' && m === 'GET') { // appliance lookups that found nothing, most asked first (drop off once a spec matches)
      const names = new Map(users.map(u => [u.name, u.full || u.name]));
      return send(res, 200, Object.entries(getSMiss()).filter(([, e]) => !e.dismissed && !SPECS.search(e.q, 1).length)
        .map(([k, e]) => ({ k, q: e.q, n: e.n, last: e.last, users: e.users.map(u => names.get(u) || u) })).sort((a, c) => c.n - a.n || String(c.last).localeCompare(String(a.last))));
    }
    if (p === '/api/specs/misses' && m === 'DELETE') { const b = (await readBody(req, 1024)) || {}, mm = getSMiss(); if (!mm[b.k]) return send(res, 404, { error: 'Not found' }); mm[b.k].dismissed = true; mm[b.k].n = 0; writeJSON(F.smiss, mm); return send(res, 200, { ok: true }); }
    if (p === '/api/specs/review' && m === 'GET') { // spec links that still need a person to look at them
      const s = one(url.searchParams.get('id')); if (!s) return send(res, 404, { error: 'No such spec guide' });
      const ix = n => s.cols.findIndex(c => c.toLowerCase() === n), cS = ix('beckett spec'), cM = ix('spec match'), cP = ix('possible specs'), cW = ix('matched on');
      if (cM < 0) return send(res, 200, { linked: false, counts: {}, rows: [] });
      const kind = url.searchParams.get('kind') || 'likely', counts = { likely: 0, possible: 0, confirmed: 0, rejected: 0, sure: 0 }, out = [];
      const r = s.roles, val = (row, i) => i >= 0 ? row.v[i] || '' : '';
      for (const row of s.rows) {
        const mt = val(row, cM).toLowerCase(), k = /^confirmed/.test(mt) ? 'confirmed' : /^rejected/.test(mt) ? 'rejected' : /^medium/.test(mt) ? 'likely' : /^high/.test(mt) ? 'sure' : val(row, cP) ? 'possible' : '';
        if (!k) continue; counts[k]++;
        if (k === kind && out.length < 400) out.push({ id: row.id, mfg: row.v[r.mfg], model: row.v[r.model], burner: Specs.burnerOf(s, row), rate: r.rate >= 0 ? row.v[r.rate] : '',
          spec: val(row, cS), possible: val(row, cP).split(/\s*,\s*/).filter(Boolean), why: val(row, cW),
          f: s.cols.map((c, i) => [c, row.v[i]]).filter(([c, x]) => x && x !== '0' && x !== '-' && !/^(beckett spec|spec match|possible specs|matched on|note|updated date|date modified|see note|proj no)$/i.test(c) && ![r.mfg, r.model].includes(s.cols.indexOf(c))) });
      }
      return send(res, 200, { linked: true, counts, unit: s.rateUnit || '', rows: out });
    }
    if (p === '/api/specs/review' && m === 'POST') { // confirm or reject one appliance's spec link; kept when the guide is loaded again
      const b = (await readBody(req, 4096)) || {}, s = one(b.guide); if (!s) return send(res, 404, { error: 'No such spec guide' });
      const i = s.rows.findIndex(x => x.id === b.id); if (i < 0) return send(res, 404, { error: 'That spec was changed or removed. Reload the list.' });
      if (!['confirm', 'reject', 'undo'].includes(b.action)) return send(res, 422, { error: 'Unknown action' });
      const spec = String(b.spec || '').trim().toUpperCase().slice(0, 40);
      if (b.action === 'confirm' && !/^[A-Z0-9-]{2,40}$/.test(spec)) return send(res, 422, { error: 'Give the spec number to confirm' });
      const cur = { ...s, cols: s.cols.slice(), rows: s.rows.map(x => ({ ...x, v: x.v.slice() })), updated: new Date().toISOString(), by: me.name };
      const L = SPECS.linkCols(cur), row = cur.rows[i];
      if (b.action === 'confirm') { row.v[L.spec] = spec; row.v[L.match] = 'Confirmed'; }
      else if (b.action === 'reject') { // the rejected spec stays at the front of Possible Specs, so Undo can bring it back
        const was = row.v[L.spec] || spec, ps = String(row.v[L.poss] || '').split(/\s*,\s*/).filter(x => x && x !== was);
        if (was) row.v[L.poss] = [was, ...ps].join(', '); row.v[L.spec] = ''; row.v[L.match] = 'Rejected'; }
      else { row.v[L.match] = row.v[L.spec] ? 'Medium' : ''; }
      act(`${{ confirm: 'Confirmed spec ' + spec + ' for', reject: 'Rejected the spec link for', undo: 'Reopened the spec link for' }[b.action]} ${row.v[s.roles.mfg]} ${row.v[s.roles.model]} (${Specs.title(s)})`);
      SPECS.save(cur); return send(res, 200, { ok: true, spec: row.v[L.spec], match: row.v[L.match] });
    }
    if (p === '/api/specs/row' && (m === 'POST' || m === 'DELETE')) { // add / change / delete one spec
      const b = (await readBody(req, 64 * 1024)) || {}, s = one(b.guide); if (!s) return send(res, 404, { error: 'No such spec guide' });
      const i = b.id ? s.rows.findIndex(r => r.id === b.id) : -1;
      if (b.id && i < 0) return send(res, 404, { error: 'That spec was changed or removed. Search again.' });
      const cur = { ...s, rows: s.rows.slice(), updated: new Date().toISOString(), by: me.name };
      if (m === 'DELETE') { act(`Deleted spec ${s.rows[i].v[s.roles.mfg]} ${s.rows[i].v[s.roles.model]} from ${Specs.title(s)}`); cur.rows.splice(i, 1); SPECS.save(cur); return send(res, 200, { ok: true, count: cur.rows.length }); }
      const v = s.cols.map((_, k) => String(Array.isArray(b.v) && b.v[k] != null ? b.v[k] : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000));
      const need = ['mfg', 'model', 'burner'].filter(k => s.roles[k] >= 0 && !v[s.roles[k]]);
      if (need.length) return send(res, 422, { error: `Fill in ${need.map(k => s.cols[s.roles[k]]).join(', ')}.` });
      const row = { id: i >= 0 ? s.rows[i].id : Specs.rid(), v };
      if (i >= 0) cur.rows[i] = row; else cur.rows.unshift(row);
      act(`${i >= 0 ? 'Edited' : 'Added'} spec ${v[s.roles.mfg]} ${v[s.roles.model]} in ${Specs.title(s)}`); SPECS.save(cur); return send(res, 200, { ok: true, row, count: cur.rows.length });
    }
    return send(res, 404, { error: 'Not found' });
  }
  // ----- admin-only: settings -----
  if (p === '/api/settings') {
    if (me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    const info = () => { const c = Mail.config(), s = getSettings(); return { rfqTo: s.rfqTo || '', envRfqTo: RFQ_TO_ENV, effective: rfqTo(),
      mail: Mail.configured(), smtpHost: c.host, smtpFrom: c.from, followUpDays: followUpDays(), stepDownWarn: stepDownWarn(),
      lastBackup: s.lastBackup || null, backups: listBackups().slice(0, 5), backupKeep: BACKUP_KEEP, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }; };
    if (m === 'GET') return send(res, 200, info());
    if (m === 'PUT') {
      const b = await readBody(req, 4096), s = getSettings();
      if (b.rfqTo !== undefined) {
        const list = Mail.splitList(b.rfqTo);
        if (!list.every(Mail.isEmail)) return send(res, 422, { error: 'Enter valid email addresses, separated by commas' });
        if (list.length > 10) return send(res, 422, { error: 'Up to 10 addresses' });
        s.rfqTo = list.join(', ');
      }
      if (b.followUpDays !== undefined) {
        const d = Number(b.followUpDays);
        if (!Number.isInteger(d) || d < 0 || d > 90) return send(res, 422, { error: 'Follow-up days must be a whole number from 0 (off) to 90' });
        s.followUpDays = d;
      }
      if (b.stepDownWarn !== undefined) s.stepDownWarn = b.stepDownWarn === true;
      act('Changed settings');
      s.updated = new Date().toISOString(); s.updatedBy = me.name;
      writeJSON(F.settings, s);
      return send(res, 200, info());
    }
  }
  if (p === '/api/backup' && m === 'POST') {
    if (me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    try { const b = runBackup('manual, ' + me.name); return send(res, 200, b); }
    catch (e) { console.error('Backup failed:', e.message); return send(res, 500, { error: 'Backup failed: ' + e.message }); }
  }
  // ----- admin-only: users -----
  if (p.startsWith('/api/users')) {
    if (me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    if (m === 'GET') return send(res, 200, users.map(pub));
    const b = await readBody(req, 4096);
    const name = String(b.name || '').trim().toLowerCase();
    if (m === 'POST') {
      if (!validName(name)) return send(res, 422, { error: 'Username: an email address, or 2–32 letters, numbers, dot, dash or underscore' });
      if (users.some(u => u.name === name)) return send(res, 422, { error: 'That username exists' });
      if (String(b.password || '').length < 8) return send(res, 422, { error: 'Password must be at least 8 characters' });
      const nu = { name, role: normRole(b.role), hash: hashPw(String(b.password)), created: new Date().toISOString() }; contact(nu, b); if (!nu.email && Mail.isEmail(name)) nu.email = name; users.push(nu);
      saveUsers(); act(`Added user ${name} (${nu.role})`); return send(res, 200, { ok: true });
    }
    const u = users.find(x => x.name === name);
    if (!u) return send(res, 404, { error: 'No such user' });
    if (m === 'PATCH') {
      if (b.password !== undefined) { if (String(b.password).length < 8) return send(res, 422, { error: 'Password must be at least 8 characters' });
        u.hash = hashPw(String(b.password)); u.ver = (u.ver || 0) + 1; }
      if (b.role) { if (u.role === 'admin' && b.role !== 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 422, { error: 'Keep at least one admin' });
        u.role = normRole(b.role); }
      contact(u, b);
      saveUsers(); act(`Changed user ${u.name}${b.role ? ' (role ' + u.role + ')' : ''}${b.password !== undefined ? ' (password reset)' : ''}`); return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      if (u.name === me.name) return send(res, 422, { error: "You can't remove yourself" });
      if (u.role === 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 422, { error: 'Keep at least one admin' });
      users = users.filter(x => x !== u); saveUsers(); act(`Removed user ${u.name}`); writeJSON(F.push, getSubs().filter(s => s.user !== u.name)); return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

// ---------- routing ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p; try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
    if (p.startsWith('/api/')) { await api(req, res, url); if (req.act && res.statusCode < 400) logAct(req.act.by, req.act.t); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    // public bits: the sign-in page and what it needs
    if (p === '/login' || p === '/login/') return sendPage(res, path.join(HTML, 'login.html'));
    if (p === '/sw.js') return send(res, 200, SW_JS, 'text/javascript; charset=utf-8');
    if (p === '/manifest.webmanifest') return sendFile(res, path.join(HTML, 'manifest.webmanifest'), 'no-cache');
    if (p.startsWith('/icons/')) return sendFile(res, path.join(HTML, 'icons', path.basename(p)), 'public, max-age=86400');
    if (!(p === '/favicon.svg' || p.startsWith('/logos/'))) {
      const me = readSession(req);
      if (!me) {
        if (p === '/' || p === '/index.html' || p === '/admin' || p === '/admin/')
          return send(res, 302, '', 'text/plain', { Location: '/login' + (p.startsWith('/admin') ? '?next=admin' : '') });
        return send(res, 401, 'Sign in required', 'text/plain');
      }
      if (!canEditData(me) && p.startsWith('/admin')) return send(res, 302, '', 'text/plain', { Location: '/' });
    }
    if (p === '/burners.json') return sendFile(res, F.burners);
    if (p === '/admin/') return send(res, 302, '', 'text/plain', { Location: '/admin' }); // relative photo paths need /admin
    if (p === '/admin') return sendPage(res, path.join(HTML, 'admin.html'));
    if (p === '/' || p === '/index.html') return sendPage(res, path.join(HTML, 'index.html'));
    if (p.startsWith('/photos/')) { // uploaded photos first, then the ones shipped in the image
      const name = path.basename(p);
      const up = path.join(F.photos, name);
      return sendFile(res, fs.existsSync(up) ? up : path.join(HTML, 'photos', name), 'private, max-age=300');
    }
    const file = path.normalize(path.join(HTML, p === '/' ? 'index.html' : p));
    if (!file.startsWith(HTML + path.sep) || /\/\./.test(p) || p.endsWith('burners.json')) return send(res, 404, 'Not found', 'text/plain');
    return sendFile(res, file);
  } catch (e) {
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.code ? e.message : 'Server error' });
    if (!e.code) console.error(e);
  }
});
// one-time data updates for the live burner list (each runs once; recorded in settings.json and in History & undo)
function migrate() {
  const st = getSettings(), done = Array.isArray(st.migrations) ? st.migrations : [];
  if (!done.includes('oil-b20')) {
    const ORDER = ['#2', 'B20', 'B100', 'R100'], rank = x => ORDER.includes(x) ? ORDER.indexOf(x) : 9;
    const list = getBurners(); let n = 0;
    for (const b of list) if (b.fuel === 'oil') {
      const have = String(b.biofuel || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!have.includes('B20')) { have.push('B20'); n++; }
      b.biofuel = have.sort((a, c) => rank(a) - rank(c)).join(', ');
    }
    const err = n ? saveBurners(list, 'system', 'Added B20 fuel rating to all oil burners') : null;
    if (err) { console.warn('B20 update skipped:', err.join('; ')); return; }
    if (n) console.log(`Added B20 to ${n} oil burner(s)`);
    const s2 = getSettings(); s2.migrations = [...done, 'oil-b20']; writeJSON(F.settings, s2);
  }
}
try { migrate(); } catch (e) { console.error('Data update failed:', e.message); }
server.listen(PORT, () => {
  console.log(`Burner matrix on port ${PORT}, data in ${DATA}`);
  setTimeout(() => localizePhotos().catch(e => console.warn('Photo download failed:', e.message)), 3000);
  scheduleBackup();
  // missed the last 1:00 a.m. run (server was off)? take one shortly after start
  const lb = getSettings().lastBackup; if (!lb || Date.now() - Date.parse(lb.at) > 26 * 3600e3)
    setTimeout(() => { try { runBackup('catch-up after start'); } catch (e) { console.error('Backup failed:', e.message); } }, 60e3);
});
