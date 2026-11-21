// Burner Selection Matrix server: public page + login-protected admin.
// No dependencies; Node 20+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Schema = require('./html/schema.js');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || '/data';
const HTML = path.join(__dirname, 'html');
const COOKIE_SECURE = /^true$/i.test(process.env.COOKIE_SECURE || '');
const TRUST_PROXY = /^true$/i.test(process.env.TRUST_PROXY || '');
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;
const HISTORY_KEEP = 200;

const F = {
  burners: path.join(DATA, 'burners.json'),
  users: path.join(DATA, 'users.json'),
  secret: path.join(DATA, '.secret'),
  history: path.join(DATA, 'history'),
  photos: path.join(DATA, 'photos'),
};

// ---------- storage ----------
fs.mkdirSync(F.history, { recursive: true });
fs.mkdirSync(F.photos, { recursive: true });
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
const validName = n => /^[a-z0-9._-]{2,32}$/.test(n);

// ---------- sessions (signed cookie) ----------
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = (name, ver) => {
  const body = Buffer.from(JSON.stringify({ n: name, v: ver, e: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
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
  `bm_s=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;

// ---------- login rate limit ----------
const attempts = new Map();
const clientIp = req => (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const limited = ip => {
  const a = attempts.get(ip); const now = Date.now();
  if (!a || now - a.t > 15 * 60e3) return false;
  return a.n >= 8;
};
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

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  // all writes must be same-origin JSON with our header (CSRF guard on top of SameSite=Strict)
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
  if (p === '/api/me') return me ? send(res, 200, { name: me.name, role: me.role, setup: true }) : send(res, 401, { error: 'Not signed in', setup: users.length > 0 });
  if (!me) return send(res, 401, { error: 'Not signed in' });

  if (p === '/api/burners' && m === 'GET') return send(res, 200, getBurners());

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
    if (m === 'GET') return send(res, 200, users.map(u => ({ name: u.name, role: u.role, created: u.created })));
    const b = await readBody(req, 4096);
    const name = String(b.name || '').trim().toLowerCase();
    if (m === 'POST') {
      if (!validName(name)) return send(res, 422, { error: 'Username: 2–32 letters, numbers, dot, dash or underscore' });
      if (users.some(u => u.name === name)) return send(res, 422, { error: 'That username exists' });
      if (String(b.password || '').length < 8) return send(res, 422, { error: 'Password must be at least 8 characters' });
      users.push({ name, role: b.role === 'admin' ? 'admin' : 'editor', hash: hashPw(String(b.password)), created: new Date().toISOString() });
      saveUsers(); return send(res, 200, { ok: true });
    }
    const u = users.find(x => x.name === name);
    if (!u) return send(res, 404, { error: 'No such user' });
    if (m === 'PATCH') {
      if (b.password !== undefined) { if (String(b.password).length < 8) return send(res, 422, { error: 'Password must be at least 8 characters' });
        u.hash = hashPw(String(b.password)); u.ver = (u.ver || 0) + 1; }
      if (b.role) { if (u.role === 'admin' && b.role !== 'admin' && users.filter(x => x.role === 'admin').length < 2) return send(res, 422, { error: 'Keep at least one admin' });
        u.role = b.role === 'admin' ? 'admin' : 'editor'; }
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
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (p === '/burners.json') return sendFile(res, F.burners);
    if (p === '/admin' || p === '/admin/') return sendPage(res, path.join(HTML, 'admin.html'));
    if (p === '/' || p === '/index.html') return sendPage(res, path.join(HTML, 'index.html'));
    if (p.startsWith('/photos/')) { // uploaded photos first, then the ones shipped in the image
      const name = path.basename(p);
      const up = path.join(F.photos, name);
      return sendFile(res, fs.existsSync(up) ? up : path.join(HTML, 'photos', name), 'public, max-age=300');
    }
    const file = path.normalize(path.join(HTML, p === '/' ? 'index.html' : p));
    if (!file.startsWith(HTML + path.sep) || /\/\./.test(p) || p.endsWith('burners.json')) return send(res, 404, 'Not found', 'text/plain');
    return sendFile(res, file);
  } catch (e) {
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.code ? e.message : 'Server error' });
    if (!e.code) console.error(e);
  }
});
server.listen(PORT, () => console.log(`Burner matrix on port ${PORT}, data in ${DATA}`));
