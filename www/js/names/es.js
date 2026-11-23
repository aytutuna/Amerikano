{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  const cap = s => s.charAt(0).toLocaleUpperCase('es') + s.slice(1);
  // nouns carry their gender (0 masculine, 1 feminine); adjectives are 'masculino/femenino' or one form for both
  N.add('es', {
    adj: [
      'azul', 'rojo/roja', 'dorado/dorada', 'plateado/plateada', 'veloz',
      'callado/callada', 'valiente', 'listo/lista', 'afortunado/afortunada', 'tranquilo/tranquila',
      'alegre', 'amable', 'audaz', 'soleado/soleada', 'fuerte',
      'sabio/sabia', 'feliz', 'acogedor/acogedora', 'rápido/rápida', 'orgulloso/orgullosa',
      'lozano/lozana', 'brumoso/brumosa', 'nevado/nevada', 'tormentoso/tormentosa', 'ámbar',
      'carmesí', 'jade', 'aterciopelado/aterciopelada', 'cobrizo/cobriza', 'marfil',
      'rosado/rosada', 'vivaz', 'paciente', 'atrevido/atrevida', 'cortés',
      'modesto/modesta', 'filoso/filosa', 'firme', 'elegante', 'ágil'
    ],
    noun: [
      ['Águila', 1], ['Halcón', 0], ['Zorro', 0], ['Lobo', 0], ['Oso', 0],
      ['Lince', 0], ['Venado', 0], ['Liebre', 1], ['Búho', 0], ['Cisne', 0],
      ['Grulla', 1], ['Cigüeña', 1], ['Gorrión', 0], ['Golondrina', 1], ['Ruiseñor', 0],
      ['Delfín', 0], ['Castor', 0], ['Tortuga', 1], ['Gacela', 1], ['Pantera', 1],
      ['Tigre', 0], ['León', 0], ['Caballo', 0], ['Llama', 1], ['Cabra', 1],
      ['Carnero', 0], ['Toro', 0], ['Paloma', 1], ['Gavilán', 0], ['Cuervo', 0],
      ['Garza', 1], ['Tejón', 0], ['Ardilla', 1], ['Erizo', 0], ['Mariposa', 1],
      ['Abeja', 1], ['Libélula', 1], ['Tulipán', 0], ['Amapola', 1], ['Cedro', 0]
    ],
    join: (a, n) => n[0] + ' ' + cap(N.form(a, n[1]))
  });
}
