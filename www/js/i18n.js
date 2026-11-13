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
    away: 'Away',
    seat: v => v.name + ', ' + cards(v.n) + (v.turn ? ', playing' : '') + (v.opened ? ', opened' : '') + (v.away ? ', away' : '') + ', score ' + num(v.score),
    ptsShort: v => num(v.n) + ' pts',
    points: v => v.n === 1 ? '1 point' : num(v.n) + ' points',
    rackInfo: v => cards(v.n) + ', ' + v.pts + ' points',
    hand: 'Your hand',
    seatsLabel: 'Opponents',
    ctlLabel: 'Actions',
    pilesLabel: 'Piles',
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
      turn: 'It is not your turn.',
      offline: 'Reconnecting. Try again in a moment.',
      broke: 'You do not have enough chips for that gift.',
      blocked: 'You cannot send a gift to this player.',
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
      go: 'Training',
      goNote: 'Against bots, no chips',
      botTag: 'Bot',
      cont: 'Continue',
      saved: v => 'Game ' + v.n + ' of ' + v.of + ', ' + v.players + ' players',
      how: 'How to play',
      settings: 'Settings',
      fan: 'Playing cards',
      rejoin: 'Rejoin',
      rejoinNote: v => 'Room ' + v.code
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
      fast: 'Fast',
      back: 'Card back',
      felt: 'Table felt',
      red: 'Red',
      blue: 'Blue',
      green: 'Green',
      graphite: 'Graphite',
      wine: 'Wine',
      walnut: 'Walnut'
    },

    pause: {
      title: 'Paused',
      resume: 'Resume',
      how: 'How to play',
      settings: 'Settings',
      leave: 'Leave match',
      note: 'Your match is saved. Continue it from the lobby.',
      onlineNote: 'The match goes on without you. If you leave, your seat is played for you.'
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
      lobby: 'Back to the lobby',
      change: v => v.n > 0 ? 'You won ' + v.abs + ' chips.' : v.n < 0 ? 'You lost ' + v.abs + ' chips.' : 'You got your stake back.',
      xp: v => '+' + v.n + ' XP',
      level: v => 'Level ' + v.n + '!',
      bonus: v => '+' + v.n + ' chips',
      winnings: 'Your chips this match',
      scores: 'Score sheet',
      unit: v => 'Stake ' + v.stake + ': each chip on the table is worth ' + v.unit + '.'
    },

    net: {
      title: 'Play online',
      create: 'Create a table',
      createGo: 'Create table',
      join: 'Join with a code',
      code: 'Room code',
      joinGo: 'Join',
      joinTitle: v => 'Join room ' + v.code,
      connecting: 'Connecting.',
      room: 'Room',
      hintHost: 'Share the code with your friends. Press Start when they are in; empty seats are filled for you.',
      hintGuest: 'Waiting for the host to start.',
      finding: v => v.n === 1 ? 'Finding a player for the last seat.' : 'Finding players for ' + v.n + ' seats.',
      looking: 'Looking',
      free: 'Free seat',
      arrived: v => v.name + ' sat down, level ' + v.n + '.',
      you: '(you)',
      hostTag: 'Host',
      start: 'Start',
      share: 'Share',
      shareText: 'Play Amerikano with me.',
      copied: 'Link copied.',
      leave: 'Leave',
      retry: 'Connection lost. Reconnecting.',
      waitNext: 'Waiting for the others.',
      err: {
        nocode: 'There is no room with that code.',
        started: 'That match has already started.',
        full: 'That room is full.',
        taken: 'That code is in use. Try again.',
        auth: 'Your account could not be checked. Try again.',
        poor: 'You do not have enough chips for that.',
        busy: 'You already have a seat at another table.',
        held: v => v.name + ' has a seat at another table, so the match cannot start yet.',
        elsewhere: 'You have a seat at another table, so this match cannot start. Leave that table first.',
        host: 'Only the host can start the match.',
        opts: 'Those match settings are not allowed.',
        join: 'Join a room first.',
        lost: 'Could not connect. Check your connection and try again.',
        replaced: 'You joined this match from another window.',
        ended: 'The match has ended.',
        other: 'That did not work.'
      }
    },

    hall: {
      rooms: 'Rooms',
      need: v => 'Needs ' + v.n + ' chips',
      playing: v => v.n + ' playing',
      pick: 'Pick a room',
      finding: 'Finding players',
      all: 'See all',
      quickAt: v => 'Sits you at a ' + v.n + ' table',
      friendsNote: 'Create a table or enter a code',
      quick: 'Quick play',
      fill: 'The match starts as soon as every seat is taken.',
      stake: 'Stake',
      stakeAt: v => 'Stake ' + v.n + ' chips',
      stakeNote: v => 'Your stake of ' + v.n + ' chips is set aside when the match starts and paid back with what you win.',
      friends: 'Play with friends',
      min: v => 'Min ' + v.n,
      locked: 'Locked',
      level: v => 'Lv ' + v.n
    },

    nonet: {
      down: 'You are offline',
      downNote: 'Online tables need a connection. Training works without one.',
      retry: 'Try again',
      replaced: 'Open somewhere else',
      replacedNote: 'Amerikano is open on another device or window.',
      here: 'Play here'
    },

    pf: {
      title: 'Profile',
      level: v => 'Level ' + v.n,
      xp: 'Experience',
      xpOf: v => v.a + ' of ' + v.b + ' XP',
      chips: 'Chips',
      games: 'Matches',
      wins: 'Wins',
      daily: v => 'Daily bonus +' + v.n,
      claim: 'Claim',
      dailyTitle: 'Daily bonus',
      dailyDone: 'Come back tomorrow for more.',
      streakDay: v => 'Day ' + v.n,
      got: v => 'You got ' + v.n + ' chips.',
      reroll: 'New name',
      limit: 'You have used all of today’s new names.',
      bailout: 'Top up to 1,000 chips',
      bailoutNote: 'You are low on chips. This is free once a day.',
      skin: 'Skin',
      eyes: 'Eyes',
      hair: 'Hair',
      acc: 'Extra',
      none: 'None',
      delete: 'Delete account',
      deleteAsk: 'This removes your profile, chips and stats for good. It cannot be undone.',
      deleteGo: 'Delete for good',
      keep: 'Keep my account'
    },

    chat: {
      title: 'Quick chat',
      open: 'Chat',
      phrases: 'Phrases',
      emotes: 'Emotes',
      say: {
        hello: 'Hello!', luck: 'Good luck!', nice: 'Nice move!', thanks: 'Thanks!', oops: 'Oops!', hurry: 'Your turn, please.',
        wow: 'Wow!', close: 'So close!', sorry: 'Sorry!', rematch: 'Again?', well: 'Well played!', bye: 'Bye!'
      },
      emo: { smile: 'Smile', laugh: 'Laugh', wink: 'Wink', love: 'Love', gasp: 'Surprised', sad: 'Sad', angry: 'Angry', cheer: 'Hooray' },
      said: v => v.name + ': ' + v.what
    },

    gift: {
      title: 'Send a gift',
      note: 'A gift costs chips and nobody receives them.',
      tea: 'Tea', sweet: 'Turkish delight', rose: 'Rose', crown: 'Crown',
      cost: v => v.n + ' chips',
      gifted: v => v.from + ' sent ' + v.to + ' a gift: ' + v.gift
    },

    pc: {
      title: 'Player',
      rate: 'Win rate',
      week: 'This week',
      add: 'Add friend',
      sent: 'Request sent',
      cancel: 'Cancel request',
      accept: 'Accept',
      decline: 'Decline',
      friends: 'You are friends',
      remove: 'Remove friend',
      block: 'Block',
      unblock: 'Unblock',
      cap: 'The friends list is full.',
      barred: 'You cannot add this player.'
    },

    fr: {
      tab: 'Friends',
      none: 'No friends yet. Tap a player at a table to add them.',
      online: 'Online',
      offline: 'Offline',
      requests: 'Requests',
      waiting: 'Waiting for an answer',
      blocked: 'Blocked',
      invite: 'Invite',
      invited: 'Invited',
      away: 'Not available',
      inviteFriends: 'Invite friends',
      inviteNote: 'Friends who are online can be invited to your table.',
      createFirst: 'Create a table to invite friends. Join a friend whose table has room.',
      playing: 'Playing',
      at: { lobby: 'In the lobby', training: 'In training', table: 'At a table' },
      lateNote: v => v.name + ' invited you',
      invTitle: 'Invitation',
      invText: v => v.name + ' invites you to a table. Stake ' + v.n + ' chips.',
      join: 'Join',
      later: 'Later'
    },

    top: {
      tab: 'Leaderboard',
      week: 'This week',
      all: 'All time',
      note: 'Chips won this week. Resets every Monday.',
      none: 'Nobody has won chips this week yet.',
      you: 'You',
      level: v => 'Level ' + v.n
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
        { h: 'Taking a card out of turn', p: [['If you draw from the stock instead of taking the discard, the others may claim the card you left, except the player who threw it away. Whoever takes it also draws a penalty card (ceza kağıdı) and puts 1 chip in the pot. Nobody can claim more than 4 times in a game.', 1]] },
        { h: 'Points', p: [['Cards left in hand count 2 to 10 as printed, jack, queen and king 10, ace 11, joker 20.', 1], ['Whoever picked the task and goes out scores 50 less. If they never opened, they score 50 more. The lowest score is best.']] },
        { h: 'Chips', p: [
          ['Everyone puts 10 chips in the pot (kasa). Going out wins 5 chips. At the end the pot is split in three: two parts to the lowest score, one part to whoever went out in the last game.', 1],
          ['If the stock runs out, the game ends and nobody wins it.', 1]
        ] },
        { h: 'Credits', p: [['Avatar portraits by LimeZu (limezu.itch.io).']] }
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
  const to = s => s + '’' + (isV(s[s.length - 1]) ? 'y' : '') + ('aıou'.indexOf(lastV(s)) >= 0 ? 'a' : 'e');
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
    away: 'Uzakta',
    seat: v => v.name + ', ' + trCards(v.n) + (v.turn ? ', sırada' : '') + (v.opened ? ', el açtı' : '') + (v.away ? ', uzakta' : '') + ', ' + num(v.score) + ' puan',
    ptsShort: v => num(v.n) + ' p.',
    points: v => num(v.n) + ' puan',
    rackInfo: v => trCards(v.n) + ', ' + v.pts + ' puan',
    hand: 'Elin',
    seatsLabel: 'Rakipler',
    ctlLabel: 'Hamleler',
    pilesLabel: 'Desteler',
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
      turn: 'Sıra sende değil.',
      offline: 'Yeniden bağlanılıyor. Birazdan tekrar dene.',
      broke: 'Bu hediye için yeterli çipin yok.',
      blocked: 'Bu oyuncuya hediye gönderemezsin.',
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
      go: 'Antrenman',
      goNote: 'Botlara karşı, çipsiz',
      botTag: 'Bot',
      saved: v => 'Oyun ' + v.n + ' / ' + v.of + ', ' + v.players + ' oyuncu',
      how: 'Nasıl oynanır',
      settings: 'Ayarlar',
      fan: 'İskambil kağıtları',
      rejoin: 'Maça dön',
      rejoinNote: v => 'Oda ' + v.code
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
      fast: 'Hızlı',
      back: 'Kağıt sırtı',
      felt: 'Masa çuhası',
      red: 'Kırmızı',
      blue: 'Mavi',
      green: 'Yeşil',
      graphite: 'Grafit',
      wine: 'Şarap',
      walnut: 'Ceviz'
    },

    pause: {
      title: 'Duraklatıldı',
      resume: 'Oyuna dön',
      how: 'Nasıl oynanır',
      settings: 'Ayarlar',
      leave: 'Maçtan çık',
      note: 'Maçın kaydedildi. Lobiden devam edebilirsin.',
      onlineNote: 'Maç sensiz devam eder. Ayrılırsan senin yerine oynanır.'
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
      lobby: 'Lobiye dön',
      change: v => v.n > 0 ? v.abs + ' çip kazandın.' : v.n < 0 ? v.abs + ' çip kaybettin.' : 'Bahsin geri döndü.',
      xp: v => '+' + v.n + ' XP',
      level: v => v.n + '. seviye!',
      bonus: v => '+' + v.n + ' çip',
      winnings: 'Bu maçtaki çipin',
      scores: 'Skor kâğıdı',
      unit: v => 'Bahis ' + v.stake + ': masadaki her çip ' + v.unit + ' çip eder.'
    },

    net: {
      title: 'Çevrimiçi oyna',
      create: 'Masa kur',
      createGo: 'Masayı kur',
      join: 'Kodla katıl',
      code: 'Oda kodu',
      joinGo: 'Katıl',
      joinTitle: v => v.code + ' odasına katıl',
      connecting: 'Bağlanılıyor.',
      room: 'Oda',
      hintHost: 'Kodu arkadaşlarınla paylaş. Onlar gelince başlat; boş yerler senin için doldurulur.',
      hintGuest: 'Odayı kuranın başlatması bekleniyor.',
      finding: v => v.n === 1 ? 'Son yer için oyuncu aranıyor.' : v.n + ' yer için oyuncu aranıyor.',
      looking: 'Aranıyor',
      free: 'Boş yer',
      arrived: v => v.name + ' oturdu, ' + v.n + '. seviye.',
      you: '(sen)',
      hostTag: 'Kurucu',
      start: 'Başlat',
      share: 'Paylaş',
      shareText: 'Benimle Amerikano oyna.',
      copied: 'Bağlantı kopyalandı.',
      leave: 'Ayrıl',
      retry: 'Bağlantı koptu. Yeniden bağlanılıyor.',
      waitNext: 'Diğerleri bekleniyor.',
      err: {
        nocode: 'Bu kodla bir oda yok.',
        started: 'Bu maç çoktan başladı.',
        full: 'Oda dolu.',
        taken: 'Bu kod kullanımda, tekrar dene.',
        auth: 'Hesabın doğrulanamadı. Tekrar dene.',
        poor: 'Bunun için yeterli çipin yok.',
        busy: 'Başka bir masada zaten yerin var.',
        held: v => v.name + ' başka bir masada oturuyor, bu yüzden maç henüz başlayamaz.',
        elsewhere: 'Başka bir masada yerin var, bu yüzden bu maç başlayamıyor. Önce o masadan ayrıl.',
        host: 'Maçı yalnızca odayı kuran başlatabilir.',
        opts: 'Bu maç ayarları olmaz.',
        join: 'Önce bir odaya katıl.',
        lost: 'Bağlanılamadı. İnternetini kontrol edip tekrar dene.',
        replaced: 'Bu maça başka bir pencereden girdin.',
        ended: 'Maç sona erdi.',
        other: 'Olmadı.'
      }
    },

    hall: {
      rooms: 'Odalar',
      need: v => v.n + ' çip gerekir',
      playing: v => v.n + ' kişi oynuyor',
      pick: 'Bir oda seç',
      finding: 'Oyuncular aranıyor',
      all: 'Tümü',
      quickAt: v => v.n + ' masasına oturur',
      friendsNote: 'Masa kur ya da kod gir',
      quick: 'Hızlı oyna',
      fill: 'Her yer dolunca maç başlar.',
      stake: 'Bahis',
      stakeAt: v => v.n + ' çip bahis',
      stakeNote: v => v.n + ' çiplik bahsin maç başlarken ayrılır, kazandıklarınla birlikte geri ödenir.',
      friends: 'Arkadaşlarla oyna',
      min: v => 'En az ' + v.n,
      locked: 'Kilitli',
      level: v => v.n + '. sv'
    },

    nonet: {
      down: 'Çevrimdışısın',
      downNote: 'Çevrimiçi masalar için bağlantı gerekir. Antrenman bağlantısız da çalışır.',
      retry: 'Tekrar dene',
      replaced: 'Başka yerde açık',
      replacedNote: 'Amerikano başka bir cihazda ya da pencerede açık.',
      here: 'Burada oyna'
    },

    pf: {
      title: 'Profil',
      level: v => v.n + '. seviye',
      xp: 'Deneyim',
      xpOf: v => v.a + ' / ' + v.b + ' XP',
      chips: 'Çip',
      games: 'Maç',
      wins: 'Galibiyet',
      daily: v => 'Günlük ödül +' + v.n,
      claim: 'Al',
      dailyTitle: 'Günlük ödül',
      dailyDone: 'Daha fazlası için yarın gel.',
      streakDay: v => v.n + '. gün',
      got: v => v.n + ' çip kazandın.',
      reroll: 'Yeni ad',
      limit: 'Bugünkü yeni ad hakkın bitti.',
      bailout: '1.000 çipe tamamla',
      bailoutNote: 'Çipin azaldı. Günde bir kez ücretsiz.',
      skin: 'Ten',
      eyes: 'Göz',
      hair: 'Saç',
      acc: 'Ekstra',
      none: 'Yok',
      delete: 'Hesabı sil',
      deleteAsk: 'Profilin, çiplerin ve istatistiklerin kalıcı olarak silinir. Geri alınamaz.',
      deleteGo: 'Kalıcı olarak sil',
      keep: 'Hesabımı koru'
    },

    chat: {
      title: 'Hızlı sohbet',
      open: 'Sohbet',
      phrases: 'Sözler',
      emotes: 'İfadeler',
      say: {
        hello: 'Merhaba!', luck: 'İyi şanslar!', nice: 'Güzel hamle!', thanks: 'Teşekkürler!', oops: 'Eyvah!', hurry: 'Sıra sende, hadi.',
        wow: 'Vay canına!', close: 'Ucu ucuna!', sorry: 'Pardon!', rematch: 'Bir daha?', well: 'Eline sağlık!', bye: 'Hoşça kal!'
      },
      emo: { smile: 'Gülümseme', laugh: 'Kahkaha', wink: 'Göz kırpma', love: 'Aşk', gasp: 'Şaşkın', sad: 'Üzgün', angry: 'Kızgın', cheer: 'Yaşasın' },
      said: v => v.name + ': ' + v.what
    },

    gift: {
      title: 'Hediye gönder',
      note: 'Hediye çipe mal olur, çipi kimse almaz.',
      tea: 'Çay', sweet: 'Lokum', rose: 'Gül', crown: 'Taç',
      cost: v => v.n + ' çip',
      gifted: v => v.from + ', ' + to(v.to) + ' ' + low(v.gift) + ' gönderdi'
    },

    pc: {
      title: 'Oyuncu',
      rate: 'Kazanma oranı',
      week: 'Bu hafta',
      add: 'Arkadaş ekle',
      sent: 'İstek gönderildi',
      cancel: 'İsteği geri çek',
      accept: 'Kabul et',
      decline: 'Reddet',
      friends: 'Arkadaşsınız',
      remove: 'Arkadaşlıktan çıkar',
      block: 'Engelle',
      unblock: 'Engeli kaldır',
      cap: 'Arkadaş listen dolu.',
      barred: 'Bu oyuncuyu ekleyemezsin.'
    },

    fr: {
      tab: 'Arkadaşlar',
      none: 'Henüz arkadaşın yok. Masada bir oyuncuya dokunarak ekleyebilirsin.',
      online: 'Çevrimiçi',
      offline: 'Çevrimdışı',
      requests: 'İstekler',
      waiting: 'Yanıt bekleyenler',
      blocked: 'Engellenenler',
      invite: 'Davet et',
      invited: 'Davet edildi',
      away: 'Ulaşılamıyor',
      inviteFriends: 'Arkadaşlarını çağır',
      inviteNote: 'Çevrimiçi arkadaşlar masana davet edilebilir.',
      createFirst: 'Arkadaş davet etmek için bir masa kur. Masasında yer olan bir arkadaşına katıl.',
      playing: 'Oynuyor',
      at: { lobby: 'Lobide', training: 'Antrenmanda', table: 'Bir masada' },
      lateNote: v => v.name + ' seni çağırdı',
      invTitle: 'Davet',
      invText: v => v.name + ' seni bir masaya çağırıyor. Bahis ' + v.n + ' çip.',
      join: 'Katıl',
      later: 'Sonra'
    },

    top: {
      tab: 'Sıralama',
      week: 'Bu hafta',
      all: 'Tüm zamanlar',
      note: 'Bu hafta kazanılan çip. Her pazartesi sıfırlanır.',
      none: 'Bu hafta henüz kimse çip kazanmadı.',
      you: 'Sen',
      level: v => v.n + '. seviye'
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
        { h: 'Sırası gelmeden almak', p: [['Yerdeki kağıdı almayıp desteden çekersen, diğer oyuncular senin bıraktığın kağıdı alabilir; kağıdı atan oyuncu geri alamaz. Alan oyuncu ayrıca bir ceza kağıdı çeker ve kasaya 1 çip koyar. Bir oyuncu bir oyunda en fazla 4 kez alabilir.', 1]] },
        { h: 'Puanlar', p: [['Elde kalan kağıtlar 2’den 10’a kadar üzerinde yazan sayı, vale, kız ve papaz 10, as 11, joker 20 puandır.', 1], ['Görevi seçen oyuncu oyunu bitirirse 50 puan düşer, hiç el açamazsa 50 puan eklenir. En düşük puan en iyisidir.']] },
        { h: 'Çipler', p: [
          ['Herkes kasaya 10 çip koyar. Oyunu bitiren kasadan 5 çip alır. Maç sonunda kasa üçe bölünür: iki payı en düşük puanlı oyuncu, bir payı son oyunu bitiren alır.', 1],
          ['Deste biterse oyun kimse kazanmadan sona erir.', 1]
        ] },
        { h: 'Teşekkürler', p: [['Avatar portreleri LimeZu’nun eseridir (limezu.itch.io).']] }
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
