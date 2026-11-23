// Typed chat goes through here before anyone sees it: whitespace and control characters are cleaned up, then profanity,
// slurs and contact details are masked with asterisks. Words match after case, accents and common look-alikes are
// folded away, and a letter typed twice still counts. A word ending in * also matches what follows it; _ is a space.
const WORDS = {
  en: 'fuck* fuk* shit* bullshit* bitch* bastard* asshole* dickhead* dick cunt* whore* slut* nigger* nigga* faggot* fag retard* tranny kike* spic chink* wetback* pussy cocksucker* motherfuck* twat wanker* jackass ass arse',
  tr: 'orospu* sik sikik* siktir* sikeyim* sikerim* sikim* siktim* amk aq amq aminakoy* amina_koy* amcik* yarrak* piclik* pust ibne* pezevenk* gotveren* gotunu* kahpe* dalyarak* yavsak* gavat* serefsiz* ananisik* anani_sik*',
  es: 'puta putas putita* puto putos mierda* joder* jodete cojones pendejo* pendeja* cabron* cabrona* chinga* chingad* verga culo culero* culera* marica* maricon* gilipollas* hijueputa* hijoputa* concha_tu* conchatu* boludo* pelotudo*',
  pt: 'caralho* porra foda fodase foder* fodido* fodida* buceta* bucetas viado* viadinho* arrombado* cuzao* otario* babaca* merda* merdas filho_da_puta* fdp vsf corno',
  fr: 'merde* putain* pute putes salope* salopard* connard* connasse* encule* enculer* nique* niquer* batard* bordel couille* couilles ntm pede',
  de: 'scheiss* arschloch* arsch wichser* fotze* hurensohn* hure huren schlampe* ficken fick ficker* verpiss* verfickt* drecksau* spast* schwuchtel* neger* mistkerl*',
  it: 'cazzo* merda* stronz* vaffanculo* fanculo* puttana* troia troie figa minchia* coglione* coglioni bastardo* frocio* froci pompino* mignotta* culattone*',
  nl: 'kut kutje* kanker* tering* klootzak* lul lullen hoer hoeren godverdomme* godver* tyfus* flikker* neuk* neuken slet mongool*',
  pl: 'kurw* chuj* chuja huj cipa cipka* pierdol* spierdalaj* spierdalac* pizd* jebac* jeban* jebany* jebie* jebnij* dupek* skurwysyn* cwel* debil*',
  ru: 'хуй* хуе* хуя* хуи* пизд* бляд* блят* бля ебан* ебат* ебал* ебу* еблан* заеб* выеб* уеб* наеб* съеб* ебись сука суки сучк* сукин* мудак* мудил* пидор* пидар* пидр* гандон* залуп* шлюх* долбоеб* говн* дерьм* жопа* педик* чмо',
  uk: 'хуй* хуйл* хуйн* пизд* бляд* бляч* їбан* їбат* їбу* їбл* йобан* йобнут* сука суки сучка* курв* шльонд* підар* підор* підр* гандон* мудак* мудил* залуп* срак* довбойоб* довбоеб* уйобок* мразот*',
  ar: 'كس كسم* كسك* كسخت* زب شرموط* عرص* منيوك* منيك ابن_الكلب ابن_الشرموطة يلعن_ابو* قحب* عاهر* متناك* خول',
  hi: 'चूतिया* चुतिया* मादरचोद* बहनचोद* भोसड़ी* भोसडी* गांडू* गांड* रंडी* हरामी* हरामज़ादा* हरामजादा* लौड़ा* लवड़ा* chutiya* chutia* madarchod* maderchod* behenchod* bhenchod* bhosd* bhosad* gandu* gaandu* gaand* harami* haramzade* haramzada*',
  id: 'anjing* bangsat* babi kontol* memek* ngentot* jancok* jancuk* bajingan* goblok* tolol* sialan* pantek* perek bencong*',
  ja: '死ね クソ 糞 ちんこ ちんぽ まんこ ファック ビッチ きちがい くたばれ チンコ マンコ',
  ko: '씨발 시발 씨팔 병신 개새끼 좆 존나 지랄 미친놈 미친년 썅',
  zh: '操你 肏 他妈的 他媽的 妈的 媽的 傻逼 傻屄 煞笔 屄 婊子 狗屎 滚蛋 滾蛋 去死 王八蛋 贱人 賤人 鸡巴 雞巴 屌'
};

const SWAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', ł: 'l', ø: 'o', đ: 'd', ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', أ: 'ا', إ: 'ا', آ: 'ا', ى: 'ي', ة: 'ه' };
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const WORD = '[\\p{L}\\p{N}\\p{M}]';

const fold = s => Array.from(s.toLowerCase().normalize('NFKD').replace(/[̀-ًͯ-ٟـ]/g, '').normalize('NFKC'), c => SWAP[c] || c).join('');
const esc = c => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

// a letter typed once or more matches; a doubled letter in the word still needs both
function pattern(entry) {
  const open = entry.endsWith('*');
  const w = fold(entry.replace('*', ''));
  if (CJK.test(w)) return esc(w);
  const body = Array.from(w.matchAll(/(.)\1*/gu), m => m[1] === '_' ? '\\s+' : esc(m[1]) + (m[0].length > 1 ? '{' + m[0].length + ',}' : '+')).join('');
  return '(?<!' + WORD + ')' + body + (open ? WORD + '*' : '(?!' + WORD + ')');
}

const all = [...new Set(Object.values(WORDS).flatMap(l => l.split(' ')))];
const spaced = new RegExp(all.filter(w => !CJK.test(w)).map(pattern).join('|'), 'gu');
const packed = new RegExp(all.filter(w => CJK.test(w)).map(pattern).join('|'), 'gu');

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const LINK = /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|io|me|gg|tv|app|co|xyz|info|biz|ru|ly|cc)(?![\p{L}\p{N}])(?:\/\S*)?/giu;
const PHONE = /(?:\+?\p{Nd}[\s().-]?){8,}/gu;

const stars = m => m.replace(/\S/gu, '*');

export function mask(text) {
  const chars = Array.from(text.replace(EMAIL, stars).replace(LINK, stars).replace(PHONE, stars));
  // fold one character at a time so a match can be mapped back to the characters that were typed
  let s = '';
  const at = [];
  chars.forEach((c, i) => {
    const f = fold(c);
    s += f;
    for (let k = 0; k < f.length; k++) at.push(i);
  });
  for (const re of [spaced, packed]) {
    for (const m of s.matchAll(re)) {
      for (let i = at[m.index]; i <= at[m.index + m[0].length - 1]; i++) if (/\S/u.test(chars[i])) chars[i] = '*';
    }
  }
  return chars.join('');
}

// what a person typed, as it is shown: one line, no control characters, at most max characters
export function clean(text, max) {
  if (typeof text !== 'string') return '';
  const s = text.replace(/\s+/g, ' ').replace(/[\p{Cc}​-‏‪-‮⁦-⁩﻿]/gu, '');
  return Array.from(s.trim()).slice(0, max).join('').trim();
}

export const typed = (text, max) => mask(clean(text, max));
