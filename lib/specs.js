// Appliance spec guides (e.g. Beckett's residential oil, commercial oil, residential gas and commercial gas guides):
// any number per burner brand, each imported from a CSV export. Columns are kept exactly as the guide has them; the few the app needs are found by name.
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

// which column is which, by its heading (works for differently worded guides: residential/commercial, oil/gas, other brands)
function roles(cols) {
  const L = cols.map(c => String(c).toLowerCase().trim()), find = (...tests) => { for (const t of tests) { const i = L.findIndex(t); if (i >= 0) return i; } return -1; };
  return {
    mfg: find(c => c === 'appliance mfg', c => /manufacturer|\bmfg\b|\bmake\b|\bbrand\b/.test(c) && !/burner/.test(c)),
    model: find(c => c === 'appliance model', c => /model/.test(c) && !/burner/.test(c), c => /boiler|furnace|appliance/.test(c) && !/mfg|manufacturer|make|brand/.test(c)),
    burner: find(c => c === 'burner model', c => /burner/.test(c) && /model|name|type/.test(c), c => c === 'burner', c => /burner/.test(c) && !/head|setting|atc|part|spec|serial|date/.test(c)),
    rate: find(c => /^req|required/.test(c) && /input|rate|btu|mbh|gph/.test(c), c => /rate|gph|mbh/.test(c), c => /input|btu/.test(c)),
    note: find(c => c === 'note' || c === 'notes'),
  };
}
// firing-rate unit from the heading, else from the size of the numbers
function rateUnit(cols, r, rows) {
  if (r.rate < 0) return '';
  const h = String(cols[r.rate]).toLowerCase();
  if (/mbh/.test(h)) return 'mbh'; if (/btu/.test(h)) return 'btu'; if (/gph/.test(h)) return 'gph';
  const n = rows.map(x => parseFloat(x.v[r.rate])).filter(x => x > 0).sort((a, b) => a - b), med = n.length ? n[n.length >> 1] : 0;
  return med > 2000 ? 'btu' : med > 40 ? 'mbh' : 'gph';
}
// "Residential_Gas_Specifications_Guide_SQL.csv" -> "Residential gas"
function guideName(file) {
  let n = String(file || '').replace(/\.[a-z0-9]+$/i, '').replace(/^[0-9a-f]{6,}[-_]/i, '').replace(/[_]+/g, ' ')
    .replace(/\b(spec(ification)?s?|guide|sql|export|csv)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return '';
  n = n.toLowerCase(); return (n[0].toUpperCase() + n.slice(1)).slice(0, 40);
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = b => String(b).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guide';
const rid = () => crypto.randomBytes(4).toString('hex');
const guideId = (brand, name) => slug(String(brand).trim() + (name ? ' ' + name : ''));
const title = s => s.name ? `${s.brand} ${s.name.toLowerCase()}` : s.brand;
const burnerOf = (set, row) => (set.roles.burner >= 0 ? row.v[set.roles.burner] : '') || set.burner || '';

function store(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = id => path.join(dir, slug(id) + '.json');
  const cache = new Map(); // file name -> { m, s, set }
  const load = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  function sets() {
    const out = [];
    for (const n of fs.readdirSync(dir)) {
      if (!/^[a-z0-9-]+\.json$/.test(n)) continue; // skips the .prev.json copies
      const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch { continue; }
      let c = cache.get(n);
      if (!c || c.m !== st.mtimeMs || c.s !== st.size) { c = { m: st.mtimeMs, s: st.size, set: load(f) }; cache.set(n, c); }
      if (c.set && Array.isArray(c.set.cols) && Array.isArray(c.set.rows)) { c.set.id = n.slice(0, -5); out.push(c.set); }
    }
    return out.sort((a, b) => a.brand.localeCompare(b.brand) || String(a.name || '').localeCompare(String(b.name || '')));
  }
  const get = id => sets().find(s => s.id === slug(id)) || null;
  function save(set) {
    const f = file(set.id), tmp = f + '.tmp', { id, ...data } = set;
    fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, f); cache.delete(path.basename(f));
  }
  // guides saved before a brand could have several: name the old residential oil guide and give it its own id
  for (const n of fs.readdirSync(dir)) {
    if (!/^[a-z0-9-]+\.json$/.test(n)) continue;
    const f = path.join(dir, n), o = load(f); if (!o || !Array.isArray(o.cols) || 'name' in o) continue;
    o.name = o.cols.includes('Burner ATC') && o.cols.includes('Rate GPH') ? 'Residential oil' : '';
    o.burner = o.burner || ''; o.rateUnit = rateUnit(o.cols, o.roles, o.rows || []);
    const to = file(guideId(o.brand, o.name));
    fs.writeFileSync(to + '.tmp', JSON.stringify(o)); fs.renameSync(to + '.tmp', to); if (to !== f) fs.rmSync(f, { force: true });
    const pv = f.replace(/\.json$/, '.prev.json'); if (to !== f && fs.existsSync(pv)) fs.rmSync(pv, { force: true });
  }
  function keepPrevious(id) { const f = file(id); if (fs.existsSync(f)) fs.copyFileSync(f, f.replace(/\.json$/, '.prev.json')); }

  // load one guide from CSV text, replacing only the guide with the same brand + name; returns { set, skipped, warnings } or { error }
  function importCSV(brand, name, text, who, burner) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { error: 'That file has no spec rows.' };
    const cols = rows[0].map(c => String(c).trim()), r = roles(cols);
    burner = String(burner || '').trim().slice(0, 40);
    const missing = [['mfg', 'appliance manufacturer'], ['model', 'appliance model']].filter(([k]) => r[k] < 0).map(([, n]) => n);
    if (missing.length) return { error: `Couldn’t find the ${missing.join(' and ')} column${missing.length > 1 ? 's' : ''}. The first row must be the column headings (e.g. Appliance Mfg, Appliance Model, Burner Model).` };
    if (r.burner < 0 && !burner) return { error: 'This file has no burner model column. Enter the burner every spec in it is for (e.g. CG4).', needBurner: true };
    const H = cols.map(norm); let skipped = 0, short = 0;
    const data = [];
    for (const row of rows.slice(1)) {
      const same = row.filter((x, i) => norm(x) && norm(x) === H[i]).length;
      if (same >= Math.min(3, cols.length) || (norm(row[r.mfg]) === H[r.mfg] && norm(row[r.model]) === H[r.model])) { skipped++; continue; } // a repeated heading row
      const v = cols.map((_, i) => String(row[i] == null ? '' : row[i]).trim().slice(0, 1000));
      if (!v[r.mfg] && !v[r.model]) { skipped++; continue; }
      if (row.length < cols.length) short++;
      data.push({ id: rid(), v });
    }
    if (!data.length) return { error: 'That file has no spec rows.' };
    const id = guideId(brand, name); keepPrevious(id);
    const set = { id, brand: String(brand).trim().slice(0, 40), name: String(name || '').trim().slice(0, 40), cols, roles: r, burner: r.burner < 0 ? burner : '',
      rateUnit: rateUnit(cols, r, data), rows: data, updated: new Date().toISOString(), by: who, source: 'csv' };
    save(set);
    return { set, skipped, warnings: short ? [`${short} row${short > 1 ? 's had' : ' had'} fewer columns than the headings; the missing ones were left blank.`] : [] };
  }
  function restorePrevious(id) {
    const f = file(id), p = f.replace(/\.json$/, '.prev.json');
    if (!fs.existsSync(p)) return false;
    const cur = fs.existsSync(f) ? fs.readFileSync(f) : null;
    fs.copyFileSync(p, f); if (cur) fs.writeFileSync(p, cur); else fs.rmSync(p); // restoring twice swaps back
    cache.delete(path.basename(f)); return true;
  }
  function remove(id) { keepPrevious(id); fs.rmSync(file(id), { force: true }); cache.delete(path.basename(file(id))); }
  const hasPrevious = id => fs.existsSync(file(id).replace(/\.json$/, '.prev.json'));
  // guides that were removed but can still be restored
  const removed = () => fs.readdirSync(dir).filter(n => /^[a-z0-9-]+\.prev\.json$/.test(n) && !fs.existsSync(path.join(dir, n.replace('.prev.json', '.json'))))
    .map(n => { const s = load(path.join(dir, n)); return s && s.brand ? { id: n.replace('.prev.json', ''), brand: s.brand, name: s.name || '', count: Array.isArray(s.rows) ? s.rows.length : 0 } : null; }).filter(Boolean);

  // search every guide by appliance maker / model / burner; all words must match
  function search(q, limit = 60, only) {
    const toks = String(q).toLowerCase().split(/\s+/).map(norm).filter(Boolean), all = norm(q);
    if (!toks.length) return [];
    const hits = [];
    for (const set of only ? [only] : sets()) {
      const r = set.roles;
      for (const row of set.rows) {
        const mo = norm(row.v[r.model]), hay = norm(row.v[r.mfg]) + ' ' + mo + ' ' + norm(burnerOf(set, row));
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

module.exports = { parseCSV, toCSV, roles, store, norm, slug, rid, guideId, guideName, title, burnerOf };
