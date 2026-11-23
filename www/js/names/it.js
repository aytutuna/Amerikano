{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  // nouns carry their gender (0 masculine, 1 feminine); adjectives are 'maschile/femminile' or one form for both
  N.add('it', {
    adj: [
      'blu', 'rosso/rossa', 'dorato/dorata', 'argentato/argentata', 'veloce',
      'silenzioso/silenziosa', 'coraggioso/coraggiosa', 'furbo/furba', 'fortunato/fortunata', 'calmo/calma',
      'allegro/allegra', 'gentile', 'audace', 'soleggiato/soleggiata', 'possente',
      'saggio/saggia', 'felice', 'accogliente', 'rapido/rapida', 'fiero/fiera',
      'fresco/fresca', 'nebbioso/nebbiosa', 'innevato/innevata', 'tempestoso/tempestosa', 'ambrato/ambrata',
      'cremisi', 'giada', 'vellutato/vellutata', 'ramato/ramata', 'avorio',
      'rosato/rosata', 'vivace', 'paziente', 'ardito/ardita', 'educato/educata',
      'modesto/modesta', 'acuto/acuta', 'saldo/salda', 'aggraziato/aggraziata', 'agile'
    ],
    noun: [
      ['Aquila', 1], ['Falco', 0], ['Volpe', 1], ['Lupo', 0], ['Orso', 0],
      ['Lince', 1], ['Cervo', 0], ['Lepre', 1], ['Gufo', 0], ['Cigno', 0],
      ['Gru', 1], ['Cicogna', 1], ['Passero', 0], ['Rondine', 1], ['Usignolo', 0],
      ['Delfino', 0], ['Castoro', 0], ['Tartaruga', 1], ['Gazzella', 1], ['Pantera', 1],
      ['Tigre', 1], ['Leone', 0], ['Cavallo', 0], ['Cammello', 0], ['Stambecco', 0],
      ['Ariete', 0], ['Toro', 0], ['Colomba', 1], ['Sparviero', 0], ['Corvo', 0],
      ['Airone', 0], ['Tasso', 0], ['Scoiattolo', 0], ['Riccio', 0], ['Farfalla', 1],
      ['Ape', 1], ['Libellula', 1], ['Tulipano', 0], ['Papavero', 0], ['Cedro', 0]
    ],
    join: (a, n) => n[0] + ' ' + N.form(a, n[1]).replace(/^./, c => c.toLocaleUpperCase('it'))
  });
}
