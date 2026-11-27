// Turkish wording across the client and the server: one term for each thing, and none of the words the game never uses.
// Also fails when a push text in any language mentions the shop, packs, offers, prices or VIP.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '../..');
const read = f => fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '';
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

const i18n = read('www/js/i18n.js');
const sources = {
  'www/js/i18n.js': between(i18n, 'const tr = {', 'const S = {'),
  'www/js/game.js': read('www/js/game.js').split(/\r?\n/).filter(l => /\b(tr|gl): '/.test(l)).join('\n'),
  'www/privacy.html': between(read('www/privacy.html'), '<section id="tr"', '</section>'),
  'www/404.html': between(read('www/404.html'), '<section id="tr"', '</section>'),
  'server/src/push.js': between(read('server/src/push.js'), '  tr: {', '\n  }\n};')
};

// what the game says is the word, and what it must not say instead
const TERMS = [
  ['stake', 'masa değeri', 'masa bedeli'],
  ['fee', 'masa ücreti', 'komisyon|masa payı'],
  ['card back', 'kart arkası', 'kağıt sırt|kart sırt|arka yüz|kağıt arka'],
  ['score paper', 'puan kağıdı', 'skor kâğ|skor kağ|skor tablo|puan tablo|puan çizelge'],
  ['spelling', 'kağıt', 'kâğıd|kâğıt|kagit|kagid|kâgıt|kağit|kağid'],
  ['seat', 'koltuk', 'sandalye|oturak'],
  ['invite', 'davet', 'çağır|çağrı'],
  ['daily bonus', 'günlük bonus', 'günlük ödül|günlük hediye|günlük ikramiye'],
  ['season pass', 'sezon kartı', 'sezon bilet|sezon geçiş|sezon pas'],
  ['cup entry', 'katılım bedeli', 'giriş bedel|giriş ücret|katılım ücret|kayıt ücret']
];
const NEVER = 'bahs|bahis|kumar|casino|kazino|kasino|para kazan';
const word = p => new RegExp('(?<![\\p{L}])(?:' + p + ')', 'giu');

const bad = [];
const lower = s => s.toLocaleLowerCase('tr');
for (const [file, src] of Object.entries(sources)) {
  const text = lower(src);
  for (const [what, use, not] of TERMS) {
    for (const m of text.matchAll(word(not))) bad.push(file + ': ' + what + ' is "' + use + '", found "' + m[0] + '"');
  }
  for (const m of text.matchAll(word(NEVER))) bad.push(file + ': "' + m[0] + '" is never used');
  // the first Turkish sentence of an error must say what happened, not just "Olmadı"
  for (const m of src.matchAll(/'(Olmadı\.?)'/g)) bad.push(file + ': a bare "' + m[1] + '"');
}
if (!Object.values(sources).some(s => s.length > 1000)) bad.push('no Turkish text found');

// push texts in every language: about the table, the game and friends only
const SHOP = {
  en: 'shop|store|pack|offer|price|vip|buy|purchase|sale|discount|premium',
  tr: 'mağaza|paket|teklif|fırsat|fiyat|vip|satın|indirim|premium',
  es: 'tienda|paquete|oferta|precio|vip|comprar|compra|descuento',
  pt: 'loja|pacote|oferta|preço|vip|comprar|compra|desconto',
  fr: 'boutique|pack|offre|prix|vip|acheter|achat|réduction|solde',
  de: 'shop|laden|paket|angebot|preis|vip|kaufen|kauf|rabatt',
  it: 'negozio|pacchetto|offerta|prezzo|vip|acquist|sconto',
  nl: 'winkel|pakket|aanbieding|prijs|vip|kopen|koop|korting',
  pl: 'sklep|pakiet|oferta|cena|vip|kup|zakup|zniżk',
  ru: 'магазин|пакет|предложен|цена|цены|vip|купи|покупк|скидк',
  uk: 'магазин|пакет|пропозиці|ціна|ціни|vip|купи|покупк|знижк',
  ar: 'متجر|عرض|سعر|vip|شراء|خصم',
  hi: 'दुकान|पैक|ऑफ़र|कीमत|vip|खरीद|छूट',
  id: 'toko|paket|penawaran|harga|vip|beli|pembelian|diskon',
  ja: 'ショップ|ストア|パック|セール|価格|vip|購入|割引',
  ko: '상점|팩|할인|가격|vip|구매',
  'zh-Hans': '商店|商城|礼包|优惠|价格|vip|购买|折扣',
  'zh-Hant': '商店|商城|禮包|優惠|價格|vip|購買|折扣'
};

(async () => {
  const { TEXT } = await import(pathToFileURL(path.join(root, 'server/src/push.js')).href);
  const v = { seed: 7, n: 1300, won: 5000, rank: 3 };
  for (const [lang, t] of Object.entries(TEXT)) {
    const spaced = !/^(ar|hi|ja|ko|zh)/.test(lang);
    const re = SHOP[lang] && new RegExp((spaced ? '(?<!\\p{L})' : '') + '(?:' + SHOP[lang] + ')', 'iu');
    if (!re) { bad.push('push: no shop word list for ' + lang); continue; }
    for (const [k, f] of Object.entries(t)) {
      const s = f(v).join(' ');
      if (re.test(s)) bad.push('push ' + lang + '.' + k + ' mentions the shop: ' + s);
      if (lang === 'tr' && word(NEVER).test(lower(s))) bad.push('push tr.' + k + ': never-used word');
    }
  }
  for (const b of bad) console.log(b);
  console.log(bad.length ? bad.length + ' to look at' : 'turkish: complete');
  process.exit(bad.length ? 1 : 0);
})();
