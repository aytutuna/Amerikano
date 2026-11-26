var I18n = (function () {
  let lang = 'en';
  let loc = 'en';
  let pref = 'auto';
  let nf = new Intl.NumberFormat('en');
  let rules = {};
  const RANKS = ['', 'ace', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king'];
  const PLURAL = ['', 'aces', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings'];
  const SUITS = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
  const cards = n => n === 1 ? '1 card' : n + ' cards';
  const chips = n => n === 1 ? '1 chip' : n + ' chips';
  const ord = n => ['1st', '2nd', '3rd', '4th'][n - 1];
  const num = n => String(n).replace('-', '−');
  const lc = s => s.charAt(0).toLowerCase() + s.slice(1);

  const cap = s => s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);

  const en = {
    you: 'You',
    joker: 'Joker',
    rot: 'Turn your phone sideways',
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
      mute: 'You cannot type messages for now.',
      typedoff: 'Typed chat is off. You can turn it on in Settings.',
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
      out: 'Sign out',
      privacy: 'Privacy policy',
      lang: 'Language',
      auto: 'Follow device',
      region: 'Region',
      reg: { am: 'Americas', eu: 'Europe', tr: 'Turkey', mea: 'Middle East and Africa', ap: 'Asia-Pacific' },
      regionNote: 'Quick play, public tables and tournaments match you with players in your region. Friends and private tables work everywhere.',
      typed: 'Typed chat',
      typedNote: 'Shows what other players type at tables and private messages from friends. Phrases and emotes always work.',
      voice: 'Voice',
      voiceNote: 'Hear other players at tables and in calls, and talk with your microphone. Off turns voice off completely.',
      sound: 'Sound',
      haptics: 'Vibration',
      fourc: 'Four-colour suits',
      fourcNote: 'Spades black, hearts red, diamonds orange, clubs green.',
      speed: 'Training speed',
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
      walnut: 'Walnut',
      notes: 'Notifications',
      push: {
        on: 'Allow notifications',
        invite: 'Table invites',
        daily: 'Daily bonus',
        friend: 'Friend requests',
        week: 'Weekly leaderboard',
        dm: 'Messages',
        denied: 'Notifications are turned off for Amerikano in your device settings. Turn them on there to get any of these.'
      }
    },

    pause: {
      title: 'Paused',
      resume: 'Resume',
      how: 'How to play',
      settings: 'Settings',
      leave: 'Leave match',
      note: 'Your match is saved. Continue it from the lobby.',
      onlineNote: 'The match goes on without you. If you leave, your seat is played for you.',
      pubNote: 'Leaving a public table can cost chips, and after a few leaves in a week you wait before sitting down again.'
    },

    idle: {
      note: 'Your time ran out, so your seat is being played for you.',
      back: 'I\'m back'
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
      rematch: 'Rematch',
      rmLine: v => v.want + ' of ' + v.n + ' want a rematch. ' + v.s + ' s left.',
      rmFind: 'Finding players for the rematch.',
      lobby: 'Back to the lobby',
      change: v => v.n > 0 ? 'You won ' + v.abs + ' chips.' : v.n < 0 ? 'You lost ' + v.abs + ' chips.' : 'You got your stake back.',
      xp: v => '+' + v.n + ' XP',
      level: v => 'Level ' + v.n + '!',
      tokens: v => '+' + v.n + ' tokens',
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
        starting: 'That tournament is starting. Try again in a moment.',
        taken: 'That code is in use. Try again.',
        auth: 'Your account could not be checked. Try again.',
        poor: 'You do not have enough chips for that.',
        busy: 'You already have a seat at another table.',
        held: v => v.name + ' has a seat at another table, so the match cannot start yet.',
        elsewhere: 'You have a seat at another table, so this match cannot start. Leave that table first.',
        dealfail: 'The match could not start. Your chips were returned. Try again.',
        left: 'You left this match, so you cannot take your seat back.',
        cool: v => 'You left tables too often. You cannot sit at this table or a larger one for ' + v.n + ' min.',
        guest: 'Sign in with Apple to unlock this. Guests can play the two smallest tables and friend tables with a stake of 0.',
        level: v => 'You need level ' + v.n + ' to play at this table.',
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
      stakeNote: v => 'At the start, ' + fmt(v.h) + ' chips are set aside: the most you can lose at this stake. What you do not lose is paid back when the match ends.',
      noStake: 'No chips at stake.',
      stakeHint: 'A multiple of 10. With 0, no chips are played for.',
      stakeBad: 'The stake must be a multiple of 10.',
      friends: 'Play with friends',
      locked: 'Locked',
      lockGuest: 'Sign in to unlock',
      fee: v => 'Table fee ' + fmt(v.n) + (v.n === 1 ? ' chip' : ' chips'),
      minFee: v => 'Min ' + v.n + ' · fee ' + v.f,
      cool: v => 'Wait ' + v.n + ' min',
      level: v => 'Lv ' + v.n
    },

    cup: {
      tab: 'Tournaments',
      title: 'Pick a tournament',
      line: '8 players, 2 tables, then a final',
      prize: v => 'First prize ' + v.n,
      cap: 'Final places and points',
      table: 'Tournament',
      buy: v => 'Buy-in ' + v.n,
      seats: v => v.n + ' of 8 seats taken',
      prizes: 'Prizes',
      place: v => ord(v.n),
      note: 'It starts as soon as all 8 seats are taken. Your buy-in is taken then; cancel now and nothing is taken.',
      round: { first: 'Round 1', final: 'Final' },
      through: 'Through to the final',
      out: 'Out after round 1',
      finished: v => 'You finished ' + ord(v.n) + '. Waiting for the other table.',
      outNote: v => 'You finished ' + ord(v.n) + ' at your table. Only the top two go through.',
      off: 'The tournament was cancelled. Your buy-in was returned.',
      starting: 'Starting...',
      won: v => v.you ? 'You won the tournament' : v.name + ' won the tournament',
      final: v => 'You finished ' + ord(v.n) + ' in the final.',
      yourPrize: 'Your prize',
      giveUp: 'Leave the tournament',
      leaveNote: 'Leaving gives up your place in the tournament and any prize. Your seat is played for you.'
    },

    nonet: {
      down: 'You are offline',
      downNote: 'Online tables need a connection. Training works without one.',
      retry: 'Try again',
      replaced: 'Open somewhere else',
      replacedNote: 'Amerikano is open on another device or window.',
      here: 'Play here'
    },

    signin: {
      lead: 'Sign in to keep your chips on all your devices.',
      leadGuest: 'Play right away with a guest account.',
      apple: 'Sign in with Apple',
      guest: 'Continue as guest',
      note: 'A guest account stays on this device.',
      fail: 'That did not work. Try again.'
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
      keep: 'Keep my account',
      appleNote: 'Keep your chips and play on other devices.',
      linked: 'Signed in with Apple',
      taken: 'That Apple ID already has an account',
      takenAsk: 'Switch to it? This guest account and its chips will be lost.',
      switch: 'Switch account',
      other: 'This account is already linked to another Apple ID.',
      reauth: 'Confirm with Apple to finish deleting. Press the button again.'
    },

    chat: {
      title: 'Quick chat',
      open: 'Chat',
      phrases: 'Phrases',
      emotes: 'Emotes',
      type: 'Message',
      hint: 'Say something',
      send: 'Send',
      log: 'Messages at this table',
      none: 'Nothing typed yet.',
      say: {
        hello: 'Hello!', luck: 'Good luck!', nice: 'Nice move!', thanks: 'Thanks!', oops: 'Oops!', hurry: 'Your turn, please.',
        wow: 'Wow!', close: 'So close!', sorry: 'Sorry!', rematch: 'Again?', well: 'Well played!', bye: 'Bye!'
      },
      emo: { smile: 'Smile', laugh: 'Laugh', wink: 'Wink', love: 'Love', gasp: 'Surprised', sad: 'Sad', angry: 'Angry', cheer: 'Hooray' },
      said: v => v.name + ': ' + v.what
    },

    dm: {
      open: 'Message',
      none: 'No messages yet.',
      you: 'You',
      older: 'Older messages',
      new: v => v.name + ' sent you a message.',
      slow: 'Slow down a little.',
      mute: 'You cannot type messages for now.',
      off: 'Typed chat is off. You can turn it on in Settings.',
      no: 'This message could not be sent.'
    },

    voice: {
      mic: { on: 'Microphone on. Tap to turn off.', off: 'Microphone off. Tap to turn on.' },
      spk: { on: 'Voice on. Tap to mute everyone.', off: 'Voice muted. Tap to listen.' },
      denied: 'The microphone is not allowed. You can allow it in your device settings.',
      fail: 'Voice could not connect.',
      mute: 'Mute voice',
      unmute: 'Unmute voice',
      call: 'Call',
      in: v => v.name + ' is calling.',
      calling: v => 'Calling ' + v.name + '.',
      talking: v => 'In a call with ' + v.name + '.',
      accept: 'Answer',
      decline: 'Decline',
      hang: 'Hang up',
      muteMe: 'Mute',
      end: {
        missed: 'No answer.', missedIn: 'Missed call.', declined: 'Call declined.', busy: 'Busy right now.', away: 'Not online.',
        no: 'This call could not be made.', slow: 'Wait a moment before calling again.', dropped: 'The call dropped.'
      },
      line: { missed: 'Missed call', missedMine: 'No answer', declined: 'Call declined' }
    },

    rep: { do: 'Report', done: 'Reported' },

    warn: {
      title: 'Before you send',
      text: 'Sharing contact details is up to you, but never share them with people you do not know. Amerikano chips can never be bought or sold. Report anyone who offers to trade them.',
      send: 'Send anyway',
      edit: 'Edit',
      note: 'Be careful with links and contact details from other players. Chips are never sold.'
    },

    shop: {
      title: 'Shop',
      count: v => pl(v.n, { one: '# token', other: '# tokens' }),
      tab: { tokens: 'Tokens', frame: 'Frames', plate: 'Name plates', back: 'Card backs', felt: 'Felts', emote: 'Emotes', vip: 'VIP' },
      loading: 'Loading the shop.',
      buyFor: v => 'Buy ' + v.name + ' for ' + v.n,
      ask: v => 'Buy for ' + v.n + '?',
      yes: 'Buy',
      no: 'Cancel',
      wear: 'Wear',
      off: 'Take off',
      worn: 'Worn',
      owned: 'Owned',
      bought: v => 'You bought ' + v.name + '.',
      added: (v, t) => t('shop.count', v) + ' added.',
      failed: 'That did not work. Try again in a moment.',
      broke: 'You do not have enough tokens.',
      late: 'Your purchase went through, but the tokens are taking a moment to arrive.',
      android: 'Coming soon on Android',
      web: 'Buy tokens in the iPhone app',
      guest: 'Link your Apple account in your profile to keep your purchases after a reinstall.',
      earn: (v, t) => 'Every online match you finish earns ' + t('shop.count', { n: v.n }) + ', up to ' + v.cap + ' a day. Today: ' + v.got + ' of ' + v.cap + '.',
      rule: 'Tokens only buy cosmetics. They never turn into chips, and chips are never sold.',
      emoNote: 'Each pack adds four emotes to the table chat, visible to everyone at the table.',
      pending: 'Waiting for approval. The tokens arrive once it is approved.',
      bonus: v => '+' + v.n + '%',
      popular: 'Popular',
      best: 'Best value',
      vip: {
        name: 'Amerikano VIP',
        length: 'Monthly subscription, 1 month',
        per: v => v.price + ' per month',
        badge: 'VIP badge at every table',
        frame: 'Animated gold frame',
        items: 'VIP name plate and card back',
        monthly: (v, t) => t('shop.count', { n: v.n }) + ' every month',
        pass: 'Premium season pass (coming soon)',
        subscribe: 'Subscribe',
        restore: 'Restore purchases',
        manage: 'Manage subscription',
        until: v => 'VIP until ' + v.date,
        renew: 'Payment is charged to your Apple Account at confirmation. The subscription renews automatically every month unless it is cancelled at least 24 hours before the period ends. Manage or cancel it in your App Store account settings.',
        terms: 'Terms of Use',
        only: 'VIP only',
        web: 'Subscribe in the iPhone app',
        on: 'Welcome to VIP.',
        restored: 'Your purchases are up to date.'
      },
      item: {
        'frame-brass': 'Brass ring', 'frame-laurel': 'Laurel wreath', 'frame-kilim': 'Kilim border', 'frame-moon': 'Crescent moon', 'frame-ember': 'Ember glow', 'frame-royal': 'Royal gold',
        'plate-oak': 'Oak', 'plate-copper': 'Copper', 'plate-kilim': 'Kilim', 'plate-night': 'Night', 'plate-gilt': 'Gilded',
        'back-lattice': 'Lattice', 'back-emerald': 'Emerald', 'back-amber': 'Amber', 'back-star': 'Star', 'back-sultan': 'Sultan',
        'felt-plum': 'Plum', 'felt-ink': 'Midnight', 'felt-copper': 'Copper', 'felt-teal': 'Teal', 'felt-kilim': 'Kilim',
        'emo-cafe': 'Coffeehouse', 'emo-luck': 'Good luck', 'emo-cheek': 'Cheeky', 'frame-gold': 'Golden halo', 'plate-vip': 'Velvet', 'back-vip': 'Brocade'
      },
      emo: { tea: 'Tea', cezve: 'Coffee pot', baklava: 'Baklava', lamp: 'Lamp', eye: 'Evil eye', clover: 'Clover', shoe: 'Horseshoe', dice: 'Dice', shades: 'Cool', flame: 'Fire', zzz: 'Sleepy', clap: 'Applause' }
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
      invFree: v => v.name + ' invites you to a table. No chips at stake.',
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
      mute: 'Şu an mesaj yazamazsın.',
      typedoff: 'Yazılı sohbet kapalı. Ayarlar bölümünden açabilirsin.',
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
      out: 'Çıkış yap',
      privacy: 'Gizlilik politikası',
      lang: 'Dil',
      auto: 'Telefonun dili',
      region: 'Bölge',
      reg: { am: 'Amerika', eu: 'Avrupa', tr: 'Türkiye', mea: 'Orta Doğu ve Afrika', ap: 'Asya-Pasifik' },
      regionNote: 'Hızlı oyun, herkese açık masalar ve turnuvalar seni bölgendeki oyuncularla eşleştirir. Arkadaşlar ve özel masalar her yerde çalışır.',
      typed: 'Yazılı sohbet',
      typedNote: 'Diğer oyuncuların masada yazdıklarını ve arkadaşlarından gelen özel mesajları gösterir. Hazır sözler ve ifadeler her zaman çalışır.',
      voice: 'Sesli konuşma',
      voiceNote: 'Masada ve aramalarda diğer oyuncuları duyarsın, mikrofonunla konuşabilirsin. Kapalıyken sesli konuşma tamamen devre dışı kalır.',
      sound: 'Ses',
      haptics: 'Titreşim',
      fourc: 'Dört renkli işaretler',
      fourcNote: 'Maça siyah, kupa kırmızı, karo turuncu, sinek yeşil.',
      speed: 'Antrenman hızı',
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
      walnut: 'Ceviz',
      notes: 'Bildirimler',
      push: {
        on: 'Bildirimlere izin ver',
        invite: 'Masa davetleri',
        daily: 'Günlük ödül',
        friend: 'Arkadaşlık istekleri',
        week: 'Haftalık sıralama',
        dm: 'Mesajlar',
        denied: 'Bildirimler cihazının ayarlarında Amerikano için kapalı. Bunlardan birini almak için oradan açman gerekir.'
      }
    },

    pause: {
      title: 'Duraklatıldı',
      resume: 'Oyuna dön',
      how: 'Nasıl oynanır',
      settings: 'Ayarlar',
      leave: 'Maçtan çık',
      note: 'Maçın kaydedildi. Lobiden devam edebilirsin.',
      onlineNote: 'Maç sensiz devam eder. Ayrılırsan senin yerine oynanır.',
      pubNote: 'Herkese açık masadan ayrılmak çipe mal olabilir; bir haftada birkaç kez ayrılırsan yeniden oturmak için beklemen gerekir.'
    },

    idle: {
      note: 'Süren doldu, senin yerine oynanıyor.',
      back: 'Geri döndüm'
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
      rematch: 'Rövanş',
      rmLine: v => v.n + ' kişiden ' + v.want + ' rövanş istiyor. ' + v.s + ' sn kaldı.',
      rmFind: 'Rövanş için oyuncu aranıyor.',
      lobby: 'Lobiye dön',
      change: v => v.n > 0 ? v.abs + ' çip kazandın.' : v.n < 0 ? v.abs + ' çip kaybettin.' : 'Bahsin geri döndü.',
      xp: v => '+' + v.n + ' XP',
      tokens: v => '+' + v.n + ' jeton',
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
        starting: 'Bu turnuva başlıyor. Birazdan tekrar dene.',
        taken: 'Bu kod kullanımda, tekrar dene.',
        auth: 'Hesabın doğrulanamadı. Tekrar dene.',
        poor: 'Bunun için yeterli çipin yok.',
        busy: 'Başka bir masada zaten yerin var.',
        held: v => v.name + ' başka bir masada oturuyor, bu yüzden maç henüz başlayamaz.',
        elsewhere: 'Başka bir masada yerin var, bu yüzden bu maç başlayamıyor. Önce o masadan ayrıl.',
        dealfail: 'Maç başlatılamadı. Çiplerin iade edildi. Tekrar dene.',
        left: 'Bu maçtan ayrıldığın için koltuğuna geri dönemezsin.',
        cool: v => 'Masalardan çok sık ayrıldın. ' + v.n + ' dk boyunca bu masaya ya da daha büyük bir masaya oturamazsın.',
        guest: 'Bunun kilidini açmak için Apple ile giriş yap. Misafirler en küçük iki masada ve masa değeri 0 olan arkadaş masalarında oynayabilir.',
        level: v => 'Bu masada oynamak için ' + v.n + '. seviye gerekir.',
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
      stakeNote: v => 'Maç başlarken ' + fmt(v.h) + ' çip ayrılır; bu, bu masada kaybedebileceğin en yüksek tutardır. Kaybetmediğin kısım maç bitince geri ödenir.',
      noStake: 'Masada çip yok.',
      stakeHint: '10’un katı olmalı. 0 olursa çip oynanmaz.',
      stakeBad: 'Masa değeri 10’un katı olmalı.',
      friends: 'Arkadaşlarla oyna',
      locked: 'Kilitli',
      lockGuest: 'Kilidi açmak için giriş yap',
      fee: v => 'Masa ücreti: ' + fmt(v.n) + ' çip',
      minFee: v => 'En az ' + v.n + ' · ücret ' + v.f,
      cool: v => v.n + ' dk bekle',
      level: v => v.n + '. sv'
    },

    cup: {
      tab: 'Turnuvalar',
      title: 'Bir turnuva seç',
      line: '8 oyuncu, 2 masa, sonra final',
      prize: v => 'Birincilik ödülü ' + v.n,
      cap: 'Son sıralama ve puanlar',
      table: 'Turnuva',
      buy: v => 'Giriş ' + v.n,
      seats: v => '8 koltuktan ' + v.n + ' tanesi dolu',
      prizes: 'Ödüller',
      place: v => v.n + '.',
      note: 'Tüm 8 koltuk dolunca başlar. Giriş bedeli o zaman alınır; şimdi vazgeçersen hiçbir şey alınmaz.',
      round: { first: '1. tur', final: 'Final' },
      through: 'Finale yükseldin',
      out: '1. turda elendin',
      finished: v => 'Masanda ' + v.n + '. oldun. Diğer masa bekleniyor.',
      outNote: v => 'Masanda ' + v.n + '. oldun. Finale yalnızca ilk ikisi çıkar.',
      off: 'Turnuva iptal edildi. Giriş bedelin iade edildi.',
      starting: 'Başlıyor...',
      won: v => v.you ? 'Turnuvayı sen kazandın' : v.name + ' turnuvayı kazandı',
      final: v => 'Finalde ' + v.n + '. oldun.',
      yourPrize: 'Ödülün',
      giveUp: 'Turnuvadan çık',
      leaveNote: 'Çıkarsan turnuvadaki yerini ve olası ödülü kaybedersin. Senin yerine oynanır.'
    },

    nonet: {
      down: 'Çevrimdışısın',
      downNote: 'Çevrimiçi masalar için bağlantı gerekir. Antrenman bağlantısız da çalışır.',
      retry: 'Tekrar dene',
      replaced: 'Başka yerde açık',
      replacedNote: 'Amerikano başka bir cihazda ya da pencerede açık.',
      here: 'Burada oyna'
    },

    signin: {
      lead: 'Çiplerini tüm cihazlarında korumak için giriş yap.',
      leadGuest: 'Misafir hesabıyla hemen oyna.',
      apple: 'Apple ile giriş yap',
      guest: 'Misafir olarak devam et',
      note: 'Misafir hesabı bu cihazda kalır.',
      fail: 'Olmadı. Tekrar dene.'
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
      keep: 'Hesabımı koru',
      appleNote: 'Çiplerini koru, başka cihazlarda oyna.',
      linked: 'Apple ile giriş yapıldı',
      taken: 'Bu Apple kimliğinin zaten bir hesabı var',
      takenAsk: 'O hesaba geçilsin mi? Bu misafir hesabı ve çipleri kaybolur.',
      switch: 'Hesaba geç',
      other: 'Bu hesap başka bir Apple kimliğine bağlı.',
      reauth: 'Silmeyi bitirmek için Apple ile onayla. Düğmeye tekrar bas.'
    },

    chat: {
      title: 'Hızlı sohbet',
      open: 'Sohbet',
      phrases: 'Sözler',
      emotes: 'İfadeler',
      type: 'Mesaj',
      hint: 'Bir şey yaz',
      send: 'Gönder',
      log: 'Bu masadaki mesajlar',
      none: 'Henüz bir şey yazılmadı.',
      say: {
        hello: 'Merhaba!', luck: 'İyi şanslar!', nice: 'Güzel hamle!', thanks: 'Teşekkürler!', oops: 'Eyvah!', hurry: 'Sıra sende, hadi.',
        wow: 'Vay canına!', close: 'Ucu ucuna!', sorry: 'Pardon!', rematch: 'Bir daha?', well: 'Eline sağlık!', bye: 'Hoşça kal!'
      },
      emo: { smile: 'Gülümseme', laugh: 'Kahkaha', wink: 'Göz kırpma', love: 'Aşk', gasp: 'Şaşkın', sad: 'Üzgün', angry: 'Kızgın', cheer: 'Yaşasın' },
      said: v => v.name + ': ' + v.what
    },

    dm: {
      open: 'Mesaj',
      none: 'Henüz mesaj yok.',
      you: 'Sen',
      older: 'Eski mesajlar',
      new: v => v.name + ' sana bir mesaj gönderdi.',
      slow: 'Biraz yavaş.',
      mute: 'Şu an mesaj yazamazsın.',
      off: 'Yazılı sohbet kapalı. Ayarlar bölümünden açabilirsin.',
      no: 'Bu mesaj gönderilemedi.'
    },

    voice: {
      mic: { on: 'Mikrofon açık. Kapatmak için dokun.', off: 'Mikrofon kapalı. Açmak için dokun.' },
      spk: { on: 'Ses açık. Herkesi susturmak için dokun.', off: 'Ses kapalı. Dinlemek için dokun.' },
      denied: 'Mikrofon izni yok. Cihazının ayarlarından izin verebilirsin.',
      fail: 'Ses bağlanamadı.',
      mute: 'Sesini kapat',
      unmute: 'Sesini aç',
      call: 'Ara',
      in: v => v.name + ' arıyor.',
      calling: v => v.name + ' aranıyor.',
      talking: v => v.name + ' ile görüşüyorsun.',
      accept: 'Cevapla',
      decline: 'Reddet',
      hang: 'Kapat',
      muteMe: 'Sessize al',
      end: {
        missed: 'Cevap yok.', missedIn: 'Cevapsız arama.', declined: 'Arama reddedildi.', busy: 'Şu an meşgul.', away: 'Çevrimdışı.',
        no: 'Bu arama yapılamadı.', slow: 'Tekrar aramadan önce biraz bekle.', dropped: 'Arama koptu.'
      },
      line: { missed: 'Cevapsız arama', missedMine: 'Cevap yok', declined: 'Arama reddedildi' }
    },

    rep: { do: 'Şikâyet et', done: 'Şikâyet edildi' },

    warn: {
      title: 'Göndermeden önce',
      text: 'İletişim bilgilerini paylaşmak sana kalmış, ama tanımadığın kişilerle asla paylaşma. Amerikano çipleri asla alınıp satılamaz. Çip takası öneren herkesi şikâyet et.',
      send: 'Yine de gönder',
      edit: 'Düzenle',
      note: 'Diğer oyuncuların gönderdiği bağlantılara ve iletişim bilgilerine dikkat et. Çipler asla satılmaz.'
    },

    shop: {
      title: 'Mağaza',
      count: v => pl(v.n, { other: '# jeton' }),
      tab: { tokens: 'Jetonlar', frame: 'Çerçeveler', plate: 'İsim levhaları', back: 'Kağıt sırtları', felt: 'Masa çuhaları', emote: 'İfadeler', vip: 'VIP' },
      loading: 'Mağaza yükleniyor.',
      buyFor: v => 'Satın al: ' + v.name + ', ' + v.n,
      ask: v => v.n + ' karşılığında alınsın mı?',
      yes: 'Satın al',
      no: 'Vazgeç',
      wear: 'Kullan',
      off: 'Çıkar',
      worn: 'Kullanımda',
      owned: 'Sende',
      bought: v => v.name + ' artık senin.',
      added: (v, t) => t('shop.count', v) + ' hesabına eklendi.',
      failed: 'Olmadı. Biraz sonra tekrar dene.',
      broke: 'Yeterli jetonun yok.',
      late: 'Alışveriş tamamlandı, jetonların birazdan gelir.',
      android: 'Android için yakında',
      web: 'Jeton almak için iPhone uygulamasını kullan',
      guest: 'Aldıkların uygulamayı silip yeniden kursan da kalsın diye profilinden Apple hesabını bağla.',
      earn: (v, t) => 'Bitirdiğin her çevrimiçi maç ' + t('shop.count', { n: v.n }) + ' kazandırır, günde en çok ' + v.cap + '. Bugün: ' + v.got + '/' + v.cap + '.',
      rule: 'Jetonla yalnızca görünüm eşyaları alınır. Jeton asla çipe dönüşmez, çip de hiçbir zaman satılmaz.',
      emoNote: 'Her paket masa sohbetine dört ifade ekler, masadaki herkes görür.',
      pending: 'Onay bekleniyor. Onaylanınca jetonlar gelir.',
      bonus: v => '+' + v.n + '%',
      popular: 'Popüler',
      best: 'En avantajlı',
      vip: {
        name: 'Amerikano VIP',
        length: 'Aylık abonelik, 1 ay',
        per: v => v.price + ' / ay',
        badge: 'Her masada VIP rozeti',
        frame: 'Hareketli altın çerçeve',
        items: 'VIP isim levhası ve kağıt sırtı',
        monthly: (v, t) => t('shop.count', { n: v.n }) + ' her ay',
        pass: 'Premium sezon bileti (yakında)',
        subscribe: 'Abone ol',
        restore: 'Satın alımları geri yükle',
        manage: 'Aboneliği yönet',
        until: v => 'VIP ' + v.date + ' tarihine kadar',
        renew: 'Ödeme, onay anında Apple Hesabından alınır. Abonelik, dönem bitmeden en az 24 saat önce iptal edilmezse her ay kendiliğinden yenilenir. Aboneliği App Store hesap ayarlarından yönetebilir veya iptal edebilirsin.',
        terms: 'Kullanım Koşulları',
        only: 'Yalnızca VIP',
        web: 'iPhone uygulamasından abone ol',
        on: 'VIP’e hoş geldin.',
        restored: 'Satın alımların güncel.'
      },
      item: {
        'frame-brass': 'Pirinç halka', 'frame-laurel': 'Defne çelengi', 'frame-kilim': 'Kilim kenar', 'frame-moon': 'Hilal', 'frame-ember': 'Kor', 'frame-royal': 'Sultan altını',
        'plate-oak': 'Meşe', 'plate-copper': 'Bakır', 'plate-kilim': 'Kilim', 'plate-night': 'Gece', 'plate-gilt': 'Yaldız',
        'back-lattice': 'Kafes', 'back-emerald': 'Zümrüt', 'back-amber': 'Kehribar', 'back-star': 'Yıldız', 'back-sultan': 'Sultan',
        'felt-plum': 'Erik', 'felt-ink': 'Gece mavisi', 'felt-copper': 'Bakır', 'felt-teal': 'Petrol', 'felt-kilim': 'Kilim',
        'emo-cafe': 'Kahvehane', 'emo-luck': 'Şans', 'emo-cheek': 'Cilveli', 'frame-gold': 'Altın hale', 'plate-vip': 'Kadife', 'back-vip': 'Brokar'
      },
      emo: { tea: 'Çay', cezve: 'Cezve', baklava: 'Baklava', lamp: 'Lamba', eye: 'Nazar', clover: 'Yonca', shoe: 'Nal', dice: 'Zar', shades: 'Havalı', flame: 'Ateş', zzz: 'Uykulu', clap: 'Alkış' }
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
      invFree: v => v.name + ' seni bir masaya çağırıyor. Masada çip yok.',
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

  // the languages that have a file; add a code here when its lang/ and names/ files land
  const CODES = ['en', 'tr', 'es', 'pt', 'fr', 'it', 'nl', 'de', 'pl', 'ru', 'uk', 'ar', 'hi', 'id', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
  const NAMES = {
    en: 'English', tr: 'Türkçe', es: 'Español', pt: 'Português (Brasil)', fr: 'Français', de: 'Deutsch', it: 'Italiano', nl: 'Nederlands', pl: 'Polski',
    ru: 'Русский', uk: 'Українська', ar: 'العربية', hi: 'हिन्दी', id: 'Bahasa Indonesia', ja: '日本語', ko: '한국어', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文'
  };
  // the region a language is formatted for; Arabic keeps Western digits, like the card numbers beside it
  const LOC = { es: 'es-419', pt: 'pt-BR', ar: 'ar-u-nu-latn' };
  const RTL = ['ar'];

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

  const fmt = n => nf.format(n);

  // picks the form Intl names for n: { one: '# carta', other: '# cartas' }, # is the number; ordinal: true for 1st, 2nd
  function pl(n, forms, ordinal) {
    const k = ordinal ? 'ordinal' : 'cardinal';
    const r = rules[k] || (rules[k] = new Intl.PluralRules(loc, { type: k }));
    return (forms[r.select(n)] || forms.other).replace('#', fmt(n));
  }

  function code(l) {
    const p = l.toLowerCase().split(/[-_]/);
    if (p[0] === 'zh') return p.includes('hans') ? 'zh-Hans' : p.some(x => ['hant', 'tw', 'hk', 'mo'].includes(x)) ? 'zh-Hant' : 'zh-Hans';
    return p[0] === 'in' ? 'id' : p[0];
  }

  function resolve(p) {
    if (CODES.includes(p)) return p;
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
    return langs.map(code).find(c => CODES.includes(c)) || 'en';
  }

  function script(src) {
    return new Promise(res => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = s.onerror = () => { s.remove(); res(); };
      document.head.appendChild(s);
    });
  }

  const loading = {};

  function load(c) {
    // kept after a failure too, so a missing file is not asked for again
    if (!loading[c]) loading[c] = Promise.all(['lang/', 'names/'].map(d => script('js/' + d + c + '.js')));
    return loading[c];
  }

  function use(c) {
    lang = S[c] ? c : 'en';
    loc = LOC[lang] || lang;
    nf = new Intl.NumberFormat(loc);
    rules = {};
    const h = document.documentElement;
    h.lang = lang;
    h.classList.toggle('rtl', RTL.includes(lang));
    document.getElementById('rotx').textContent = t('rot');
  }

  // returns a promise while a language file is still coming in, nothing otherwise
  function set(p) {
    pref = p;
    const c = resolve(p);
    if (S[c]) return use(c);
    return load(c).then(() => { if (pref === p) use(c); });
  }

  return {
    t: t, set: set, add: (c, tbl) => { S[c] = tbl; }, cap: cap, num: num, fmt: fmt, pl: pl,
    pref: () => pref, lang: () => lang, loc: () => loc, codes: CODES, names: NAMES, S: S
  };
})();

var t = I18n.t;
