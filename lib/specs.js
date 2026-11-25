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
// like norm, but a run of digits loses its leading zeros (0488 -> 488, SC06 -> sc6)
const nz = s => norm(s).replace(/(^|[^0-9])0+(?=[0-9])/g, '$1');
// edit distance, giving up once it passes max
function lev(a, b, max) {
  if (a === b) return 0; let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let lo = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < lo) lo = cur[j]; }
    if (lo > max) return max + 1; prev = cur;
  }
  return prev[b.length];
}
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
  // load one guide from CSV text, replacing only the guide with the same brand + name; returns { set, skipped, warnings, diff } or { error }.
  // dryRun: work out the same result (and what would change) without saving anything.
  function importCSV(brand, name, text, who, burner, dryRun) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { error: 'That file has no spec rows.' };
    let cols = rows[0].map(c => String(c).trim()); const r = roles(cols);
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
    const id = guideId(brand, name), prev = get(id);
    const set = { id, brand: String(brand).trim().slice(0, 40), name: String(name || '').trim().slice(0, 40), cols, roles: r, burner: r.burner < 0 ? burner : '',
      rateUnit: rateUnit(cols, r, data), rows: data, updated: new Date().toISOString(), by: who, source: 'csv' };
    const kept = prev ? carryDecisions(prev, set) : 0;
    const diff = prev ? diffSets(prev, set) : null;
    if (!dryRun) { keepPrevious(id); save(set); }
    const warnings = short ? [`${short} row${short > 1 ? 's had' : ' had'} fewer columns than the headings; the missing ones were left blank.`] : [];
    return { set, skipped, warnings, diff, kept, replaces: prev ? prev.rows.length : 0 };
  }
  // one appliance setup, independent of row ids and the spec-link columns: maker | model | burner | rate
  const rowKey = (set, row) => [set.roles.mfg, set.roles.model].map(i => norm(row.v[i])).join('|') + '|' + norm(burnerOf(set, row)) + '|' + (parseFloat(row.v[set.roles.rate]) || norm(row.v[set.roles.rate]));
  const LINK = new Set(['beckett spec', 'spec match', 'possible specs', 'matched on']);
  const rowBody = (set, row) => set.cols.map((c, i) => LINK.has(c.toLowerCase()) ? null : norm(c) + '=' + norm(row.v[i])).filter(Boolean).sort().join('|');
  function diffSets(a, b) {
    const old = new Map();
    for (const row of a.rows) { const k = rowKey(a, row); if (!old.has(k)) old.set(k, []); old.get(k).push(rowBody(a, row)); }
    let added = 0, changed = 0, same = 0;
    for (const row of b.rows) {
      const l = old.get(rowKey(b, row)); if (!l || !l.length) { added++; continue; }
      const i = l.indexOf(rowBody(b, row)); if (i >= 0) { l.splice(i, 1); same++; } else { l.pop(); changed++; }
    }
    let removed = 0; for (const l of old.values()) removed += l.length;
    const hasLinks = x => x.cols.some(c => c.toLowerCase() === 'beckett spec');
    return { added, removed, changed, same, linksDropped: hasLinks(a) && !hasLinks(b) };
  }
  // a spec link someone confirmed or rejected in Settings survives loading a new copy of the guide
  const colIx = (set, name) => set.cols.findIndex(c => c.toLowerCase() === name);
  function linkCols(set) {
    for (const n of ['Beckett Spec', 'Spec Match', 'Possible Specs']) if (colIx(set, n.toLowerCase()) < 0) { set.cols.push(n); set.rows.forEach(r => r.v.push('')); }
    return { spec: colIx(set, 'beckett spec'), match: colIx(set, 'spec match'), poss: colIx(set, 'possible specs') };
  }
  function carryDecisions(prev, set) {
    const pm = colIx(prev, 'spec match'), ps = colIx(prev, 'beckett spec'); if (pm < 0) return 0;
    const dec = new Map();
    for (const row of prev.rows) if (/^(confirmed|rejected)$/i.test(row.v[pm] || '')) dec.set(rowKey(prev, row), { match: row.v[pm], spec: ps >= 0 ? row.v[ps] : '' });
    if (!dec.size) return 0;
    let n = 0, L = null;
    for (const row of set.rows) {
      const d = dec.get(rowKey(set, row)); if (!d) continue;
      L = L || linkCols(set); row.v[L.match] = d.match; row.v[L.spec] = /^confirmed$/i.test(d.match) ? d.spec : ''; if (/^rejected$/i.test(d.match) && L.poss >= 0) row.v[L.poss] = ''; n++;
    }
    return n;
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

  // search every guide by appliance maker / model / burner; all words must match.
  // Spaces, dashes and leading zeros don't matter: "V-8H4 S", "v8h4s" and "0488" find "V8H4S" and "488".
  const idx = new WeakMap();
  function index(set) {
    let x = idx.get(set); if (x) return x;
    const r = set.roles;
    x = set.rows.map(row => { const mo = nz(row.v[r.model]); return { row, mo, hay: nz(row.v[r.mfg]) + ' ' + mo + ' ' + nz(burnerOf(set, row)) }; });
    idx.set(set, x); return x;
  }
  function search(q, limit = 60, only) {
    const toks = String(q).toLowerCase().split(/\s+/).map(nz).filter(Boolean), all = nz(q);
    if (!toks.length) return [];
    const hits = [];
    for (const set of only ? [only] : sets()) {
      for (const { row, mo, hay } of index(set)) {
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
  // nothing found: the closest appliance models by spelling (one or two characters off), for "Did you mean"
  function suggest(q, n = 5) { const r = suggest1(q, n, true); return r.length ? r : suggest1(q, n, false); }
  function suggest1(q, n, useMaker) {
    const toks = String(q).toLowerCase().split(/\s+/).map(nz).filter(Boolean); if (!toks.length) return [];
    const t = toks.reduce((a, b) => (/\d/.test(b) && !/\d/.test(a)) || b.length > a.length ? b : a), max = t.length < 5 ? 1 : t.length < 9 ? 2 : 3;
    const mk = useMaker ? toks.filter(x => x !== t) : [], seen = new Map();
    for (const set of sets()) for (const { row, mo, hay } of index(set)) {
      if (mk.length && !mk.every(m => hay.includes(m))) continue;
      const key = set.id + '|' + mo; if (seen.has(key) || Math.abs(mo.length - t.length) > max) continue;
      const d = lev(t, mo, max); if (d <= max) seen.set(key, { d, mfg: row.v[set.roles.mfg], model: row.v[set.roles.model], guide: title(set) });
    }
    const out = [], names = new Set();
    for (const s of [...seen.values()].sort((a, b) => a.d - b.d || a.model.localeCompare(b.model))) { const k = s.mfg + ' ' + s.model; if (names.has(k)) continue; names.add(k); out.push(s); if (out.length >= n) break; }
    return out;
  }
  return { sets, get, save, importCSV, restorePrevious, remove, hasPrevious, removed, search, suggest, linkCols, file };
}

module.exports = { parseCSV, toCSV, roles, store, norm, slug, rid, guideId, guideName, title, burnerOf };
