var Names = (function () {
  const ADJ = [
    ['Blue', 'Mavi'], ['Red', 'Kırmızı'], ['Golden', 'Altın'], ['Silver', 'Gümüş'], ['Swift', 'Çevik'],
    ['Quiet', 'Sessiz'], ['Brave', 'Cesur'], ['Clever', 'Zeki'], ['Lucky', 'Şanslı'], ['Calm', 'Sakin'],
    ['Merry', 'Neşeli'], ['Gentle', 'Nazik'], ['Bold', 'Atılgan'], ['Sunny', 'Güneşli'], ['Mighty', 'Güçlü'],
    ['Wise', 'Bilge'], ['Happy', 'Mutlu'], ['Cozy', 'Rahat'], ['Rapid', 'Hızlı'], ['Proud', 'Gururlu'],
    ['Fresh', 'Taze'], ['Misty', 'Puslu'], ['Snowy', 'Karlı'], ['Stormy', 'Fırtınalı'], ['Amber', 'Kehribar'],
    ['Crimson', 'Kızıl'], ['Jade', 'Yeşim'], ['Velvet', 'Kadife'], ['Copper', 'Bakır'], ['Ivory', 'Fildişi'],
    ['Rosy', 'Pembe'], ['Lively', 'Canlı'], ['Patient', 'Sabırlı'], ['Daring', 'Yürekli'], ['Polite', 'Kibar'],
    ['Modest', 'Mütevazı'], ['Sharp', 'Keskin'], ['Steady', 'Sağlam'], ['Graceful', 'Zarif'], ['Nimble', 'Atik']
  ];
  const NOUN = [
    ['Eagle', 'Kartal'], ['Falcon', 'Şahin'], ['Fox', 'Tilki'], ['Wolf', 'Kurt'], ['Bear', 'Ayı'],
    ['Lynx', 'Vaşak'], ['Deer', 'Geyik'], ['Hare', 'Tavşan'], ['Owl', 'Baykuş'], ['Swan', 'Kuğu'],
    ['Crane', 'Turna'], ['Stork', 'Leylek'], ['Sparrow', 'Serçe'], ['Swallow', 'Kırlangıç'], ['Nightingale', 'Bülbül'],
    ['Dolphin', 'Yunus'], ['Beaver', 'Kunduz'], ['Turtle', 'Kaplumbağa'], ['Gazelle', 'Ceylan'], ['Panther', 'Panter'],
    ['Tiger', 'Kaplan'], ['Lion', 'Aslan'], ['Horse', 'At'], ['Camel', 'Deve'], ['Goat', 'Keçi'],
    ['Ram', 'Koç'], ['Bull', 'Boğa'], ['Pigeon', 'Güvercin'], ['Hawk', 'Doğan'], ['Raven', 'Karga'],
    ['Heron', 'Balıkçıl'], ['Badger', 'Porsuk'], ['Squirrel', 'Sincap'], ['Hedgehog', 'Kirpi'], ['Butterfly', 'Kelebek'],
    ['Bee', 'Arı'], ['Dragonfly', 'Yusufçuk'], ['Tulip', 'Lale'], ['Poppy', 'Gelincik'], ['Cedar', 'Sedir']
  ];

  // a seed is adjective index * 100 + noun index, so it reads the same in either language
  function text(seed, lang) {
    const k = lang === 'tr' ? 1 : 0;
    const a = ADJ[Math.floor(seed / 100)];
    const n = NOUN[seed % 100];
    return a && n ? a[k] + ' ' + n[k] : '?';
  }

  function pick() {
    const r = new Uint32Array(2);
    crypto.getRandomValues(r);
    return (r[0] % ADJ.length) * 100 + r[1] % NOUN.length;
  }

  return { text: text, pick: pick };
})();

if (typeof module !== 'undefined') module.exports = Names;
