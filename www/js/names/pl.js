{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  // nouns carry their gender (0 masculine, 1 feminine); adjectives are 'masculine/feminine'
  N.add('pl', {
    adj: [
      'Niebieski/Niebieska', 'Czerwony/Czerwona', 'Złoty/Złota', 'Srebrny/Srebrna', 'Rączy/Rącza',
      'Cichy/Cicha', 'Odważny/Odważna', 'Sprytny/Sprytna', 'Szczęśliwy/Szczęśliwa', 'Spokojny/Spokojna',
      'Radosny/Radosna', 'Łagodny/Łagodna', 'Śmiały/Śmiała', 'Słoneczny/Słoneczna', 'Potężny/Potężna',
      'Mądry/Mądra', 'Wesoły/Wesoła', 'Przytulny/Przytulna', 'Szybki/Szybka', 'Dumny/Dumna',
      'Świeży/Świeża', 'Mglisty/Mglista', 'Śnieżny/Śnieżna', 'Burzowy/Burzowa', 'Bursztynowy/Bursztynowa',
      'Karmazynowy/Karmazynowa', 'Jadeitowy/Jadeitowa', 'Aksamitny/Aksamitna', 'Miedziany/Miedziana', 'Kremowy/Kremowa',
      'Różowy/Różowa', 'Żwawy/Żwawa', 'Cierpliwy/Cierpliwa', 'Dzielny/Dzielna', 'Uprzejmy/Uprzejma',
      'Skromny/Skromna', 'Bystry/Bystra', 'Niezłomny/Niezłomna', 'Wdzięczny/Wdzięczna', 'Zwinny/Zwinna'
    ],
    noun: [
      ['Orzeł', 0], ['Sokół', 0], ['Lis', 0], ['Wilk', 0], ['Niedźwiedź', 0],
      ['Ryś', 0], ['Sarna', 1], ['Zając', 0], ['Sowa', 1], ['Łabędź', 0],
      ['Żuraw', 0], ['Bocian', 0], ['Wróbel', 0], ['Jaskółka', 1], ['Słowik', 0],
      ['Delfin', 0], ['Bóbr', 0], ['Żółw', 0], ['Gazela', 1], ['Pantera', 1],
      ['Tygrys', 0], ['Lew', 0], ['Koń', 0], ['Wielbłąd', 0], ['Kozica', 1],
      ['Muflon', 0], ['Byk', 0], ['Gołąb', 0], ['Jastrząb', 0], ['Kruk', 0],
      ['Czapla', 1], ['Borsuk', 0], ['Wiewiórka', 1], ['Jeż', 0], ['Motyl', 0],
      ['Pszczoła', 1], ['Ważka', 1], ['Tulipan', 0], ['Mak', 0], ['Cedr', 0]
    ],
    join: (a, n) => N.form(a, n[1]) + ' ' + n[0]
  });
}
