var I18n = (function () {
  let lang = 'en';
  let pref = 'auto';
  const RANKS = ['', 'ace', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king'];
  const PLURAL = ['', 'aces', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings'];
  const SUITS = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
  const cards = n => n === 1 ? '1 card' : n + ' cards';
  const chips = n => n === 1 ? '1 chip' : n + ' chips';
  const num = n => String(n).replace('-', '−');
  const lc = s => s.charAt(0).toLowerCase() + s.slice(1);

  const cap = s => s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);

  const en = {
    you: 'You',
    joker: 'Joker',
    cards: cards,
    rank: v => RANKS[v.r],
    plural: v => PLURAL[v.r],
    suit: v => SUITS[v.s],
    card: (v, t) => v.r ? t('rank', v) + ' of ' + t('suit', v) : 'joker',
    short: v => v.r === 1 ? 'A' : v.r === 11 ? 'J' : v.r === 12 ? 'Q' : v.r === 13 ? 'K' : String(v.r),
    selected: 'selected',
    selSay: v => cap(v.card) + (v.on ? ' selected.' : ' not selected.'),
    posSay: v => cap(v.card) + ', position ' + v.n + ' of ' + v.of + '.',
    sortedSay: v => v.suit ? 'Sorted by suit.' : 'Sorted by rank.',

    task: v => {
      const s = v.task.en.replace(' + ', ' and ');
      return s[0].toUpperCase() + s.slice(1);
    },
    taskSub: v => v.task.tr,
    taskNone: 'Choosing a task',

    menu: 'Menu',
    score: 'Score',
    pot: v => 'Pot ' + v.n,
    gameOf: v => 'Game ' + v.n + ' of ' + v.of,
    lastGame: v => 'Last game ' + v.n + ' of ' + v.of,

    playing: 'Playing',
    opened: 'Opened',
    seat: v => v.name + ', ' + cards(v.n) + (v.turn ? ', playing' : '') + (v.opened ? ', opened' : '') + ', score ' + num(v.score),
    ptsShort: v => num(v.n) + ' pts',
    points: v => v.n === 1 ? '1 point' : num(v.n) + ' points',
    rackInfo: v => cards(v.n) + ', ' + v.pts + ' points',
    hand: 'Your hand',
    seatsLabel: 'Opponents',
    ctlLabel: 'Piles and actions',
    stock: v => 'Stock, ' + cards(v.n),
    stockDraw: v => 'Stock, ' + cards(v.n) + '. Draw a card',
    stockEmpty: 'Stock is empty',
    discardPile: v => v.card ? 'Discard pile, top card ' + v.card : 'Discard pile, empty',
    discardTake: v => 'Discard pile. Take the ' + v.card,
    discardPut: v => 'Discard pile. Discard the selected card',
    lipOpened: 'opened',

    noMelds: 'No melds on the table yet.',
    yourMelds: 'Your melds',
    theirMelds: v => v.name + '’s melds',
    meldSet: v => 'Set of ' + v.what,
    meldRun: v => 'Run of ' + v.what,
    meldJokers: 'jokers',
    meldAny: 'a meld',
    meldBy: v => v.label + ', ' + v.who,
    meldRange: v => RANKS[v.a > 13 ? v.a - 13 : v.a] + ' to ' + RANKS[v.b > 13 ? v.b - 13 : v.b],
    meldAdd: v => 'Add selected cards to ' + lc(v.label) + v.more,
    cardIn: v => cap(v.card) + ' in ' + lc(v.label),

    sortSuit: 'Sort by suit',
    sortRank: 'Sort by rank',
    moveLeft: 'Move left',
    moveRight: 'Move right',
    open: 'Open',
    finish: 'Finish',
    meld: 'New meld',
    discard: 'Discard',
    clear: 'Clear',

    st: {
      choose: 'Choose a task for this game.',
      chooseBot: v => v.name + ' is choosing a task.',
      draw: v => v.card ? 'Your turn. Draw from the stock or take the ' + v.card + '.' : 'Your turn. Draw a card from the stock.',
      bot: v => v.name + ' is playing.',
      claimBot: v => v.name + ' is deciding about the ' + v.card + '.',
      need: v => v.n === 1 ? 'You need 1 more card for this task.' : 'You need ' + v.n + ' more cards for this task.',
      needAra: v => v.n === 1 ? 'One more card has to fit into a meld.' : v.n + ' more cards have to fit into melds.',
      canOpen: 'You can open now.',
      canFinish: 'You can go out now.',
      ready: 'Add cards, lay a new meld, or discard one.',
      just: 'You opened. Discard a card to end your turn.',
      sel: v => v.n + ' selected.',
      pickOne: 'Pick a card to discard.',
      over: 'Game over.',
      matchOver: 'Match over.'
    },

    err: {
      phase: 'Not now.',
      hand: 'Those cards are not in your hand.',
      opened: 'You have already opened.',
      match: 'Those cards do not make this task.',
      closed: 'Open first.',
      closedAra: 'You can only lay cards once your whole hand fits.',
      wait: 'You opened this turn. Lay more cards next turn.',
      short: 'A meld needs at least 3 cards.',
      shape: 'Those cards do not make a set or a run.',
      fit: 'Those cards do not fit that meld.',
      pick: 'Select a card first.',
      whole: 'Too many cards would be left over.',
      other: 'That did not work.'
    },

    typeTitle: 'Set or run?',
    typeSet: 'Set',
    typeSetNote: 'Same rank, any suits',
    typeRun: 'Run',
    typeRunNote: 'Same suit, in order',
    cancel: 'Cancel',

    claimTitle: v => 'Take the ' + v.card + '?',
    claimBody: v => 'You can take ' + (v.left === 1 ? '1 more discard' : v.left + ' more discards') + ' this game.',
    costPill: '1 chip + 1 penalty card',
    take: 'Take',
    pass: 'Pass',
    close: 'Close',
    done: 'Done',
    on: 'On',
    off: 'Off',
    preview: v => cap(v.card),

    ev: {
      game: v => 'Game ' + v.n + '. ' + v.name + (v.you ? ' cut the deck.' : ' cuts the deck.'),
      keep: v => v.you ? 'You cut a joker and keep it.' : v.name + ' cut a joker and keeps it.',
      top: v => 'First discard: ' + v.card + '.',
      last: v => 'Last game, go out from hand. ' + (v.you ? 'You go' : v.name + ' goes') + ' first.',
      task: v => v.name + ' chose ' + v.task + '.',
      draw: v => v.you ? (v.card ? 'You drew the ' + v.card + '.' : 'You drew from the stock.') : v.name + ' drew from the stock.',
      take: v => (v.you ? 'You take' : v.name + ' takes') + ' the ' + v.card + ' from the discard pile.',
      claim: v => (v.you ? 'You take' : v.name + ' takes') + ' the ' + v.card + ' and a penalty card' + (v.pen ? ', the ' + v.pen : '') + '. 1 chip to the pot.',
      open: v => (v.you ? 'You opened' : v.name + ' opened') + ' with ' + v.melds + '.',
      lay: v => (v.you ? 'You laid ' : v.name + ' laid ') + v.melds + '.',
      add: v => (v.you ? 'You added ' : v.name + ' added ') + v.cards + ' to ' + v.label + '.',
      finish: v => (v.you ? 'You laid your hand: ' : v.name + ' laid their hand: ') + v.melds + '.',
      discard: v => (v.you ? 'You discarded the ' : v.name + ' discarded the ') + v.card + '.',
      out: v => v.you ? 'You went out.' : v.name + ' went out.',
      stockout: 'The stock ran out. No winner this game.',
      win: v => v.you ? 'You won the match.' : v.name + ' won the match.',
      yourTurn: 'Your turn.',
      claimOffer: v => 'Take the ' + v.card + '? Take or pass.',
      choose: 'Choose a task.'
    },

    start: {
      title: 'Amerikano',
      go: 'New match',
      cont: 'Continue',
      saved: v => 'Game ' + v.n + ' of ' + v.of + ', ' + v.players + ' players',
      how: 'How to play',
      settings: 'Settings',
      fan: 'Playing cards'
    },

    setup: {
      title: 'New match',
      players: 'Players',
      nPlayers: v => v.n + ' players',
      games: 'Games',
      gamesNote: 'A multiple of the players, so everyone picks the task equally often.',
      level: 'Opponents',
      relaxed: 'Relaxed',
      relaxedNote: 'A friendly pace, with a few missed chances.',
      sharp: 'Sharp',
      sharpNote: 'They rarely miss a chance.',
      go: 'Start match',
      replace: 'Your saved match will be replaced.'
    },

    set: {
      title: 'Settings',
      lang: 'Language',
      auto: 'Follow device',
      en: 'English',
      tr: 'Türkçe',
      sound: 'Sound',
      haptics: 'Vibration',
      fourc: 'Four-colour suits',
      fourcNote: 'Spades black, hearts red, diamonds orange, clubs green.',
      speed: 'Opponent speed',
      slow: 'Slow',
      normal: 'Normal',
      fast: 'Fast'
    },

    pause: {
      title: 'Paused',
      resume: 'Resume',
      how: 'How to play',
      settings: 'Settings',
      leave: 'Leave match',
      note: 'Your match is saved. Continue it from the home screen.'
    },

    choice: {
      pick: 'Pick a task',
      hint: 'Closest to your hand first.',
      away: v => v.n === 0 ? 'Ready' : v.n === 1 ? '1 card away' : v.n + ' cards away'
    },

    paper: {
      title: 'Score sheet',
      tabs: 'Score sheet views',
      scores: 'Scores',
      log: 'Log',
      game: 'Game',
      total: 'Total',
      chips: 'Chips',
      state: v => 'Game ' + v.n + ' of ' + v.of + '. The pot holds ' + chips(v.pot) + '.',
      none: 'No game has finished yet.',
      wentOut: 'went out',
      caption: 'Points per game, lowest total is best',
      emptyLog: 'Nothing has happened yet.'
    },

    round: {
      title: v => 'Game ' + v.n + ' over',
      next: 'Next game',
      result: 'See the result',
      task: v => 'Task: ' + v.task + '.',
      player: 'Player',
      hand: 'Hand',
      adj: 'Task',
      total: 'Total',
      cap: 'Points left in hand, the task bonus or penalty, and the running total',
      none: 'The stock ran out. Nobody won this game.',
      out: v => v.name + ' went out.',
      pot: v => (v.you ? 'You take ' : v.name + ' takes ') + chips(v.n) + ' from the pot.',
      adjOut: v => v.name + ' chose the task and went out, so 50 points come off.',
      adjNever: v => v.name + ' chose the task and never opened, so 50 points are added.',
      adjNone: v => v.name + ' chose the task. No bonus, no penalty.'
    },

    end: {
      title: 'Match over',
      won: v => v.you ? 'You won the match' : v.name + ' won the match',
      place: 'Place',
      player: 'Player',
      points: 'Points',
      chips: 'Chips',
      cap: 'Final places, points and chips',
      whole: v => v.you ? 'You had the lowest score and take the whole pot of ' + chips(v.pot) + '.' : v.name + ' had the lowest score and takes the whole pot of ' + chips(v.pot) + '.',
      split: v => (v.you ? 'You had the lowest score and take ' : v.name + ' had the lowest score and takes ') + chips(v.lowPay) + '. ' + (v.finYou ? 'You' : v.fin) + ' went out in the last game and ' + (v.finYou ? 'take ' : 'takes ') + chips(v.finPay) + '.',
      empty: v => (v.you ? 'You had' : v.name + ' had') + ' the lowest score. The pot was used up during the match, so there are no chips to share.',
      again: 'Play again',
      home: 'Home'
    },

    how: {
      title: 'How to play',
      intro: 'A rummy game for 3 to 5 players. A match is several games. Parts marked House rule are the way this app plays where families differ.',
      house: 'House rule',
      set: 'Set',
      run: 'Run',
      secs: [
        { h: 'The goal', p: [['Get rid of your cards before the others do. When a game ends, every card left in your hand counts against you. After the last game, the lowest total wins the pot.']] },
        { h: 'A turn', p: [['Draw one card from the stock, or take the top card of the discard pile. Then lay melds if you may, and end your turn by discarding one card.']] },
        { h: 'Sets and runs', demo: true, p: [
          ['A set (küt) is three or more cards of one rank, in any suits. A run (seri) is three or more cards in order, all of one suit. A joker stands in for any card.'],
          ['The ace is low or high, but a run cannot turn the corner (king, ace, two). A joker stays where it is laid.', 1]
        ] },
        { h: 'The task and opening', p: [
          ['Before each game the cutter looks at their hand and picks a task, such as four pairs. You cannot lay anything until you open, which means laying exactly the melds the task asks for in one go. Each task is used once.'],
          ['The last game is always Arabitiş: nobody may lay anything until the whole hand fits into melds, with at most one card left to discard.'],
          ['After you open, you lay nothing more until your next turn. From then on you can add cards to any meld on the table and lay new melds.', 1]
        ] },
        { h: 'Taking a card out of turn', p: [['If you draw from the stock instead of taking the discard, the others may claim the card you left. Whoever takes it also draws a penalty card (ceza kağıdı) and puts 1 chip in the pot. Nobody can claim more than 4 times in a game.', 1]] },
        { h: 'Points', p: [['Cards left in hand count 2 to 10 as printed, jack, queen and king 10, ace 11, joker 20.', 1], ['Whoever picked the task and goes out scores 50 less. If they never opened, they score 50 more. The lowest score is best.']] },
        { h: 'Chips', p: [
          ['Everyone puts 10 chips in the pot (kasa). Going out wins 5 chips. At the end the pot is split in three: two parts to the lowest score, one part to whoever went out in the last game.', 1],
          ['If the stock runs out, the game ends and nobody wins it.', 1]
        ] }
      ]
    }
  };

  // Turkish suffixes follow vowel harmony, so names and card names get them by rule.
  const VOW = 'aeıioöuü';
  const low = s => s.toLocaleLowerCase('tr');
  const isV = ch => VOW.indexOf(low(ch)) >= 0;
  const four = v => v === 'a' || v === 'ı' ? 'ı' : v === 'e' || v === 'i' ? 'i' : v === 'o' || v === 'u' ? 'u' : 'ü';
  function lastV(s) {
    for (let i = s.length - 1; i >= 0; i--) if (isV(s[i])) return low(s[i]);
    return 'e';
  }
  const acc = s => isV(s[s.length - 1]) ? s + 'n' + four(lastV(s)) : s + four(lastV(s));
  const gen = s => s + '’' + (isV(s[s.length - 1]) ? 'n' : '') + four(lastV(s)) + 'n';
  const dat = s => /seri$/.test(s) ? s + 'ye' : s + 'e';
  const up = s => s.charAt(0).toLocaleUpperCase('tr') + s.slice(1);

  const TR_RANK = ['', 'as', 'ikili', 'üçlü', 'dörtlü', 'beşli', 'altılı', 'yedili', 'sekizli', 'dokuzlu', 'onlu', 'vale', 'kız', 'papaz'];
  const TR_POSS = ['', 'ası', 'ikilisi', 'üçlüsü', 'dörtlüsü', 'beşlisi', 'altılısı', 'yedilisi', 'sekizlisi', 'dokuzlusu', 'onlusu', 'valesi', 'kızı', 'papazı'];
  const TR_SUIT = { c: 'sinek', d: 'karo', h: 'kupa', s: 'maça' };
  const trCards = n => n + ' kağıt';

  const tr = {
    you: 'Sen',
    joker: 'Joker',
    cards: trCards,
    rank: v => TR_RANK[v.r],
    plural: v => TR_RANK[v.r],
    suit: v => TR_SUIT[v.s],
    card: (v, t) => v.r ? t('suit', v) + ' ' + TR_POSS[v.r] : 'joker',
    short: v => v.r === 1 ? 'A' : v.r === 11 ? 'J' : v.r === 12 ? 'Q' : v.r === 13 ? 'K' : String(v.r),
    selected: 'seçili',
    selSay: v => up(v.card) + (v.on ? ' seçildi.' : ' seçimi kalktı.'),
    posSay: v => up(v.card) + ', sıra ' + v.n + ' / ' + v.of + '.',
    sortedSay: v => v.suit ? 'Renge göre sıralandı.' : 'Sayıya göre sıralandı.',

    task: v => v.task.tr,
    taskSub: v => low(v.task.tr) === v.task.gl ? '' : v.task.gl,
    taskNone: 'Görev seçiliyor',

    menu: 'Menü',
    score: 'Puan',
    pot: v => 'Kasa ' + v.n,
    gameOf: v => 'Oyun ' + v.n + ' / ' + v.of,
    lastGame: v => 'Son oyun ' + v.n + ' / ' + v.of,

    playing: 'Sırada',
    opened: 'El açtı',
    seat: v => v.name + ', ' + trCards(v.n) + (v.turn ? ', sırada' : '') + (v.opened ? ', el açtı' : '') + ', ' + num(v.score) + ' puan',
    ptsShort: v => num(v.n) + ' p.',
    points: v => num(v.n) + ' puan',
    rackInfo: v => trCards(v.n) + ', ' + v.pts + ' puan',
    hand: 'Elin',
    seatsLabel: 'Rakipler',
    ctlLabel: 'Desteler ve hamleler',
    stock: v => 'Deste, ' + trCards(v.n),
    stockDraw: v => 'Deste, ' + trCards(v.n) + '. Bir kağıt çek',
    stockEmpty: 'Deste bitti',
    discardPile: v => v.card ? 'Yerdeki deste, üstte ' + v.card : 'Yerdeki deste, boş',
    discardTake: v => 'Yerdeki deste. ' + up(acc(v.card)) + ' al',
    discardPut: 'Yerdeki deste. Seçili kağıdı at',
    lipOpened: 'el açtın',

    noMelds: 'Masada henüz küt ya da seri yok.',
    yourMelds: 'Senin küt ve serilerin',
    theirMelds: v => gen(v.name) + ' küt ve serileri',
    meldSet: v => up(v.what) + ' küt',
    meldRun: v => up(v.what) + ' seri',
    meldJokers: 'joker',
    meldAny: 'bir küt ya da seri',
    meldBy: v => v.label + ', ' + v.who,
    meldRange: v => TR_RANK[v.a > 13 ? v.a - 13 : v.a] + ' ile ' + TR_RANK[v.b > 13 ? v.b - 13 : v.b] + ' arası',
    meldAdd: v => 'Seçili kağıtları ' + dat(low(v.label)) + ' ekle' + v.more,
    cardIn: v => v.label + ' içinde ' + v.card,

    sortSuit: 'Renge göre sırala',
    sortRank: 'Sayıya göre sırala',
    moveLeft: 'Sola al',
    moveRight: 'Sağa al',
    open: 'El aç',
    finish: 'Bitir',
    meld: 'İndir',
    discard: 'At',
    clear: 'Temizle',

    st: {
      choose: 'Bu oyun için görevi seç.',
      chooseBot: v => v.name + ' görev seçiyor.',
      draw: v => v.card ? 'Sıra sende. Desteden çek ya da yerdeki ' + acc(v.card) + ' al.' : 'Sıra sende. Desteden bir kağıt çek.',
      bot: v => v.name + ' oynuyor.',
      claimBot: v => v.name + ', ' + acc(v.card) + ' alıp almayacağını düşünüyor.',
      need: v => 'Bu görev için ' + v.n + ' kağıt daha lazım.',
      needAra: v => v.n + ' kağıt daha küte ya da seriye girmeli.',
      canOpen: 'El açabilirsin.',
      canFinish: 'Eli bitirebilirsin.',
      ready: 'Kağıt ekle, yeni küt ya da seri indir, ya da bir kağıt at.',
      just: 'El açtın. Sırayı bitirmek için bir kağıt at.',
      sel: v => v.n + ' seçili.',
      pickOne: 'Atacağın kağıdı seç.',
      over: 'Oyun bitti.',
      matchOver: 'Maç bitti.'
    },

    err: {
      phase: 'Şimdi olmaz.',
      hand: 'Bu kağıtlar elinde değil.',
      opened: 'Eli zaten açtın.',
      match: 'Bu kağıtlar görevi tutmuyor.',
      closed: 'Önce el aç.',
      closedAra: 'Bir şey indirebilmen için bütün elin küt ve seri olmalı.',
      wait: 'Bu turda el açtın. Gerisini sonraki turda indir.',
      short: 'Küt ya da seri en az 3 kağıt olmalı.',
      shape: 'Bu kağıtlar küt ya da seri olmuyor.',
      fit: 'Bu kağıtlar oraya eklenemez.',
      pick: 'Önce bir kağıt seç.',
      whole: 'Elde çok fazla kağıt kalıyor.',
      other: 'Olmadı.'
    },

    typeTitle: 'Küt mü, seri mi?',
    typeSet: 'Küt',
    typeSetNote: 'Aynı sayı, her renkten',
    typeRun: 'Seri',
    typeRunNote: 'Aynı renk, sırayla',
    cancel: 'Vazgeç',

    claimTitle: v => up(acc(v.card)) + ' alır mısın?',
    claimBody: v => 'Alırsan kasaya 1 çip verir, desteden bir ceza kağıdı çekersin. Bu oyunda ' + (v.left === 1 ? 'bir kez' : v.left + ' kez') + ' daha alabilirsin.',
    costPill: '1 çip + 1 ceza kağıdı',
    take: 'Al',
    pass: 'Pas',
    close: 'Kapat',
    preview: v => up(v.card),
    done: 'Tamam',
    on: 'Açık',
    off: 'Kapalı',

    ev: {
      game: v => 'Oyun ' + v.n + '. ' + (v.you ? 'Desteyi sen kesiyorsun.' : v.name + ' desteyi kesiyor.'),
      keep: v => v.you ? 'Joker çıktı, sende kalıyor.' : v.name + ' joker kesti, jokeri kendisi alıyor.',
      top: v => 'Yere açılan ilk kağıt: ' + v.card + '.',
      last: v => v.you ? 'Son oyun: elden bitiş. İlk sen oynuyorsun.' : 'Son oyun: elden bitiş. İlk ' + v.name + ' oynuyor.',
      task: v => v.you ? 'Sen ' + v.task + ' görevini seçtin.' : v.name + ' ' + v.task + ' görevini seçti.',
      draw: v => v.you ? (v.card ? up(acc(v.card)) + ' çektin.' : 'Desteden çektin.') : v.name + ' desteden çekti.',
      take: v => v.you ? 'Yerden ' + acc(v.card) + ' aldın.' : v.name + ' yerden ' + acc(v.card) + ' aldı.',
      claim: v => v.you ? 'Yerden ' + acc(v.card) + ' alıp ceza kağıdı çektin' + (v.pen ? ': ' + v.pen : '') + '. Kasaya 1 çip verdin.' : v.name + ' yerden ' + acc(v.card) + ' alıp ceza kağıdı çekti. Kasaya 1 çip verdi.',
      open: v => v.you ? 'El açtın: ' + v.melds + '.' : v.name + ' el açtı: ' + v.melds + '.',
      lay: v => v.you ? up(v.melds) + ' indirdin.' : v.name + ' ' + v.melds + ' indirdi.',
      add: v => v.one
        ? (v.you ? up(dat(v.label)) + ' ' + acc(v.one) + ' ekledin.' : v.name + ' ' + dat(v.label) + ' ' + acc(v.one) + ' ekledi.')
        : (v.you ? up(dat(v.label)) + ' şu kağıtları ekledin: ' + v.cards + '.' : v.name + ' ' + dat(v.label) + ' şu kağıtları ekledi: ' + v.cards + '.'),
      finish: v => v.you ? 'Elini indirdin: ' + v.melds + '.' : v.name + ' elini indirdi: ' + v.melds + '.',
      discard: v => v.you ? up(acc(v.card)) + ' attın.' : v.name + ' ' + acc(v.card) + ' attı.',
      out: v => v.you ? 'Oyunu bitirdin.' : v.name + ' oyunu bitirdi.',
      stockout: 'Deste bitti. Bu oyunu kimse kazanamadı.',
      win: v => v.you ? 'Maçı sen kazandın.' : v.name + ' maçı kazandı.',
      yourTurn: 'Sıra sende.',
      claimOffer: v => up(acc(v.card)) + ' alır mısın? Al ya da pas geç.',
      choose: 'Görev seç.'
    },

    start: {
      title: 'Amerikano',
      cont: 'Devam et',
      go: 'Yeni maç',
      saved: v => 'Oyun ' + v.n + ' / ' + v.of + ', ' + v.players + ' oyuncu',
      how: 'Nasıl oynanır',
      settings: 'Ayarlar',
      fan: 'İskambil kağıtları'
    },

    setup: {
      title: 'Yeni maç',
      players: 'Oyuncular',
      nPlayers: v => v.n + ' oyuncu',
      games: 'Oyun sayısı',
      gamesNote: 'Oyuncu sayısının katı, böylece herkes görevi eşit sayıda seçer.',
      level: 'Rakipler',
      relaxed: 'Rahat',
      relaxedNote: 'Rahat oynarlar, ara sıra fırsat kaçırırlar.',
      sharp: 'Usta',
      sharpNote: 'Fırsatı pek kaçırmazlar.',
      go: 'Başla',
      replace: 'Kayıtlı maçın silinecek.'
    },

    set: {
      title: 'Ayarlar',
      lang: 'Dil',
      auto: 'Telefonun dili',
      en: 'English',
      tr: 'Türkçe',
      sound: 'Ses',
      haptics: 'Titreşim',
      fourc: 'Dört renkli işaretler',
      fourcNote: 'Maça siyah, kupa kırmızı, karo turuncu, sinek yeşil.',
      speed: 'Rakiplerin hızı',
      slow: 'Yavaş',
      normal: 'Normal',
      fast: 'Hızlı'
    },

    pause: {
      title: 'Duraklatıldı',
      resume: 'Oyuna dön',
      how: 'Nasıl oynanır',
      settings: 'Ayarlar',
      leave: 'Maçtan çık',
      note: 'Maçın kaydedildi. Ana ekrandan devam edebilirsin.'
    },

    choice: {
      pick: 'Bir görev seç',
      hint: 'Eline en yakın olan başta.',
      away: v => v.n === 0 ? 'Hazır' : v.n + ' kağıt eksik'
    },

    paper: {
      title: 'Puan kağıdı',
      tabs: 'Puan kağıdı sekmeleri',
      scores: 'Puanlar',
      log: 'Günlük',
      game: 'Oyun',
      total: 'Toplam',
      chips: 'Çip',
      state: v => 'Oyun ' + v.n + ' / ' + v.of + '. Kasada ' + v.pot + ' çip var.',
      none: 'Henüz biten oyun yok.',
      wentOut: 'bitirdi',
      caption: 'Oyun başına puanlar, en düşük toplam en iyisidir',
      emptyLog: 'Henüz bir şey olmadı.'
    },

    round: {
      title: v => v.n + '. oyun bitti',
      next: 'Sonraki oyun',
      result: 'Sonucu gör',
      task: v => 'Görev: ' + v.task + '.',
      player: 'Oyuncu',
      hand: 'El',
      adj: 'Görev',
      total: 'Toplam',
      cap: 'Elde kalan puan, görev indirimi ya da cezası ve toplam',
      none: 'Deste bitti. Bu oyunu kimse kazanamadı.',
      out: v => v.you ? 'Oyunu sen bitirdin.' : v.name + ' oyunu bitirdi.',
      pot: v => v.you ? 'Kasadan ' + v.n + ' çip aldın.' : v.name + ' kasadan ' + v.n + ' çip aldı.',
      adjOut: v => v.you ? 'Görevi sen seçip oyunu bitirdin, bu yüzden 50 puan düştü.' : v.name + ' görevi seçip oyunu bitirdi, bu yüzden 50 puan düştü.',
      adjNever: v => v.you ? 'Görevi sen seçtin ama hiç el açamadın, bu yüzden 50 puan eklendi.' : v.name + ' görevi seçti ama hiç el açamadı, bu yüzden 50 puan eklendi.',
      adjNone: v => v.you ? 'Görevi sen seçtin. İndirim de ceza da yok.' : v.name + ' görevi seçti. İndirim de ceza da yok.'
    },

    end: {
      title: 'Maç bitti',
      won: v => v.you ? 'Maçı sen kazandın' : v.name + ' maçı kazandı',
      place: 'Sıra',
      player: 'Oyuncu',
      points: 'Puan',
      chips: 'Çip',
      cap: 'Son sıralama, puanlar ve çipler',
      whole: v => (v.you ? 'En düşük puanı sen yaptın ve ' : v.name + ' en düşük puanı yaptı ve ') + 'kasanın tamamını, ' + v.pot + ' çipi ' + (v.you ? 'aldın.' : 'aldı.'),
      split: v => (v.you ? 'En düşük puanı sen yaptın, ' + v.lowPay + ' çip aldın. ' : v.name + ' en düşük puanı yaptı, ' + v.lowPay + ' çip aldı. ') +
        (v.finYou ? 'Son oyunu sen bitirdin, ' + v.finPay + ' çip aldın.' : 'Son oyunu bitiren ' + v.fin + ' ' + v.finPay + ' çip aldı.'),
      empty: v => (v.you ? 'En düşük puanı sen yaptın' : v.name + ' en düşük puanı yaptı') + ', ama kasa maç sırasında boşaldı; paylaşılacak çip kalmadı.',
      again: 'Tekrar oyna',
      home: 'Ana ekran'
    },

    how: {
      title: 'Nasıl oynanır',
      intro: '3 ile 5 kişilik bir rami oyunu. Bir maç birkaç oyundan oluşur. “Ev kuralı” yazan yerler, ailelerin farklı oynadığı konularda bu uygulamanın seçtiği yoldur.',
      house: 'Ev kuralı',
      set: 'Küt',
      run: 'Seri',
      secs: [
        { h: 'Amaç', p: [['Elindeki kağıtları diğerlerinden önce bitir. Oyun bitince elde kalan her kağıt sana puan yazar. Son oyundan sonra toplamı en düşük olan kasayı alır.']] },
        { h: 'Sıra', p: [['Desteden bir kağıt çek ya da yerdeki üstteki kağıdı al. Sonra elini açtıysan küt ve seri indirebilirsin. Sırayı bir kağıt atarak bitirirsin.']] },
        { h: 'Küt ve seri', demo: true, p: [
          ['Küt, aynı sayıdan, her renkten üç ya da daha fazla kağıttır. Seri, aynı renkten arka arkaya üç ya da daha fazla kağıttır. Joker her kağıdın yerine geçer.'],
          ['As hem en küçük hem en büyük kağıt olarak kullanılır, ama seri köşeyi dönemez (papaz, as, ikili). Joker indirildiği yerde kalır.', 1]
        ] },
        { h: 'Görev ve el açmak', p: [
          ['Her oyunda desteyi kesen oyuncu eline bakıp bir görev seçer, örneğin dört çift. El açana kadar hiçbir şey indiremezsin. El açmak, görevin istediği küt ve serileri tek seferde indirmektir. Her görev bir kez kullanılır.'],
          ['Son oyun hep Arabitiş’tir: bütün el küt ve seri olmadan kimse bir şey indiremez, atmak için en fazla bir kağıt kalabilir.'],
          ['El açtığın turda başka bir şey indiremezsin. Sonraki turdan başlayarak masadaki küt ve serilere kağıt ekleyebilir, yeni küt ve seri indirebilirsin.', 1]
        ] },
        { h: 'Sırası gelmeden almak', p: [['Yerdeki kağıdı almayıp desteden çekersen, diğer oyuncular senin bıraktığın kağıdı alabilir. Alan oyuncu ayrıca bir ceza kağıdı çeker ve kasaya 1 çip koyar. Bir oyuncu bir oyunda en fazla 4 kez alabilir.', 1]] },
        { h: 'Puanlar', p: [['Elde kalan kağıtlar 2’den 10’a kadar üzerinde yazan sayı, vale, kız ve papaz 10, as 11, joker 20 puandır.', 1], ['Görevi seçen oyuncu oyunu bitirirse 50 puan düşer, hiç el açamazsa 50 puan eklenir. En düşük puan en iyisidir.']] },
        { h: 'Çipler', p: [
          ['Herkes kasaya 10 çip koyar. Oyunu bitiren kasadan 5 çip alır. Maç sonunda kasa üçe bölünür: iki payı en düşük puanlı oyuncu, bir payı son oyunu bitiren alır.', 1],
          ['Deste biterse oyun kimse kazanmadan sona erir.', 1]
        ] }
      ]
    }
  };

  const S = { en: en, tr: tr };
  
  function find(tbl, key) {
    let o = tbl;
    for (const k of key.split('.')) {
      if (o == null) return undefined;
      o = o[k];
    }
    return o;
  }

  function t(key, v) {
    let s = find(S[lang], key);
    if (s === undefined) s = find(en, key);
    if (s === undefined) return key;
    if (typeof s === 'function') return s(v || {}, t);
    return s;
  }

  function resolve(p) {
    if (p === 'tr' || p === 'en') return p;
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
    return String(langs[0]).toLowerCase().indexOf('tr') === 0 ? 'tr' : 'en';
  }

  function set(p) {
    pref = p;
    lang = resolve(p);
    document.documentElement.lang = lang;
  }

  return { t: t, set: set, cap: cap, num: num, pref: () => pref, lang: () => lang, S: S };
})();

var t = I18n.t;
