{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  // nouns carry their gender (0 masculine, 1 feminine, 2 neuter); adjectives are 'er/e/es' forms or one form for all
  const st = s => s + 'er/' + s + 'e/' + s + 'es';
  N.add('de', {
    adj: [
      st('Blau'), st('Rot'), st('Golden'), st('Silbern'), st('Flink'),
      'Leiser/Leise/Leises', st('Mutig'), st('Schlau'), st('Glücklich'), st('Ruhig'),
      st('Lustig'), st('Sanft'), st('Kühn'), st('Sonnig'), st('Mächtig'),
      'Weiser/Weise/Weises', st('Fröhlich'), st('Gemütlich'), st('Rasant'), st('Stolz'),
      st('Frisch'), st('Neblig'), st('Verschneit'), st('Stürmisch'), 'Bernstein',
      st('Purpurn'), 'Jadegrün', st('Samtig'), st('Kupfern'), 'Elfenbein',
      st('Rosig'), 'Lebhafter/Lebhafte/Lebhaftes', st('Geduldig'), st('Wagemutig'), st('Höflich'),
      st('Bescheiden'), st('Scharf'), st('Beständig'), st('Anmutig'), st('Gewandt')
    ],
    noun: [
      ['Adler', 0], ['Falke', 0], ['Fuchs', 0], ['Wolf', 0], ['Bär', 0],
      ['Luchs', 0], ['Reh', 2], ['Hase', 0], ['Eule', 1], ['Schwan', 0],
      ['Kranich', 0], ['Storch', 0], ['Spatz', 0], ['Schwalbe', 1], ['Nachtigall', 1],
      ['Delfin', 0], ['Biber', 0], ['Schildkröte', 1], ['Gazelle', 1], ['Panther', 0],
      ['Tiger', 0], ['Löwe', 0], ['Pferd', 2], ['Kamel', 2], ['Ziege', 1],
      ['Widder', 0], ['Stier', 0], ['Taube', 1], ['Habicht', 0], ['Rabe', 0],
      ['Reiher', 0], ['Dachs', 0], ['Eichhörnchen', 2], ['Igel', 0], ['Schmetterling', 0],
      ['Biene', 1], ['Libelle', 1], ['Tulpe', 1], ['Mohn', 0], ['Zeder', 1]
    ],
    join: (a, n) => N.form(a, n[1]) + ' ' + n[0]
  });
}
