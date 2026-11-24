var Catalog = (function () {
  const SLOTS = ['frame', 'plate', 'back', 'felt', 'emote'];
  // a worn slot, as opposed to emote packs that work as soon as they are owned
  const WORN = ['frame', 'plate', 'back', 'felt'];
  const PACKS = [80, 500, 1200, 2500, 6500, 14000, 30000];
  const PREFIX = 'com.aytutuna.amerikano.tokens.';
  const DAILY = 20;
  const MATCH = 2;

  // vip: true would keep an item for subscribers only
  const ITEMS = [
    { id: 'frame-brass', slot: 'frame', price: 250 },
    { id: 'frame-laurel', slot: 'frame', price: 400 },
    { id: 'frame-kilim', slot: 'frame', price: 500 },
    { id: 'frame-moon', slot: 'frame', price: 600 },
    { id: 'frame-ember', slot: 'frame', price: 750 },
    { id: 'frame-royal', slot: 'frame', price: 1000 },
    { id: 'plate-oak', slot: 'plate', price: 250 },
    { id: 'plate-copper', slot: 'plate', price: 400 },
    { id: 'plate-kilim', slot: 'plate', price: 500 },
    { id: 'plate-night', slot: 'plate', price: 700 },
    { id: 'plate-gilt', slot: 'plate', price: 900 },
    { id: 'back-lattice', slot: 'back', price: 300 },
    { id: 'back-emerald', slot: 'back', price: 400 },
    { id: 'back-amber', slot: 'back', price: 500 },
    { id: 'back-star', slot: 'back', price: 700 },
    { id: 'back-sultan', slot: 'back', price: 900 },
    { id: 'felt-plum', slot: 'felt', price: 300 },
    { id: 'felt-ink', slot: 'felt', price: 400 },
    { id: 'felt-copper', slot: 'felt', price: 500 },
    { id: 'felt-teal', slot: 'felt', price: 600 },
    { id: 'felt-kilim', slot: 'felt', price: 800 },
    { id: 'emo-cafe', slot: 'emote', price: 400, emotes: ['tea', 'cezve', 'baklava', 'lamp'] },
    { id: 'emo-luck', slot: 'emote', price: 500, emotes: ['eye', 'clover', 'shoe', 'dice'] },
    { id: 'emo-cheek', slot: 'emote', price: 600, emotes: ['shades', 'flame', 'zzz', 'clap'] }
  ];

  const byId = Object.fromEntries(ITEMS.map(i => [i.id, i]));
  const pack = key => ITEMS.find(i => i.emotes && i.emotes.includes(key));

  const product = n => PREFIX + n;
  // the token amount of a product id, 0 for anything that is not a pack
  const amount = id => {
    const n = typeof id === 'string' && id.startsWith(PREFIX) ? Number(id.slice(PREFIX.length)) : 0;
    return PACKS.includes(n) ? n : 0;
  };

  return { SLOTS: SLOTS, WORN: WORN, ITEMS: ITEMS, PACKS: PACKS, DAILY: DAILY, MATCH: MATCH, item: id => byId[id], pack: pack, product: product, amount: amount };
})();

if (typeof module !== 'undefined') module.exports = Catalog;
