(() => {
  let room = null, timer = null, config = null;
  const human = () => room.players.find(p => p.id === 'you');
  const publish = () => {
    const current = room.players[room.currentIndex];
    const state = {
      ...trumpPublicState(room, human()), offline: true, roomId: 'Offline', serverBuild: '0.95',
      connectionLabel: 'Offline', playerCount: room.players.length, playerId: 'you', hostId: 'you',
      started: true, currentPlayerId: current.id, currentPlayerName: current.name,
      roundNumber: room.roundNumber, matchId: room.matchId, hand: [...human().hand], winner: room.winner || '',
      winnerReason: room.winnerReason || '', canStart: Boolean(room.winner), allReady: true,
      players: room.players.map(p => ({ id: p.id, name: p.name, avatarIndex: p.avatarIndex,
        team: p.team, isBot: p.isBot, difficulty: p.difficulty, connected: true, ready: true,
        cardCount: p.hand.length, wins: p.wins || 0 })),
      latestEvent: room.log.at(-1) || '', log: room.log.slice(-30),
    };
    window.OfflineBridge.state(JSON.stringify(state));
  };
  const bots = () => {
    clearTimeout(timer); publish();
    const current = room.players[room.currentIndex];
    if (room.winner) return;
    const waiting = ['toss', 'reveal'].includes(room.trump.phase);
    const delay = waiting ? Math.max(1, room.trump.resolveAt - Date.now())
      : current.isBot ? 700 : Math.max(1, room.trump.deadline - Date.now());
    timer = setTimeout(() => {
      if (advanceTrump(room)) { bots(); return; }
      if (current.isBot && room.trump.phase === 'choose') chooseTrump(room, current.id, chooseBotTrump(current));
      else if (current.isBot && room.trump.phase === 'play') playTrump(room, current.id, [chooseBotTrumpCard(room, current)]);
      bots();
    }, delay);
  };
  const begin = () => {
    clearTimeout(timer); room.started = true; room.winner = ''; room.winnerReason = '';
    room.roundNumber++; room.matchId = 'offline-trump-' + Date.now() + '-' + Math.random().toString(36).slice(2); beginTrump(room); bots();
  };
  window.OfflineTrump = {
    start(settings) {
      config = settings;
      if (![4, 6, 8].includes(config.count)) throw Error('Choose 4, 6 or 8 seats.');
      room = { players: Array.from({ length: config.count }, (_, i) => ({
        id: i === 0 ? 'you' : 'bot-' + i, name: i === 0 ? config.name : 'Bot ' + i,
        avatarIndex: i === 0 ? config.avatarIndex : 7, team: i % 2, hand: [],
        isBot: i !== 0, difficulty: config.difficulty,
      })), currentIndex: 0, started: true, log: [], roundNumber: 0, requireTrumpOpened: Boolean(config.requireTrumpOpened) };
      begin();
    },
    action(type, value) {
      let error = '';
      if (type === 'play') error = playTrump(room, 'you', JSON.parse(value).cards);
      else if (type === 'extend') error = extendTrumpTurn(room, 'you');
      else if (type === 'trump') error = chooseTrump(room, 'you', value);
      else if (type === 'start' && room.winner) begin();
      else if (type === 'trumpLeadRule' && room.winner) room.requireTrumpOpened = value === 'true';
      else if (type === 'team' && room.winner) {
        const team = Number(value), me = human();
        if ([0, 1].includes(team) && me.team !== team) {
          const partner = room.players.find(p => p.isBot && p.team === team);
          partner.team = me.team; me.team = team;
          room.teamsChanged = true;
        }
      } else if (type === 'shuffle' && room.winner) {
        const shuffled = [...room.players];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        shuffled.forEach((p, i) => { p.team = i % 2; });
        room.teamsChanged = true;
      } else error = 'Wait for your turn or finish the current game.';
      if (error) window.OfflineBridge.error(error);
      bots();
    },
  };
})();
