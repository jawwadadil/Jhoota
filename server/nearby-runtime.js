// The native transport and solo mode both execute the unmodified server room rules.
(() => {
  const sockets = new Map();
  let paused = false, solo = null, soloConfig = null;
  const bridge = window.NearbyBridge;
  const emit = (id, data) => {
    const message = JSON.parse(data);
    if (message.state) {
      message.state.nearby = !solo;
      message.state.offline = Boolean(solo);
      message.state.liveCalls = false;
      message.state.connectionLabel = solo ? 'Offline with Bots' : 'Nearby';
      if (solo) { message.state.paused = paused; message.state.canStart = Boolean(message.state.winner); }
    }
    bridge.send(id, JSON.stringify(message));
    if (message.type === 'created') bridge.room(message.roomId, rooms.get(message.roomId).gameType);
  };
  const snapshot = () => {
    const now = Date.now();
    const copy = [...rooms.values()].map(room => JSON.parse(JSON.stringify(room, (key, value) =>
      ['socket', 'botTimer', 'trumpRandom'].includes(key) ? undefined : value)));
    for (const room of copy) {
      if (room.pausedAt != null) {
        const shift = Math.max(0, now - room.pausedAt);
        if (room.turnDeadline) room.turnDeadline += shift;
        if (room.trump?.deadline) room.trump.deadline += shift;
        if (room.trump?.resolveAt) room.trump.resolveAt += shift;
        delete room.pausedAt;
      }
    }
    const value = JSON.stringify({ schema: 1, savedAt: now, rooms: copy, solo, config: soloConfig });
    bridge.save(value); return value;
  };
  const open = id => {
    const socket = { readyState: 1, send: data => emit(id, data), close: () => window.NearbyEngine.close(id) };
    sockets.set(id, socket); return socket;
  };
  const tick = () => {
    if (paused) return;
    const now = Date.now();
    for (const room of rooms.values()) {
      if (!room.started || room.winner || !room.players.some(p => !p.isBot && p.connected)) continue;
      if (room.gameType === 'trump') {
        if (advanceTrump(room, now)) { broadcast(room); runBots(room); }
      } else {
        syncBluffDeadline(room, now);
        if (now >= room.turnDeadline) {
          room.log.push(`${currentPlayer(room).name}'s turn timed out. Automatic pass.`);
          pass(room, currentPlayer(room).id);
        }
      }
    }
  };
  const originalBroadcast = broadcast;
  broadcast = room => { originalBroadcast(room); snapshot(); };
  const restore = (value, botMode) => {
    const data = JSON.parse(value);
    if (data.schema !== 1 || !Array.isArray(data.rooms) || !data.rooms.length) throw Error('Saved game is not compatible.');
    const elapsed = Math.max(0, Date.now() - data.savedAt);
    for (const room of data.rooms) {
      if (![2, 3, 4, 5, 6, 7, 8].includes(room.players?.length) || !['trump', 'bluff'].includes(room.gameType)) throw Error('Invalid saved seats.');
      // Solo clocks pause while away; nearby clocks get a fresh reconnect grace period.
      const shift = botMode ? elapsed : Math.max(elapsed, 15000);
      if (room.turnDeadline) room.turnDeadline += shift;
      if (room.trump?.deadline) room.trump.deadline += shift;
      if (room.trump?.resolveAt) room.trump.resolveAt += shift;
      delete room.pausedAt;
      for (const p of room.players) { p.socket = null; p.connected = Boolean(p.isBot); }
      room.trumpRandom = Math.random;
      rooms.set(room.id, room);
    }
    solo = botMode ? data.solo : null; soloConfig = botMode ? data.config : null;
    return data;
  };
  window.NearbyEngine = {
    open,
    message(id, data) {
      try {
        const socket = sockets.get(id);
        if (!socket) return;
        const message = JSON.parse(data);
        if (message.type === 'create' && rooms.size) return send(socket, { type: 'error', message: 'This phone already hosts a room. Join it instead.' });
        if (paused && !['setReady', 'start', 'leave'].includes(message.type)) return send(socket, { type: 'error', message: 'Resume the saved game first.' });
        handle(socket, message);
      } catch { emit(id, JSON.stringify({ type: 'error', message: 'That action could not be completed.' })); }
    },
    close(id) {
      const socket = sockets.get(id); if (!socket) return;
      socket.readyState = 3;
      const room = rooms.get(socket.roomId);
      if (room) disconnectPlayer(room, socket);
      sockets.delete(id);
    },
    restore(value) { restore(value, false); },
    tick,
    botStart(config, saved) {
      soloConfig = config;
      const socket = open('solo');
      if (saved) {
        const data = restore(saved, true);
        const room = rooms.get(solo.roomId), player = room.players.find(p => p.id === solo.playerId);
        if (!player) throw Error('Saved seat is missing.');
        attach(socket, room, player); broadcast(room); runBots(room); return;
      }
      if (config.gameType === 'trump' ? ![4, 6, 8].includes(config.count) : !Number.isInteger(config.count) || config.count < 2 || config.count > 8) throw Error('Choose a valid player count.');
      // Mark solo before the first room state so call controls never flash on screen.
      solo = { roomId: '', playerId: '' };
      createRoom(socket, config.name, config.avatarIndex, '0.95', config.gameType, 106, config.requireTrumpOpened);
      const room = rooms.get(socket.roomId);
      solo = { roomId: room.id, playerId: socket.playerId };
      room.cheatingAllowed = Boolean(config.cheatingAllowed);
      room.seriesLength = [0, 3, 5].includes(config.seriesLength) ? config.seriesLength : 0;
      room.botSpeedMs = { Slow: 1400, Normal: 700, Fast: 350 }[config.speed] || 700;
      fillBots(room, socket.playerId, config.count, config.difficulty);
      setReady(room, socket.playerId, true); startGame(room, socket.playerId);
    },
    botAction(type, value) {
      const message = { type };
      const map = { trump: ['chooseTrump', 'suit'], toss: ['trumpToss', 'choice'], caller: ['selectTrumpCaller', 'callerId'], review: ['reviewTrumpHand'], redeal: ['requestTrumpRedeal'], catchCheat: ['catchTrumpCheat', 'targetId'], extend: ['extendTurn'], team: ['chooseTeam', 'team'], shuffle: ['shuffleTeams'], trumpLeadRule: ['setTrumpLeadRule', 'enabled'], cheatingRule: ['setCheatingRule', 'enabled'], series: ['setSeries', 'length'] };
      if (type === 'play') Object.assign(message, JSON.parse(value));
      if (map[type]) { message.type = map[type][0]; if (map[type][1]) message[map[type][1]] = ['team', 'length'].includes(map[type][1]) ? Number(value) : map[type][1] === 'enabled' ? value === 'true' : value; }
      if (type === 'start') { this.pause(false); setReady(rooms.get(solo.roomId), solo.playerId, true); }
      this.message('solo', JSON.stringify(message));
    },
    pause(value) {
      if (!solo || value === paused) return;
      if (value) {
        snapshot(); paused = true;
        for (const room of rooms.values()) { room.pausedAt = Date.now(); clearTimeout(room.botTimer); }
      } else {
        paused = false;
        for (const room of rooms.values()) {
          const shift = Date.now() - (room.pausedAt || Date.now());
          if (room.turnDeadline) room.turnDeadline += shift;
          if (room.trump?.deadline) room.trump.deadline += shift;
          if (room.trump?.resolveAt) room.trump.resolveAt += shift;
          delete room.pausedAt; runBots(room);
        }
      }
      for (const room of rooms.values()) broadcast(room);
    },
    stop() { for (const room of rooms.values()) clearTimeout(room.botTimer); rooms.clear(); sockets.clear(); paused = true; },
    exportSnapshot() { return snapshot(); },
  };
  bridge.ready();
})();
