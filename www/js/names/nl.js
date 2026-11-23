{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  const cap = s => s.charAt(0).toLocaleUpperCase('nl') + s.slice(1);
  // nouns carry their article (0 de, 1 het); adjectives are 'de-vorm/het-vorm' or one form for both
  N.add('nl', {
    adj: [
      'blauwe/blauw', 'rode/rood', 'gouden', 'zilveren', 'vlugge/vlug',
      'stille/stil', 'dappere/dapper', 'slimme/slim', 'fortuinlijke/fortuinlijk', 'rustige/rustig',
      'vrolijke/vrolijk', 'zachte/zacht', 'stoutmoedige/stoutmoedig', 'zonnige/zonnig', 'machtige/machtig',
      'wijze/wijs', 'blije/blij', 'gezellige/gezellig', 'snelle/snel', 'trotse/trots',
      'frisse/fris', 'mistige/mistig', 'besneeuwde/besneeuwd', 'stormachtige/stormachtig', 'amberkleurige/amberkleurig',
      'karmozijnrode/karmozijnrood', 'jadegroene/jadegroen', 'fluwelen', 'koperen', 'ivoren',
      'rozige/rozig', 'levendige/levendig', 'geduldige/geduldig', 'gewaagde/gewaagd', 'beleefde/beleefd',
      'bescheiden', 'scherpe/scherp', 'standvastige/standvastig', 'sierlijke/sierlijk', 'behendige/behendig'
    ],
    noun: [
      ['Arend', 0], ['Valk', 0], ['Vos', 0], ['Wolf', 0], ['Beer', 0],
      ['Lynx', 0], ['Hert', 1], ['Haas', 0], ['Uil', 0], ['Zwaan', 0],
      ['Kraanvogel', 0], ['Ooievaar', 0], ['Mus', 0], ['Zwaluw', 0], ['Nachtegaal', 0],
      ['Dolfijn', 0], ['Bever', 0], ['Schildpad', 0], ['Gazelle', 0], ['Panter', 0],
      ['Tijger', 0], ['Leeuw', 0], ['Paard', 1], ['Kameel', 0], ['Geit', 0],
      ['Ram', 0], ['Stier', 0], ['Duif', 0], ['Havik', 0], ['Raaf', 0],
      ['Reiger', 0], ['Das', 0], ['Eekhoorn', 0], ['Egel', 0], ['Vlinder', 0],
      ['Bij', 0], ['Libel', 0], ['Tulp', 0], ['Klaproos', 0], ['Ceder', 0]
    ],
    join: (a, n) => cap(N.form(a, n[1])) + ' ' + n[0]
  });
}
