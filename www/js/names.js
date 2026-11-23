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

  // a language supplies one word per index: adj[i] and noun[i] in any shape, and join(adj, noun) to put them in order
  const D = {
    en: { adj: ADJ.map(x => x[0]), noun: NOUN.map(x => x[0]), join: (a, n) => a + ' ' + n },
    tr: { adj: ADJ.map(x => x[1]), noun: NOUN.map(x => x[1]), join: (a, n) => a + ' ' + n }
  };

  // a seed is adjective index * 100 + noun index, so it reads the same in every language
  function text(seed, lang) {
    const d = D[lang] || D.en;
    const a = d.adj[Math.floor(seed / 100)];
    const n = d.noun[seed % 100];
    return a && n ? d.join(a, n) : '?';
  }

  // 'rojo/roja' for a word with one form per gender, 'azul' for one that never changes
  function form(w, g) {
    const f = w.split('/');
    return f[g] || f[0];
  }

  function pick() {
    const r = new Uint32Array(2);
    crypto.getRandomValues(r);
    return (r[0] % ADJ.length) * 100 + r[1] % NOUN.length;
  }

  // fixed picks for bots: the same number always gives the same name
  function at(n) {
    return (n % ADJ.length) * 100 + Math.floor(n / ADJ.length) % NOUN.length;
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  return { text: text, pick: pick, at: at, hash: hash, form: form, add: (l, d) => { D[l] = d; }, D: D };
})();

if (typeof module !== 'undefined') module.exports = Names;
