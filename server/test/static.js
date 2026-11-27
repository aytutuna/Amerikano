// Checks that read files only: no microphone in the shipped builds, no unused text, no wrong lines.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const bad = [];
const fail = m => bad.push(m);

// voice is off in the shipped builds
if (/NSMicrophoneUsageDescription/.test(read('ios/App/App/Info.plist'))) fail('Info.plist asks for the microphone');
if (/RECORD_AUDIO|MODIFY_AUDIO_SETTINGS|hardware\.microphone/.test(read('android/app/src/main/AndroidManifest.xml'))) fail('the Android manifest asks for the microphone');
if (fs.existsSync(path.join(root, 'ios/App/App/AudioRoute.swift'))) fail('AudioRoute.swift is back in the iOS target');
if (/AudioRoute/.test(read('ios/App/App.xcodeproj/project.pbxproj'))) fail('the Xcode project still names AudioRoute');
if (!/var BUILD_VOICE = false;/.test(read('www/js/voice.js'))) fail('BUILD_VOICE is not false in voice.js');

// text that nothing reads
const cx = vm.createContext({ document: {}, navigator: {}, Names: require('../../www/js/names.js') });
vm.runInContext(read('www/js/i18n.js'), cx, { filename: 'i18n.js' });
const S = vm.runInContext('I18n.S', cx);
const flat = (o, pre, out) => {
  for (const k of Object.keys(o)) {
    if (typeof o[k] !== 'object' || Array.isArray(o[k])) out.push(pre + k);
    else flat(o[k], pre + k + '.', out);
  }
  return out;
};
const keys = flat(S.en, '', []);
let src = read('www/index.html') + read('server/src/push.js');
for (const f of fs.readdirSync(path.join(root, 'www/js'))) if (f.endsWith('.js') && f !== 'i18n.js') src += read('www/js/' + f);
// a key built from a prefix at run time is used, and so are the ones picked by a ternary
const dynamic = ['joker', 'chat.emo.'];
const unused = keys.filter(k => {
  if (dynamic.some(d => k === d || k.startsWith(d))) return false;
  if (src.includes("'" + k + "'") || src.includes('"' + k + '"') || src.includes('`' + k + '`')) return false;
  const parts = k.split('.');
  for (let i = 1; i <= parts.length; i++) {
    const pre = parts.slice(0, i).join('.') + '.';
    if (src.includes("'" + pre + "' +") || src.includes('`' + pre + '${')) return false;
  }
  return true;
});
for (const k of unused) fail('text nothing reads: ' + k);
// the twelve that were removed, which a dynamic prefix would hide
for (const k of ['cards', 'playing', 'stockEmpty', 'st.sel', 'start.fan', 'setup.title', 'setup.nPlayers', 'net.create', 'net.hostTag', 'hall.need', 'end.title', 'fr.invTitle']) {
  if (keys.includes(k)) fail('removed text is back: ' + k);
}

// lines that were wrong and must not come back, in English and Turkish
const get = (tbl, k) => k.split('.').reduce((o, x) => (o ? o[x] : undefined), tbl);
const wrong = [
  ['en', /each chip on the table|Opponent speed|lowest total wins the pot/i],
  ['tr', /masadaki her çip|toplamı en düşük olan kasayı alır|Rakip hızı/i]
];
for (const [code, re] of wrong) {
  for (const k of flat(S[code], '', [])) {
    const v = get(S[code], k);
    if (typeof v === 'string' && re.test(v)) fail('wrong line in ' + code + ': ' + k);
  }
}
// one chip and one token read in the singular
const one = { 'end.change': { n: 1, abs: '1' }, 'end.tokens': { n: 1 }, 'end.bonus': { n: 1 }, 'hall.stakeAt': { n: 1 }, 'pf.got': { n: 1 }, 'gift.cost': { n: 1 }, 'fr.invText': { name: 'A', n: 1 }, 'end.unit': { stake: 10, unit: '1', n: 1 } };
for (const [k, v] of Object.entries(one)) {
  const s = get(S.en, k)(v);
  if (/1 (chips|tokens)/.test(s)) fail('plural of one in ' + k + ': ' + s);
}
if (!/penalty card/.test(S.en.claimBody({ left: 2 }))) fail('claimBody does not name the cost');

// what the privacy page has to name
const page = read('www/privacy.html');
for (const w of ['35 days', '90 days', 'Resend', 'player number', 'trade-word', 'the country your internet address belongs to', '35 gün', '90 gün', 'çip alım satımı']) {
  if (!page.includes(w)) fail('the privacy page lacks: ' + w);
}

if (bad.length) {
  for (const m of bad) console.log(m);
  process.exit(1);
}
console.log('static checks passed');
