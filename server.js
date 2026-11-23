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
};

// ---------- storage ----------
fs.mkdirSync(F.history, { recursive: true });
fs.mkdirSync(F.photos, { recursive: true });
fs.mkdirSync(F.rfqs, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v, pretty) => {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, pretty ? '[\n' + v.map(o => '  ' + JSON.stringify(o)).join(',\n') + '\n]\n' : JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
};
if (!fs.existsSync(F.burners)) fs.copyFileSync(path.join(HTML, 'burners.json'), F.burners);
if (!fs.existsSync(F.secret)) fs.writeFileSync(F.secret, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(F.secret, 'utf8').trim();

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
  req.on('end', () => { try { ok(n ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { bad(Object.assign(new Error('Bad JSON'), { code: 400 })); } });
  req.on('error', bad);
});
const ROLES = ['rep', 'editor', 'admin'];
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
const getRfq = id => /^[a-f0-9]{12}$/.test(id) ? readJSON(rfqFile(id), null) : null;
const allRfqs = () => fs.readdirSync(F.rfqs).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(F.rfqs, f), null)).filter(r => r && r.burner && r.fields);
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
const canSee = (me, r) => r && (me.role !== 'rep' || r.by === me.name);
const rfqSummary = r => ({ id: r.id, no: r.no, date: r.date, by: r.by, byFull: r.byFull, updated: r.updated,
  burner: `${r.burner.brand} ${r.burner.name}`, fuel: r.burner.fuel,
  company: r.fields['q-co'] || '', contact: r.fields['q-ct'] || '', job: r.fields['q-job'] || '',
  sent: (r.sends || []).slice(-1)[0] || null, status: r.status || '', statusAt: r.statusAt || '',
  value: typeof r.value === 'number' ? r.value : null, lostReason: r.status === 'lost' ? r.lostReason || '' : '', lostNote: r.status === 'lost' ? r.lostNote || '' : '',
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
  const meInfo = u => ({ ...pub(u), setup: true, mail: Mail.configured(), rfqTo: rfqTo(), followUpDays: followUpDays(), stepDownWarn: stepDownWarn(), lostReasons: LOST_REASONS });
  if (p === '/api/me') return me ? send(res, 200, meInfo(me)) : send(res, 401, { error: 'Not signed in', setup: users.length > 0 });
  if (!me) return send(res, 401, { error: 'Not signed in' });

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
    const list = allRfqs().filter(r => canSee(me, r)).map(rfqSummary).sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
    ].map(([header, width, type]) => ({ header, width, type }));
    const rows = all.map(r => { const s = rfqSummary(r), last = (r.sends || []).slice(-1)[0];
      const st = r.status || (last ? 'sent' : '');
      return [r.no, r.date, r.byFull || r.by, STL[st] || st, r.statusAt || '', s.value, s.lostReason, s.lostNote,
        s.followUp ? 'Yes' : '', st === 'sent' || st === 'quoted' ? s.idleDays : '', last ? last.at : '', last ? last.to.join(', ') : '',
        F_(r, 'q-co'), F_(r, 'q-ct'), F_(r, 'q-ph'), F_(r, 'q-em'), F_(r, 'q-job'), F_(r, 'q-addr'), F_(r, 'q-qty'), F_(r, 'q-need'), F_(r, 'q-po'),
        r.burner.brand, r.burner.name, r.burner.fuel, F_(r, 'q-app'), F_(r, 'q-type'), F_(r, 'q-rate'), F_(r, 'q-fuel'), F_(r, 'q-pwr'),
        F_(r, 'q-v'), F_(r, 'q-m'), F_(r, 'q-mount'), F_(r, 'q-tube'), F_(r, 'q-ins'), F_(r, 'q-ctl'), F_(r, 'q-opt'), F_(r, 'q-notes')]; });
    const name = `RFQs-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return send(res, 200, XLSX.build({ sheet: 'RFQs', cols, rows }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { 'Content-Disposition': `attachment; filename="${name}"` });
  }
  if (p === '/api/customers' && m === 'GET') { // address book + per-customer totals: saved customers + everyone's RFQs (newest details win)
    const by = new Map(), staff = me.role !== 'rep', saved = getCustomers();
    for (const r of allRfqs().sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
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
    list.splice(i, 1); saveCustomers(list); return send(res, 200, { ok: true });
  }
  if (p === '/api/customers/history' && m === 'GET') { // every RFQ for one customer; others' RFQs are summary-only for reps
    const k = custKey(url.searchParams.get('company'));
    if (!k) return send(res, 400, { error: 'Missing company' });
    const rows = allRfqs().filter(r => custKey(r.fields['q-co']) === k).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const sc = getCustomers().find(c => custKey(c.company) === k);
    if (!rows.length && !sc) return send(res, 404, { error: 'No such customer' });
    return send(res, 200, { company: rows.length ? String(rows[0].fields['q-co']).trim() : sc.company, rfqs: rows.map(r => canSee(me, r) ? { ...rfqSummary(r), open: true } : limitedRfq(r)) });
  }
  if (p === '/api/customers/recent' && m === 'GET') { // for the duplicate warning: same customer in the last 90 days
    const k = custKey(url.searchParams.get('company')), skip = url.searchParams.get('exclude') || '', since = Date.now() - 90 * 864e5;
    if (!k) return send(res, 200, []);
    return send(res, 200, allRfqs().filter(r => r.id !== skip && custKey(r.fields['q-co']) === k && Date.parse(r.date) >= since)
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
    writeJSON(rfqFile(r.id), r);
    return send(res, 200, r);
  }
  const rm = /^\/api\/rfqs\/([a-f0-9]{12})(\/pdf|\/send|\/status|\/followup)?$/.exec(p);
  if (rm) {
    const r = getRfq(rm[1]);
    if (!canSee(me, r)) return send(res, 404, { error: 'RFQ not found' });
    if (!rm[2] && m === 'GET') return send(res, 200, r);
    if (!rm[2] && m === 'PUT') {
      // A draft can be changed by the rep who made it until it's emailed. After that it's a record:
      // it opens read-only, and "Copy to new RFQ" starts a revision.
      if ((r.sends || []).length) return send(res, 409, { error: 'This RFQ was emailed, so it can’t be changed. Use “Copy to new RFQ” to make a revised one.' });
      if (r.by !== me.name) return send(res, 403, { error: 'Only the rep who made this RFQ can change it.' });
      const b = await readBody(req, 512 * 1024);
      r.fields = cleanFields(b.fields); r.updated = new Date().toISOString(); r.editedBy = me.name;
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, r);
    }
    if (rm[2] === '/status' && m === 'POST') { // quoted / won / lost tracking; '' = automatic (draft or emailed)
      if (r.by !== me.name && me.role === 'rep') return send(res, 403, { error: 'Only the rep who made it can change its status' });
      const b = await readBody(req, 4096), status = b.status || '';
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
      (r.statusLog = r.statusLog || []).push({ at: r.statusAt, by: me.name, status, value: r.value, lostReason: r.lostReason });
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, rfqSummary(r));
    }
    if (rm[2] === '/followup' && m === 'POST') { // "I followed up": restarts the follow-up clock
      if (r.by !== me.name && me.role === 'rep') return send(res, 403, { error: 'Only the rep who made it can do this' });
      r.followedUpAt = new Date().toISOString();
      (r.followLog = r.followLog || []).push({ at: r.followedUpAt, by: me.name });
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, rfqSummary(r));
    }
    if (rm[2] === '/pdf' && m === 'GET') {
      let pdf; try { pdf = await rfqPdf(r, me); } catch (e) { console.error('PDF:', e.message); return send(res, 502, { error: 'Could not build the PDF: ' + e.message }); }
      return send(res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="${pdfName(r)}"` });
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
      (r.sends = r.sends || []).push({ at: new Date().toISOString(), by: me.name, to: out.to, cc: out.cc });
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, { ok: true, ...out });
    }
    if (!rm[2] && m === 'DELETE') { // admins can delete any RFQ; anyone else only their own drafts that were never emailed
      if (me.role !== 'admin') {
        if (r.by !== me.name) return send(res, 403, { error: 'Only the person who made it (or an admin) can delete it' });
        if ((r.sends || []).length) return send(res, 409, { error: 'Emailed RFQs can only be deleted by an admin' });
      }
      fs.unlinkSync(rfqFile(r.id));
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Not allowed' });
  }
  if (p === '/api/profile' && m === 'POST') { // anyone can update their own name / phone / email
    contact(me, await readBody(req, 4096)); saveUsers(); return send(res, 200, meInfo(me));
  }
  if (p === '/api/burners' && m === 'GET') return send(res, 200, getBurners());

  if (me.role === 'rep' && p !== '/api/password') return send(res, 403, { error: 'Your account can view the matrix only' });
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
    const e = saveBurners(list, me.name, (i >= 0 ? 'Edited ' : 'Added ') + burner.brand + ' ' + burner.name);
    if (!e && /^https?:/i.test(burner.image || '')) setTimeout(() => localizePhotos(me.name).catch(() => {}), 100);
    return e ? send(res, 422, { errors: e }) : send(res, 200, { ok: true });
  }
  if (p === '/api/burners' && m === 'DELETE') {
    const { key } = await readBody(req, 4096);
    const list = getBurners(); const i = list.findIndex(b => keyOf(b) === String(key).toLowerCase());
    if (i < 0) return send(res, 404, { error: 'Not found' });
    const [gone] = list.splice(i, 1);
    saveBurners(list, me.name, 'Deleted ' + gone.brand + ' ' + gone.name);
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
    const e = saveBurners(h.burners, me.name, `Undid "${h.action}" (${h.at.slice(0, 16).replace('T', ' ')})`);
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
      saveUsers(); return send(res, 200, { ok: true });
    }
    const u = users.find(x => x.name === name);
    if (!u) return send(res, 404, { error: 'No such user' });
    if (m === 'PATCH') {
      if (b.password !== undefined) { if (String(b.password).length < 8) return send(res, 422, { error: 'Password must be at least 8 characters' });
        u.hash = hashPw(String(b.password)); u.ver = (u.ver || 0) + 1; }
      if (b.role) { if (u.role === 'admin' && b.role !== 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 422, { error: 'Keep at least one admin' });
        u.role = normRole(b.role); }
      contact(u, b);
      saveUsers(); return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      if (u.name === me.name) return send(res, 422, { error: "You can't remove yourself" });
      if (u.role === 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 422, { error: 'Keep at least one admin' });
      users = users.filter(x => x !== u); saveUsers(); return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

// ---------- routing ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p; try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
    if (p.startsWith('/api/')) return await api(req, res, url);
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
      if (me.role === 'rep' && p.startsWith('/admin')) return send(res, 302, '', 'text/plain', { Location: '/' });
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
