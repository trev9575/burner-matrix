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

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || '/data';
const HTML = path.join(__dirname, 'html');
const COOKIE_SECURE = /^true$/i.test(process.env.COOKIE_SECURE || '');
const TRUST_PROXY = /^true$/i.test(process.env.TRUST_PROXY || '');
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;
const HISTORY_KEEP = 200;
const RFQ_TO = process.env.RFQ_TO || '';   // default "send to" address(es) for RFQ PDFs

const F = {
  burners: path.join(DATA, 'burners.json'),
  users: path.join(DATA, 'users.json'),
  secret: path.join(DATA, '.secret'),
  history: path.join(DATA, 'history'),
  photos: path.join(DATA, 'photos'),
  rfqs: path.join(DATA, 'rfqs'),
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
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
// HTML pages get versioned script/style links so browsers never use a stale copy after an update.
const VERSIONED = ['schema.js', 'favicon.svg'];
const ver = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(HTML, f))).digest('hex').slice(0, 10); } catch { return '0'; } };
const VER = Object.fromEntries(VERSIONED.map(f => [f, ver(f)]));
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

// ---------- RFQs ----------
const rfqFile = id => path.join(F.rfqs, id + '.json');
const getRfq = id => /^[a-f0-9]{12}$/.test(id) ? readJSON(rfqFile(id), null) : null;
const canSee = (me, r) => r && (me.role !== 'rep' || r.by === me.name);
const rfqSummary = r => ({ id: r.id, no: r.no, date: r.date, by: r.by, byFull: r.byFull, updated: r.updated,
  burner: `${r.burner.brand} ${r.burner.name}`, fuel: r.burner.fuel,
  company: r.fields['q-co'] || '', contact: r.fields['q-ct'] || '', job: r.fields['q-job'] || '',
  sent: (r.sends || []).slice(-1)[0] || null, status: r.status || '', statusAt: r.statusAt || '' });
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
    const { name = '', password = '' } = await readBody(req, 4096);
    const u = users.find(x => x.name === String(name).trim().toLowerCase());
    if (!u || !checkPw(String(password), u.hash)) { failed(ip); return send(res, 401, { error: 'Wrong username or password' }); }
    attempts.delete(ip);
    return send(res, 200, { name: u.name, role: u.role }, undefined, { 'Set-Cookie': cookie(makeToken(u.name, u.ver || 0), SESSION_HOURS * 3600) });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('', 0) });

  const me = readSession(req);
  const meInfo = u => ({ ...pub(u), setup: true, mail: Mail.configured(), rfqTo: RFQ_TO });
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
    const list = fs.readdirSync(F.rfqs).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(F.rfqs, f), null))
      .filter(r => r && canSee(me, r)).map(rfqSummary).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return send(res, 200, list);
  }
  if (p === '/api/rfqs' && m === 'POST') { // create
    const b = await readBody(req, 512 * 1024);
    const burner = b.burner && typeof b.burner === 'object' ? b.burner : null;
    if (!burner || Schema.check(burner).length) return send(res, 422, { error: 'Missing or invalid burner' });
    const no = String(b.no || '').slice(0, 40);
    if (!/^[0-9A-Za-z-]{6,40}$/.test(no)) return send(res, 422, { error: 'Bad RFQ number' });
    const now = new Date().toISOString();
    const r = { id: crypto.randomBytes(6).toString('hex'), no, date: now, updated: now, by: me.name, byFull: me.full || '',
      burner, fit: ['ok', 'min', 'max', 'out'].includes(b.fit) ? b.fit : '', fields: cleanFields(b.fields), sends: [] };
    writeJSON(rfqFile(r.id), r);
    return send(res, 200, r);
  }
  const rm = /^\/api\/rfqs\/([a-f0-9]{12})(\/pdf|\/send|\/status)?$/.exec(p);
  if (rm) {
    const r = getRfq(rm[1]);
    if (!canSee(me, r)) return send(res, 404, { error: 'RFQ not found' });
    if (!rm[2] && m === 'GET') return send(res, 200, r);
    if (!rm[2] && m === 'PUT') {
      // Only the person drafting it can change an RFQ, and only before it's emailed and within 2 hours of creating it.
      // After that it's a record: reopen shows it read-only, and "Copy to new RFQ" starts a revision.
      if (r.by !== me.name || (r.sends || []).length || Date.now() - Date.parse(r.date) > 2 * 3600e3)
        return send(res, 409, { error: 'This RFQ is locked. Use “Copy to new RFQ” to make a revised one.' });
      const b = await readBody(req, 512 * 1024);
      r.fields = cleanFields(b.fields); r.updated = new Date().toISOString(); r.editedBy = me.name;
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, r);
    }
    if (rm[2] === '/status' && m === 'POST') { // quoted / won / lost tracking; '' = automatic (draft or emailed)
      if (r.by !== me.name && me.role === 'rep') return send(res, 403, { error: 'Only the rep who made it can change its status' });
      const { status = '' } = await readBody(req, 1024);
      if (!['', 'quoted', 'won', 'lost'].includes(status)) return send(res, 422, { error: 'Unknown status' });
      r.status = status; r.statusAt = new Date().toISOString(); r.statusBy = me.name;
      (r.statusLog = r.statusLog || []).push({ at: r.statusAt, by: me.name, status });
      writeJSON(rfqFile(r.id), r);
      return send(res, 200, rfqSummary(r));
    }
    if (rm[2] === '/pdf' && m === 'GET') {
      let pdf; try { pdf = await rfqPdf(r, me); } catch (e) { console.error('PDF:', e.message); return send(res, 502, { error: 'Could not build the PDF: ' + e.message }); }
      return send(res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="${pdfName(r)}"` });
    }
    if (rm[2] === '/send' && m === 'POST') {
      if (!Mail.configured()) return send(res, 503, { error: 'Email is not set up on the server yet (SMTP settings)' });
      const b = await readBody(req, 8192);
      const to = Mail.splitList(b.to || RFQ_TO);
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
    if (!rm[2] && m === 'DELETE') { // only RFQs that were never emailed; by the person who made it, or an admin
      if ((r.sends || []).length) return send(res, 409, { error: 'Emailed RFQs can’t be deleted' });
      if (r.by !== me.name && me.role !== 'admin') return send(res, 403, { error: 'Only the person who made it (or an admin) can delete it' });
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
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie(makeToken(me.name, me.ver), SESSION_HOURS * 3600) });
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
server.listen(PORT, () => {
  console.log(`Burner matrix on port ${PORT}, data in ${DATA}`);
  setTimeout(() => localizePhotos().catch(e => console.warn('Photo download failed:', e.message)), 3000);
});
