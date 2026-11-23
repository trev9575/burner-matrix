/* Burner data rules, shared by the page's "Add a burner" form and the build check
   (scripts/validate.js). Edit the vocab lists here if a new option is ever needed. */
(function (root) {
  const POWER = ['12 VDC', '24 VDC', '120 VAC', '208-240 VAC 1P', '208-240 VAC 3P', '480 VAC 3P', 'no power'];
  const MODES = ['on/off', 'low-high-low', 'modulating'];
  const APPS = ['residential', 'light commercial', 'commercial/industrial', 'pressure washers/road equipment', 'oil-to-gas conversion', 'ovens/process'];
  const DIMS_TEXT = ['spec sheet', 'not published'];
  const REQUIRED = ['name', 'brand', 'fuel', 'min', 'max', 'power', 'powerText', 'modes', 'dims', 'airTube', 'applications', 'notes', 'link'];
  const OPTIONAL = ['powerStd', 'biofuel', 'propane', 'discontinued', 'image', 'flameLength', 'flameWidth', 'turndown', 'overfire', 'parts', 'service', 'stepDown'];
  const PARTS = ['best', 'good', 'bad'];
  const SERVICE = ['easy', 'medium', 'hard'];

  const str = v => typeof v === 'string' && v.trim().length > 0;
  const num = v => typeof v === 'number' && isFinite(v) && v > 0;
  const subset = (v, allowed) => Array.isArray(v) && v.length > 0 && v.every(x => allowed.includes(x)) && new Set(v).size === v.length;

  // Returns a list of problems with one burner entry; empty list = valid.
  function check(b) {
    const e = [];
    if (!b || typeof b !== 'object' || Array.isArray(b)) return ['Entry must be an object { ... }'];
    for (const k of Object.keys(b)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) e.push(`Unknown field "${k}"`);
    for (const k of REQUIRED) if (!(k in b)) e.push(`Missing "${k}"`);
    if ('name' in b && !str(b.name)) e.push('name: enter the model name');
    if ('brand' in b && !str(b.brand)) e.push('brand: enter the brand');
    if ('fuel' in b && !['oil', 'gas'].includes(b.fuel)) e.push('fuel: must be "oil" or "gas"');
    if ('min' in b && !num(b.min)) e.push('min: must be a number above 0');
    if ('max' in b && !num(b.max)) e.push('max: must be a number above 0');
    if (num(b.min) && num(b.max)) {
      if (b.min >= b.max) e.push('min must be lower than max');
      if (b.fuel === 'oil' && b.max > 60) e.push('oil firing rate is in GPH; max looks too high (did you enter MBH?)');
      if (b.fuel === 'gas' && b.max < 10) e.push('gas firing rate is in MBH; max looks too low (did you enter GPH or MMBH?)');
    }
    if ('power' in b && !subset(b.power, POWER)) e.push(`power: pick one or more of ${POWER.join(', ')}`);
    if ('powerStd' in b && !(Array.isArray(b.power) && b.power.includes(b.powerStd))) e.push('powerStd: must be one of the ticked power options (or leave it out)');
    if ('powerText' in b && !str(b.powerText)) e.push('powerText: describe the electrical options (e.g. "120 VAC std; 240 VAC option")');
    if ('modes' in b && !subset(b.modes, MODES)) e.push(`modes: pick one or more of ${MODES.join(', ')}`);
    if ('dims' in b) {
      const okArr = Array.isArray(b.dims) && b.dims.length === 3 && b.dims.every(num);
      if (!okArr && !DIMS_TEXT.includes(b.dims)) e.push('dims: [height, width, depth] in inches, or "spec sheet" / "not published"');
    }
    if ('airTube' in b && !str(b.airTube)) e.push('airTube: enter air tube lengths or insertion (or "See spec sheet")');
    if ('applications' in b && !subset(b.applications, APPS)) e.push(`applications: pick one or more of ${APPS.join(', ')}`);
    if ('notes' in b && !str(b.notes)) e.push('notes: add a short selling note');
    if ('link' in b && !(str(b.link) && /^https:\/\/\S+$/.test(b.link))) e.push('link: must be a full https:// address to the product page or spec sheet');
    if ('image' in b && !(str(b.image) && (/^https:\/\/\S+$/.test(b.image) || /^photos\/[\w.-]+\.(jpg|jpeg|png|webp)$/i.test(b.image) || /^data:image\//.test(b.image)))) e.push('image: a full https:// photo address, or photos/<file> for a photo stored in the repo');
    if ('flameLength' in b && !num(b.flameLength)) e.push('flameLength: flame length in inches (a number above 0), or leave it out');
    if ('flameWidth' in b && !num(b.flameWidth)) e.push('flameWidth: flame width/diameter in inches (a number above 0), or leave it out');
    if ('turndown' in b && !(typeof b.turndown === 'number' && b.turndown >= 1 && b.turndown <= 100)) e.push('turndown: ratio as a number, e.g. 8 for 8:1 (1 = on/off), or leave it out');
    if ('overfire' in b && !(typeof b.overfire === 'number' && b.overfire >= 0 && b.overfire <= 50)) e.push('overfire: max overfire (combustion chamber) pressure in inches WC, or leave it out');
    if ('parts' in b && !PARTS.includes(b.parts)) e.push('parts: best, good or bad, or leave it out');
    if ('service' in b && !SERVICE.includes(b.service)) e.push('service: easy, medium or hard, or leave it out');
    if ('biofuel' in b && !str(b.biofuel)) e.push('biofuel: remove it or describe the rating (e.g. "B20")');
    if ('propane' in b && !str(b.propane)) e.push('propane: remove it or describe how (e.g. "Conversion kit")');
    if ('propane' in b && b.fuel === 'oil') e.push('propane: only applies to gas burners');
    if ('stepDown' in b && b.stepDown !== true) e.push('stepDown: use true, or remove the field');
    if ('discontinued' in b && b.discontinued !== true) e.push('discontinued: use true, or remove the field');
    return e;
  }

  // Checks the whole list, including duplicate names within a brand.
  function checkAll(list) {
    if (!Array.isArray(list)) return ['burners.json must be a list [ ... ]'];
    const out = [], seen = new Set();
    list.forEach((b, i) => {
      const label = `#${i + 1}${b && b.name ? ' (' + b.name + ')' : ''}`;
      check(b).forEach(m => out.push(`${label}: ${m}`));
      const key = b && str(b.brand) && str(b.name) ? (b.brand + '|' + b.name).toLowerCase() : null;
      if (key && seen.has(key)) out.push(`${label}: duplicate of an earlier ${b.brand} ${b.name}`);
      if (key) seen.add(key);
    });
    return out;
  }

  const S = { POWER, MODES, APPS, DIMS_TEXT, REQUIRED, OPTIONAL, PARTS, SERVICE, check, checkAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = S; else root.BurnerSchema = S;
})(this);
