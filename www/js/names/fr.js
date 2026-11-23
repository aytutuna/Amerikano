{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  // nouns carry their gender (0 masculine, 1 feminine); adjectives are 'masculin/féminin' or one form for both
  N.add('fr', {
    adj: [
      'bleu/bleue', 'rouge', 'doré/dorée', 'argenté/argentée', 'vif/vive',
      'discret/discrète', 'vaillant/vaillante', 'malin/maligne', 'chanceux/chanceuse', 'calme',
      'joyeux/joyeuse', 'doux/douce', 'audacieux/audacieuse', 'ensoleillé/ensoleillée', 'puissant/puissante',
      'sage', 'heureux/heureuse', 'cosy', 'rapide', 'fier/fière',
      'frais/fraîche', 'brumeux/brumeuse', 'neigeux/neigeuse', 'orageux/orageuse', 'ambré/ambrée',
      'carmin', 'jade', 'velouté/veloutée', 'cuivré/cuivrée', 'ivoire',
      'rosé/rosée', 'enjoué/enjouée', 'patient/patiente', 'intrépide', 'poli/polie',
      'modeste', 'aiguisé/aiguisée', 'solide', 'gracieux/gracieuse', 'agile'
    ],
    noun: [
      ['Aigle', 0], ['Faucon', 0], ['Renard', 0], ['Loup', 0], ['Ours', 0],
      ['Lynx', 0], ['Cerf', 0], ['Lièvre', 0], ['Chouette', 1], ['Cygne', 0],
      ['Grue', 1], ['Cigogne', 1], ['Moineau', 0], ['Hirondelle', 1], ['Rossignol', 0],
      ['Dauphin', 0], ['Castor', 0], ['Tortue', 1], ['Gazelle', 1], ['Panthère', 1],
      ['Tigre', 0], ['Lion', 0], ['Cheval', 0], ['Dromadaire', 0], ['Chèvre', 1],
      ['Bélier', 0], ['Taureau', 0], ['Colombe', 1], ['Épervier', 0], ['Corbeau', 0],
      ['Héron', 0], ['Tasson', 0], ['Écureuil', 0], ['Hérisson', 0], ['Papillon', 0],
      ['Abeille', 1], ['Libellule', 1], ['Tulipe', 1], ['Coquelicot', 0], ['Cèdre', 0]
    ],
    join: (a, n) => n[0] + ' ' + N.form(a, n[1]).replace(/^./, c => c.toLocaleUpperCase('fr'))
  });
}
