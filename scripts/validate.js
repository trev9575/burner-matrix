// Build check: fails the GitHub Action if html/burners.json has a bad or incomplete entry.
const fs = require('fs');
const path = require('path');
const S = require('../html/schema.js');
const file = path.join(__dirname, '..', 'html', 'burners.json');
let list;
try { list = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error('burners.json is not valid JSON:', e.message, '\nTip: check for a missing or extra comma between entries.'); process.exit(1); }
const errs = S.checkAll(list);
if (errs.length) { console.error(`burners.json has ${errs.length} problem(s):`); errs.forEach(m => console.error(' - ' + m)); process.exit(1); }
console.log(`burners.json OK: ${list.length} burners`);
