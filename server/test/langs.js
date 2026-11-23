// What a language lacks next to English: node test/langs.js [code ...], every file in www/js/lang by default.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Game = require('../../www/js/game.js');
const Names = require('../../www/js/names.js');

const www = path.join(__dirname, '../../www/js');
const cx = vm.createContext({ document: {}, navigator: {}, Names });
const load = f => vm.runInContext(fs.readFileSync(path.join(www, f), 'utf8'), cx, { filename: f });
load('i18n.js');
const S = vm.runInContext('I18n.S', cx);

const leaf = v => typeof v !== 'object' || Array.isArray(v);
function flat(o, pre, out) {
  for (const k of Object.keys(o)) {
    if (leaf(o[k])) out[pre + k] = o[k];
    else flat(o[k], pre + k + '.', out);
  }
  return out;
}

const en = flat(S.en, '', {});
const codes = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(path.join(www, 'lang')).map(f => f.replace('.js', ''));
const push = fs.readFileSync(path.join(__dirname, '../src/push.js'), 'utf8');
const pushKeys = push.slice(push.indexOf('  en: {'), push.indexOf('  tr: {')).match(/^ {4}(\w+):/gm).map(k => k.trim().slice(0, -1));
const registry = fs.readFileSync(path.join(__dirname, '../src/text.js'), 'utf8');
let bad = 0;

for (const c of codes) {
  const out = [];
  load('lang/' + c + '.js');
  if (fs.existsSync(path.join(www, 'names', c + '.js'))) load('names/' + c + '.js');
  const tbl = flat(S[c], '', {});
  for (const k of Object.keys(en)) {
    if (!(k in tbl)) out.push('missing ' + k);
    else if (Array.isArray(en[k]) && tbl[k].length !== en[k].length) out.push('count ' + k + ': ' + tbl[k].length + ', English has ' + en[k].length);
    else if (typeof en[k] === 'string' && typeof tbl[k] === 'string' && en[k].length < 24 && tbl[k].length > en[k].length * 1.6 + 8) out.push('long ' + k + ': ' + tbl[k]);
  }
  for (const k of Object.keys(tbl)) if (!(k in en) && !k.startsWith('tasks.')) out.push('unknown ' + k);
  for (const t of Game.TASKS) if (!tbl['tasks.' + t.id]) out.push('missing tasks.' + t.id);

  const d = Names.D[c];
  if (!d) out.push('no names/' + c + '.js');
  else {
    let long = '';
    for (let a = 0; a < Names.D.en.adj.length; a++) {
      for (let b = 0; b < Names.D.en.noun.length; b++) {
        const s = Names.text(a * 100 + b, c);
        if (/\?|undefined/.test(s)) out.push('bad name for seed ' + (a * 100 + b));
        if (s.length > long.length) long = s;
      }
    }
    if (long.length > 26) out.push('long name: ' + long);
  }
  if (!vm.runInContext('I18n.codes', cx).includes(c)) out.push('not in CODES in i18n.js');
  const file = path.join(__dirname, '../src/text', c + '.js');
  if (!fs.existsSync(file)) out.push('no server/src/text/' + c + '.js');
  else {
    const src = fs.readFileSync(file, 'utf8');
    for (const k of pushKeys) if (!src.includes('  ' + k + ': ')) out.push('push text lacks ' + k);
    if (!src.includes('names/' + c + '.js')) out.push('push text does not load names/' + c + '.js');
    if (!registry.includes("'./text/" + c + ".js'")) out.push('not registered in server/src/text.js');
  }
  console.log(c + ': ' + (out.length ? out.length + ' to look at' : 'complete'));
  for (const l of out) console.log('  ' + l);
  bad += out.length;
}
process.exit(bad ? 1 : 0);
