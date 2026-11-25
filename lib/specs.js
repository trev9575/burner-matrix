// Appliance spec guides (e.g. Beckett's "Residential Oil Specifications Guide"): one set per burner brand,
// imported from a CSV export. Columns are kept exactly as the guide has them; the few the app needs are found by name.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// RFC 4180 CSV: quotes, doubled quotes, commas/newlines inside quotes, CRLF, BOM
function parseCSV(text) {
  const s = String(text).replace(/^﻿/, ''), rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
const csvCell = v => /[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const toCSV = (cols, rows) => '﻿' + [cols, ...rows].map(r => r.map(v => csvCell(v == null ? '' : v)).join(',')).join('\r\n') + '\r\n';

// which column is which, by its heading (works for differently worded guides, e.g. a future Wayne one)
function roles(cols) {
  const L = cols.map(c => String(c).toLowerCase().trim()), find = (...tests) => { for (const t of tests) { const i = L.findIndex(t); if (i >= 0) return i; } return -1; };
  return {
    mfg: find(c => c === 'appliance mfg', c => /manufacturer|\bmfg\b|\bmake\b|\bbrand\b/.test(c) && !/burner/.test(c)),
    model: find(c => c === 'appliance model', c => /model/.test(c) && !/burner/.test(c)),
    burner: find(c => c === 'burner model', c => /burner/.test(c) && /model|name|type/.test(c), c => c === 'burner', c => /burner/.test(c) && !/head|setting|atc|part|spec|serial|date/.test(c)),
    rate: find(c => /rate|gph|mbh|input/.test(c)),
    note: find(c => c === 'note' || c === 'notes'),
  };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = b => String(b).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brand';
const rid = () => crypto.randomBytes(4).toString('hex');

function store(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = brand => path.join(dir, slug(brand) + '.json');
  const cache = new Map(); // brand slug -> { m, s, set }
  const load = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  function sets() {
    const out = [];
    for (const n of fs.readdirSync(dir)) {
      if (!/^[a-z0-9-]+\.json$/.test(n)) continue; // skips the .prev.json copies
      const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch { continue; }
      let c = cache.get(n);
      if (!c || c.m !== st.mtimeMs || c.s !== st.size) { c = { m: st.mtimeMs, s: st.size, set: load(f) }; cache.set(n, c); }
      if (c.set && Array.isArray(c.set.cols) && Array.isArray(c.set.rows)) out.push(c.set);
    }
    return out.sort((a, b) => a.brand.localeCompare(b.brand));
  }
  const get = brand => sets().find(s => slug(s.brand) === slug(brand)) || null;
  function save(set) {
    const f = file(set.brand), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(set)); fs.renameSync(tmp, f); cache.delete(path.basename(f));
  }
  function keepPrevious(brand) { const f = file(brand); if (fs.existsSync(f)) fs.copyFileSync(f, f.replace(/\.json$/, '.prev.json')); }

  // replace a brand's whole set from CSV text; returns { set, skipped, warnings } or { error }
  function importCSV(brand, text, who) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { error: 'That file has no spec rows.' };
    const cols = rows[0].map(c => String(c).trim()), r = roles(cols);
    const missing = [['mfg', 'appliance manufacturer'], ['model', 'appliance model'], ['burner', 'burner model']].filter(([k]) => r[k] < 0).map(([, n]) => n);
    if (missing.length) return { error: `Couldn’t find the ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}. The first row must be the column headings (e.g. Appliance Mfg, Appliance Model, Burner Model).` };
    const head = cols.map(norm).join('|'); let skipped = 0, short = 0;
    const data = [];
    for (const row of rows.slice(1)) {
      if (row.map(norm).join('|') === head || (norm(row[r.mfg]) === norm(cols[r.mfg]) && norm(row[r.model]) === norm(cols[r.model]))) { skipped++; continue; } // a repeated heading row
      const v = cols.map((_, i) => String(row[i] == null ? '' : row[i]).trim().slice(0, 1000));
      if (!v[r.mfg] && !v[r.model]) { skipped++; continue; }
      if (row.length < cols.length) short++;
      data.push({ id: rid(), v });
    }
    if (!data.length) return { error: 'That file has no spec rows.' };
    keepPrevious(brand);
    const set = { brand: String(brand).trim().slice(0, 40), cols, roles: r, rows: data, updated: new Date().toISOString(), by: who, source: 'csv' };
    save(set);
    return { set, skipped, warnings: short ? [`${short} row${short > 1 ? 's had' : ' had'} fewer columns than the headings; the missing ones were left blank.`] : [] };
  }
  function restorePrevious(brand) {
    const f = file(brand), p = f.replace(/\.json$/, '.prev.json');
    if (!fs.existsSync(p)) return false;
    const cur = fs.existsSync(f) ? fs.readFileSync(f) : null;
    fs.copyFileSync(p, f); if (cur) fs.writeFileSync(p, cur); else fs.rmSync(p); // restoring twice swaps back
    cache.delete(path.basename(f)); return true;
  }
  function remove(brand) { keepPrevious(brand); fs.rmSync(file(brand), { force: true }); cache.delete(path.basename(file(brand))); }
  const hasPrevious = brand => fs.existsSync(file(brand).replace(/\.json$/, '.prev.json'));
  // brands whose guide was removed but can still be restored
  const removed = () => fs.readdirSync(dir).filter(n => /^[a-z0-9-]+\.prev\.json$/.test(n) && !fs.existsSync(path.join(dir, n.replace('.prev.json', '.json'))))
    .map(n => { const s = load(path.join(dir, n)); return s && s.brand ? { brand: s.brand, count: Array.isArray(s.rows) ? s.rows.length : 0 } : null; }).filter(Boolean);

  // search every brand's set by appliance maker / model / burner; all words must match
  function search(q, limit = 60) {
    const toks = String(q).toLowerCase().split(/\s+/).map(norm).filter(Boolean), all = norm(q);
    if (!toks.length) return [];
    const hits = [];
    for (const set of sets()) {
      const r = set.roles;
      for (const row of set.rows) {
        const mo = norm(row.v[r.model]), hay = norm(row.v[r.mfg]) + ' ' + mo + ' ' + norm(row.v[r.burner]);
        if (!toks.every(t => hay.includes(t)) && !hay.replace(/ /g, '').includes(all)) continue;
        const score = mo === all ? 0 : toks.some(t => mo === t) ? 1 : mo.startsWith(toks[toks.length - 1]) ? 2 : 3;
        hits.push({ score, set, row });
      }
    }
    hits.sort((a, b) => a.score - b.score || String(a.row.v[a.set.roles.mfg]).localeCompare(String(b.row.v[b.set.roles.mfg])) ||
      String(a.row.v[a.set.roles.model]).localeCompare(String(b.row.v[b.set.roles.model]), undefined, { numeric: true }) ||
      (parseFloat(a.row.v[a.set.roles.rate]) || 0) - (parseFloat(b.row.v[b.set.roles.rate]) || 0));
    return hits.slice(0, limit);
  }
  return { sets, get, save, importCSV, restorePrevious, remove, hasPrevious, removed, search, file };
}

module.exports = { parseCSV, toCSV, roles, store, norm, slug, rid };
