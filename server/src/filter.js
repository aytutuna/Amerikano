// Typed chat goes through here before anyone sees it: whitespace and control characters are cleaned up, then profanity and
// slurs are masked with asterisks. Contact details are not masked; contact() tells the caller to warn about them. Words match after case, accents and common look-alikes are
// folded away, and a letter typed twice still counts. A word ending in * also matches what follows it; _ is a space.
const WORDS = {
  en: 'fuck fucks fucked fucking fucker* fuk fuker* motherfuck* shit shits shitty shitting shithead* bullshit* bitch* bastard* asshole* dickhead* dick cunt cunts whore* slut sluts slutty nigger* nigga* faggot* fag fags retard* tranny kike kikes spic chink* wetback* pussy cocksucker* twat wanker* jackass ass arse',
  tr: 'orospu* sikik* siktir* sikeyim* sikerim* sikim* siktim* amk aq amq aminakoy* amina_koy* amcik* yarrak* piclik* pust ibne* pezevenk* gotveren* gotunu* kahpe* dalyarak* yavsak* gavat* serefsiz* ananisik* anani_sik*',
  es: 'puta putas putita* puto putos mierda* joder* jodete cojones pendejo* pendeja* cabron* cabrona* chinga* chingad* verga culo culero* culera* marica* maricon* gilipollas* hijueputa* hijoputa* concha_tu* conchatu* boludo* pelotudo*',
  pt: 'caralho* porra foda fodase foder* fodido* fodida* buceta* bucetas viado* viadinho* arrombado* cuzao* otario* babaca* merda* merdas filho_da_puta* fdp vsf corno',
  fr: 'merde* putain* pute putes salope* salopard* connard* connasse* encule* enculer* nique* niquer* batard* bordel couille* couilles ntm pede',
  de: 'scheiss* arschloch* arsch wichser* fotze* hurensohn* hure huren schlampe* ficken fick ficker* verpiss* verfickt* drecksau* spast* schwuchtel* neger* mistkerl*',
  it: 'cazzo* merda* stronz* vaffanculo* fanculo* puttana* troia troie figa minchia* coglione* coglioni bastardo* frocio* froci pompino* mignotta* culattone*',
  nl: 'kut kutje* kanker* tering* klootzak* lul lullen hoer hoeren godverdomme* godver* tyfus* flikker* neuk* neuken slet mongool*',
  pl: 'kurwa kurwy kurwie kurwo kurwi kurew chuj chuja chuje chujem chujowy* huj cipa cipka* pierdol* spierdalaj* spierdalac* pizda pizdy pizdo pizdzie pizdu jebac* jeban* jebany* jebie* jebnij* dupek* skurwysyn* cwel* debil*',
  ru: 'хуй* хуе* хуя* хуи* пизд* бляд* блят* бля ебан* ебат* ебал* ебу* еблан* заеб* выеб* уеб* наеб* съеб* ебись сука суки сучк* сукин* мудак* мудил* пидор* пидар* пидр* гандон* залуп* шлюх* долбоеб* говн* дерьм* жопа* педик* чмо',
  uk: 'хуй* хуйл* хуйн* пизд* бляд* бляч* їбан* їбат* їбу* їбл* йобан* йобнут* сука суки сучка* курв* шльонд* підар* підор* підр* гандон* мудак* мудил* залуп* срак* довбойоб* довбоеб* уйобок* мразот*',
  ar: 'كس كسم* كسك* كسخت* زب شرموط* عرص* منيوك* منيك ابن_الكلب ابن_الشرموطة يلعن_ابو* قحب* عاهر* متناك* خول',
  hi: 'चूतिया* चुतिया* मादरचोद* बहनचोद* भोसड़ी* भोसडी* गांडू* गांड* रंडी* हरामी* हरामज़ादा* हरामजादा* लौड़ा* लवड़ा* chutiya* chutia* madarchod* maderchod* behenchod* bhenchod* bhosd* bhosad* gandu* gaandu* gaand* harami* haramzade* haramzada*',
  id: 'anjing* bangsat* babi kontol* memek* ngentot* jancok* jancuk* bajingan* goblok* tolol* sialan* pantek* perek bencong*',
  ja: '死ね クソ 糞 ちんこ ちんぽ まんこ ファック ビッチ きちがい くたばれ チンコ マンコ',
  ko: '씨발 시발 씨팔 병신 개새끼 좆 존나 지랄 미친놈 미친년 썅',
  zh: '操你 肏 他妈的 他媽的 妈的 媽的 傻逼 傻屄 煞笔 屄 婊子 狗屎 滚蛋 滾蛋 去死 王八蛋 贱人 賤人 鸡巴 雞巴 屌'
};

export const LANGS = Object.keys(WORDS);

// one list serves both Chinese scripts
const listOf = l => String(l).startsWith('zh-') ? 'zh' : l;

const SWAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', ł: 'l', ø: 'o', đ: 'd', ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', أ: 'ا', إ: 'ا', آ: 'ا', ى: 'ي', ة: 'ه' };
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const WORD = '[\\p{L}\\p{N}\\p{M}]';

const fold = s => Array.from(s.toLowerCase().normalize('NFKD').replace(/[̀-ًͯ-ٟـ]/g, '').normalize('NFKC'), c => SWAP[c] || c).join('');
const esc = c => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

// a letter typed once or more matches; a doubled letter in the word still needs both
function pattern(entry) {
  const w = fold(entry.replace('*', ''));
  // a short Latin stem would catch ordinary words (Fukuoka), so it has to be the whole word
  const open = entry.endsWith('*') && !(w.length <= 4 && /^[a-z]/.test(w));
  if (CJK.test(w)) return esc(w);
  const body = Array.from(w.matchAll(/(.)\1*/gu), m => m[1] === '_' ? '\\s+' : esc(m[1]) + (m[0].length > 1 ? '{' + m[0].length + ',}' : '+')).join('');
  return '(?<!' + WORD + ')' + body + (open ? WORD + '*' : '(?!' + WORD + ')');
}

const rules = {};

// the patterns for English plus the languages in play, built once per combination
function rulesFor(langs) {
  const key = [...new Set(['en', ...langs.map(listOf).filter(l => WORDS[l])])].sort().join();
  if (!rules[key]) {
    const all = [...new Set(key.split(',').flatMap(l => WORDS[l].split(' ')))];
    rules[key] = [all.filter(w => !CJK.test(w)), all.filter(w => CJK.test(w))].filter(l => l.length).map(l => new RegExp(l.map(pattern).join('|'), 'gu'));
  }
  return rules[key];
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const HANDLE = /(?<![\p{L}\p{N}._%+-])@[\p{L}\p{N}._]{3,}/gu;
const LINK = /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|info|biz|xyz|app|dev|io|gg|tv|me|cc|co|online|site|shop|store|club|top|live|link|ly|[a-z]{2})(?![\p{L}\p{N}])(?:\/\S*)?/giu;
const PHONE = /[(+]?(?:\p{Nd}[\s().\-/_,]{0,2})*\p{Nd}/gu;
// 12.500.000 and 1,250,000 are amounts, not phone numbers
const GROUPED = /^\p{Nd}{1,3}(?:[.,\s]\p{Nd}{3})+$/u;

// whether the text holds a link, email address, @handle or phone number
export function contact(text) {
  // the ideographic full stop is only a dot to the link patterns
  const view = text.normalize('NFKC').replace(/[。｡]/g, '.');
  if ([EMAIL, HANDLE, LINK].some(re => view.search(re) >= 0)) return true;
  return Array.from(view.matchAll(PHONE)).some(m => Array.from(m[0]).filter(c => /\p{Nd}/u.test(c)).length >= 8 && !GROUPED.test(m[0]));
}

// langs are the app languages of the people involved; English is always checked
export function mask(text, langs = []) {
  const chars = Array.from(text.normalize('NFKC'));
  // fold one character at a time so a match can be mapped back to the characters that were typed
  let s = '';
  const at = [];
  chars.forEach((c, i) => {
    const f = fold(c);
    s += f;
    for (let k = 0; k < f.length; k++) at.push(i);
  });
  for (const re of rulesFor(langs)) {
    for (const m of s.matchAll(re)) {
      for (let i = at[m.index]; i <= at[m.index + m[0].length - 1]; i++) if (/\S/u.test(chars[i])) chars[i] = '*';
    }
  }
  return chars.join('');
}

// Chip trading is a phrase, not a word: a chip word next to a selling word, a payment channel, or an amount in lira. Found with the same
// folding as the swear list, so look-alikes and accents do not hide it. Only recorded by the caller; the line is never changed.
const CHIP = 'cip|cips|cipi|cipim|cipimi|cipler|cipleri|chip|chips';
const SELL = 'sat|satilik|satiyorum|satiyom|satarim|satan|alim|alirim|alicam|fiyat|fiyati|sell|selling|sold|sale|buy|buying|price|verkaufe|vendo|vends|compro';
const solo = p => new RegExp('(?<!' + WORD + ')(?:' + p + ')(?!' + WORD + ')', 'u');
const HAS = { chip: solo(CHIP), sell: solo(SELL), tl: solo('tl'), iban: solo('iban') };
const OPEN = { papara: new RegExp('(?<!' + WORD + ')papara', 'u'), ininal: new RegExp('(?<!' + WORD + ')ininal', 'u'), bozdur: new RegExp('(?<!' + WORD + ')bozdur', 'u') };
const AMOUNT = /(?<![\p{L}\p{N}])(?:\p{Nd}+(?:[.,]\p{Nd}+)?\s*(?:tl|₺)|(?:tl|₺)\s*\p{Nd}+)(?!\p{L})/u;

// the labels of the trade phrases in the text, none when it holds no trade phrase
export function trade(text) {
  const raw = text.normalize('NFKC').toLowerCase();
  const s = fold(raw);
  const out = [];
  const chip = HAS.chip.test(s);
  if (chip && HAS.sell.test(s)) out.push('chip-sale');
  if (HAS.iban.test(s)) out.push('iban');
  for (const k of Object.keys(OPEN)) if (OPEN[k].test(s)) out.push(k);
  if (AMOUNT.test(raw) || chip && HAS.tl.test(s)) out.push('tl');
  return out;
}

// what a person typed: one line, no control or format characters, at most max characters
export function clean(text, max) {
  if (typeof text !== 'string') return '';
  const s = text.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}\ufe00-\ufe0f]/gu, '');
  return Array.from(s.trim()).slice(0, max).join('').trim();
}

export const typed = (text, max, langs) => mask(clean(text, max), langs);
