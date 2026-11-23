{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  const cap = s => s.charAt(0).toLocaleUpperCase('pt') + s.slice(1);
  // nouns carry their gender (0 masculine, 1 feminine); adjectives are 'masculino/feminino' or one form for both
  N.add('pt', {
    adj: [
      'azul', 'vermelho/vermelha', 'dourado/dourada', 'prateado/prateada', 'veloz',
      'calado/calada', 'valente', 'esperto/esperta', 'sortudo/sortuda', 'calmo/calma',
      'alegre', 'gentil', 'ousado/ousada', 'ensolarado/ensolarada', 'poderoso/poderosa',
      'sábio/sábia', 'feliz', 'aconchegante', 'rápido/rápida', 'orgulhoso/orgulhosa',
      'fresco/fresca', 'nebuloso/nebulosa', 'nevado/nevada', 'tempestuoso/tempestuosa', 'âmbar',
      'carmesim', 'jade', 'aveludado/aveludada', 'acobreado/acobreada', 'marfim',
      'rosado/rosada', 'animado/animada', 'paciente', 'destemido/destemida', 'educado/educada',
      'modesto/modesta', 'afiado/afiada', 'firme', 'elegante', 'ágil'
    ],
    noun: [
      ['Águia', 1], ['Falcão', 0], ['Raposa', 1], ['Lobo', 0], ['Urso', 0],
      ['Lince', 0], ['Cervo', 0], ['Lebre', 1], ['Coruja', 1], ['Cisne', 0],
      ['Grou', 0], ['Cegonha', 1], ['Pardal', 0], ['Andorinha', 1], ['Rouxinol', 0],
      ['Golfinho', 0], ['Castor', 0], ['Tartaruga', 1], ['Gazela', 1], ['Pantera', 1],
      ['Tigre', 0], ['Leão', 0], ['Cavalo', 0], ['Camelo', 0], ['Cabra', 1],
      ['Carneiro', 0], ['Touro', 0], ['Pombo', 0], ['Gavião', 0], ['Corvo', 0],
      ['Garça', 1], ['Texugo', 0], ['Esquilo', 0], ['Ouriço', 0], ['Borboleta', 1],
      ['Abelha', 1], ['Libélula', 1], ['Tulipa', 1], ['Papoula', 1], ['Cedro', 0]
    ],
    join: (a, n) => n[0] + ' ' + cap(N.form(a, n[1]))
  });
}
