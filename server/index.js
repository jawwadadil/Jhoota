import { WebSocketServer } from "ws";
import http from "http";
import os from "os";
import { readFileSync } from "node:fs";
import { liveCallConfigured, liveCallCredentials } from "./live-call.js";
import { beginTrump, chooseTrump, playTrump, trumpPublicState, trumpSeatError, chooseBotTrump, chooseBotTrumpCard, advanceTrump, extendTrumpTurn, TURN_MS, EXTENSION_MS } from "./trump.js";

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];
const SERVER_NAME = "Jhoota online server";
const SERVER_PROTOCOL = 7;
const SERVER_BUILD = "0.95";
const AVATAR_COUNT = 16;
const rooms = new Map();
const ROOM_TTL_MS = 1000 * 60 * 60 * 3;
const HEARTBEAT_MS = 1000 * 20;
const TEST_COMMANDS = process.env.ENABLE_TEST_COMMANDS === "1";
const MAX_VOICE_DURATION_MS = 6000;
const MAX_VOICE_AUDIO_BYTES = 180_000;
const MAX_VOICE_BASE64_CHARS = Math.ceil(MAX_VOICE_AUDIO_BYTES / 3) * 4;

const httpServer = http.createServer((request, response) => {
  if (request.url === '/call' || request.url === '/call-client.js') {
    const file = request.url === '/call' ? 'call.html' : 'call-client.js';
    response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; connect-src https: wss:; media-src blob:; frame-ancestors 'none'",
      'permissions-policy': 'microphone=(self), camera=()' });
    response.end(readFileSync(new URL(file, import.meta.url))); return;
  }
  const stats = serverStats();
  if (request.url === "/health") {
    return json(response, {
      ok: true,
      name: SERVER_NAME,
      serverProtocol: SERVER_PROTOCOL,
      serverBuild: SERVER_BUILD,
      rulesRevision: 103,
      heartbeatMs: HEARTBEAT_MS,
      roomTtlMinutes: Math.round(ROOM_TTL_MS / 60000),
      uptimeSeconds: Math.floor(process.uptime()),
      maxPlayers: 8,
      avatarProfiles: AVATAR_COUNT,
      gameTypes: ["bluff", "trump"],
      voiceClips: true,
      liveCalls: liveCallConfigured(),
      maxVoiceDurationMs: MAX_VOICE_DURATION_MS,
      urls: localServerUrls(),
      network: `http://127.0.0.1:${PORT}/network`,
      roomsUrl: `http://127.0.0.1:${PORT}/rooms`,
      ...stats,
    });
  }
  if (request.url === "/network") {
    return json(response, {
      port: Number(PORT),
      host: HOST,
      urls: localServerUrls(),
      health: `http://127.0.0.1:${PORT}/health`,
      rooms: `http://127.0.0.1:${PORT}/rooms`,
      note: "Use a ws:// URL on same Wi-Fi, or a wss:// public URL after hosting online.",
    });
  }
  if (request.url?.startsWith("/room/")) {
    const roomId = decodeURIComponent(request.url.slice("/room/".length)).replace(/\D/g, "").slice(0, 6);
    const room = rooms.get(roomId);
    if (!room) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        code: "ROOM_NOT_FOUND",
        roomId,
        message: "Room is not active on this server. Ask host for the latest invite or create a new room.",
      }));
      return;
    }
    return json(response, {
      ok: true,
      room: roomSummary(room),
    });
  }
  if (request.url === "/rooms") {
    return json(response, {
      rooms: [...rooms.values()].map((room) => roomSummary(room)),
    });
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(
    `Jhoota server is running\nRooms: ${stats.rooms}\nPlayers: ${stats.players}\nConnected: ${stats.connected}\n\n` +
    `Build: ${SERVER_BUILD}\nProtocol: ${SERVER_PROTOCOL}\n\n` +
    `Phone URLs:\n${localServerUrls().map((url) => `- ${url}`).join("\n")}\n\n` +
    "Open /health, /rooms, or /network for status.\n"
  );
});
const server = new WebSocketServer({ server: httpServer, maxPayload: 512 * 1024 });

httpServer.listen(PORT, HOST, () => {
  console.log(`Jhoota online server running on ws://${HOST}:${PORT}`);
  console.log("Phone URLs on this Wi-Fi:");
  for (const url of localServerUrls()) {
    console.log(`  ${url}`);
  }
  console.log("Status: http://127.0.0.1:" + PORT + "/health");
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const hasConnectedHuman = room.players.some((player) => !player.isBot && player.connected);
    if (!hasConnectedHuman && now - (room.updatedAt || now) > ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}, 1000 * 60 * 10);

const heartbeatTimer = setInterval(() => {
  for (const socket of server.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

const turnTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started || room.winner) continue;
    if (!room.players.some(p => !p.isBot && p.connected)) continue;
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
}, 250);

server.on("close", () => { clearInterval(heartbeatTimer); clearInterval(turnTimer); });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing Jhoota connections.`);
  clearInterval(heartbeatTimer);
  clearInterval(turnTimer);
  for (const socket of server.clients) {
    socket.close(1012, "server restarting");
  }
  server.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      handle(socket, message);
    } catch (error) {
      send(socket, { type: "error", message: "Bad message." });
    }
  });

  socket.on("close", () => {
    if (!socket.roomId || !socket.playerId) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const player = room.players.find((item) => item.id === socket.playerId);
    const activeSocket = Boolean(player && player.socket === socket);
    if (player && player.socket === socket) {
      player.connected = false;
      player.socket = null;
    }
    if (activeSocket && room.hostId === socket.playerId) {
      const nextHost = room.players.find((item) => !item.isBot && item.connected);
      if (nextHost) {
        room.hostId = nextHost.id;
        room.log.push(`${nextHost.name} is now host.`);
      }
    }
    if (activeSocket) broadcast(room);
  });
});


function handle(socket, message) {
  if (message.type === "create") return createRoom(socket, message.name, message.avatarIndex, message.appVersion, message.gameType, message.appBuild, message.requireTrumpOpened);
  if (message.type === "join") return joinRoom(socket, message.roomId, message.name, message.avatarIndex, message.reconnectToken, message.appVersion, message.appBuild);

  const room = rooms.get(socket.roomId);
  if (!room) return send(socket, { type: "error", message: "Join a room first." });
  if (room.gameType === "trump" && ["pass", "bluff", "setOpeningCards", "testSetup"].includes(message.type)) {
    return sendToPlayer(room, socket.playerId, "That action belongs to Bluff, not Trump.");
  }

  if (message.type === "start") return startGame(room, socket.playerId);
  if (message.type === 'setTrumpLeadRule') {
    if (room.gameType !== 'trump' || socket.playerId !== room.hostId || room.started && !room.winner || typeof message.enabled !== 'boolean') return sendToPlayer(room, socket.playerId, 'Only the host can change Trump rules in the lobby.');
    room.requireTrumpOpened = message.enabled;
    room.players.forEach(p => { if (!p.isBot) p.ready = false; });
    room.log.push(`Trump leading rule ${message.enabled ? 'enabled' : 'disabled'} for the next game.`);
    return broadcast(room);
  }
  if (message.type === 'extendTurn') {
    let error = '';
    if (room.gameType === 'trump') error = extendTrumpTurn(room, socket.playerId);
    else {
      syncBluffDeadline(room, Date.now());
      const player = currentPlayer(room);
      if (!room.started || room.winner || room.turnDeadline <= Date.now() || player.id !== socket.playerId || player.isBot) error = 'Only the current human player can extend an active turn.';
      else if (room.turnExtensions.includes(player.id)) error = 'Your extra time has already been used this game.';
      else { room.turnExtensions.push(player.id); room.turnDeadline += EXTENSION_MS; room.log.push(`${player.name} added 15 seconds to their turn.`); }
    }
    if (error) return sendToPlayer(room, socket.playerId, error);
    return broadcast(room);
  }
  if (message.type === "restartRound") return restartRound(room, socket.playerId);
  if (message.type === "addBot") return addBot(room, socket.playerId, message.difficulty || "Low");
  if (message.type === "fillBots") return fillBots(room, socket.playerId, message.target || 4, message.difficulty || "Low");
  if (message.type === "clearBots") return clearBots(room, socket.playerId);
  if (message.type === "setBotSpeed") return setBotSpeed(room, socket.playerId, message.speed || "Normal");
  if (message.type === "setOpeningCards") return setOpeningCards(room, socket.playerId, message.count);
  if (message.type === "setReady") return setReady(room, socket.playerId, message.ready);
  if (message.type === "kickOffline") return kickOffline(room, socket.playerId);
  if (message.type === "replaceOfflineWithBot") return replaceOfflineWithBot(room, socket.playerId);
  if (message.type === "skipOfflineTurn") return skipOfflineTurn(room, socket.playerId);
  if (message.type === "claimHost") return claimHost(room, socket.playerId);
  if (message.type === "chooseTeam" || message.type === "shuffleTeams") return changeTrumpTeams(room, socket.playerId, message);
  if (message.type === "chooseTrump") {
    if (room.gameType !== "trump") return sendToPlayer(room, socket.playerId, "This is a Bluff table.");
    const error = chooseTrump(room, socket.playerId, message.suit);
    if (error) return sendToPlayer(room, socket.playerId, error);
    broadcast(room);
    return runBots(room);
  }
  if (room.gameType === "trump" && message.type === "play") {
    const error = playTrump(room, socket.playerId, message.cards);
    if (error) return sendToPlayer(room, socket.playerId, error);
    broadcast(room);
    return runBots(room);
  }
  if (message.type === "play") return play(room, socket.playerId, message.cards || [], message.rank);
  if (message.type === "pass") return pass(room, socket.playerId);
  if (message.type === "bluff") return bluff(room, socket.playerId);
  if (message.type === "testSetup") return testSetup(room, socket.playerId, message);
  if (message.type === "sticker") return sticker(room, socket.playerId, message.value || "Nice try!");
  if (message.type === "chat") return chat(room, socket.playerId, message.value || "");
  if (message.type === "voice") return voice(room, socket.playerId, message.data, message.durationMs);
  if (message.type === 'liveCallToken') {
    const player = room.players.find(p => p.id === socket.playerId && p.socket === socket);
    if (!player) return send(socket, { type: 'liveCallError', message: 'Rejoin your game room first.' });
    if (player.lastCallTokenAt && Date.now() - player.lastCallTokenAt < 3000) return send(socket, { type: 'liveCallError', message: 'Wait a moment before retrying the call.' });
    player.lastCallTokenAt = Date.now();
    try { return send(socket, { type: 'liveCallToken', roomId: room.id, ...liveCallCredentials(room, player) }); }
    catch (error) { return send(socket, { type: 'liveCallError', message: error.message }); }
  }
  if (message.type === "endRoom") return endRoom(room, socket.playerId);
  if (message.type === "leave") return leaveRoom(room, socket);
}

function createRoom(socket, name, avatarIndex, appVersion, gameType, appBuild, requireTrumpOpened) {
  if (gameType && !["bluff", "trump"].includes(gameType)) return send(socket, { type: "error", message: "Choose Bluff or Trump." });
  const roomId = makeRoomId();
  const player = makePlayer(name || "Host", true, appVersion, avatarIndex);
  player.team = gameType === "trump" ? 0 : null;
  player.appBuild = Number.isSafeInteger(appBuild) ? appBuild : 0;
  player.ready = false;
  const room = {
    id: roomId,
    gameType: gameType === "trump" ? "trump" : "bluff",
    hostId: player.id,
    players: [player],
    started: false,
    requireTrumpOpened: requireTrumpOpened === true, turnExtensions: [],
    activeRank: null,
    currentIndex: 0,
    centerPile: [],
    lastPlayedMove: null,
    pendingWinnerId: null,
    winnerId: null,
    lastBluffResult: "",
    winnerReason: "",
    minimumOpeningCards: 2,
    botSpeedMs: 650,
    roundNumber: 0,
    consecutivePasses: 0,
    winner: null,
    updatedAt: Date.now(),
    log: [`Room ${roomId} created.`, gameType === "trump" ? "Choose equal teams. Trump is called from the first five cards." : "Rule: empty center starts with the room start minimum."],
    chat: [{ name: "Table", value: `Room ${roomId} created.` }],
  };
  rooms.set(roomId, room);
  attach(socket, room, player);
  send(socket, { type: "created", roomId, playerId: player.id, reconnectToken: player.reconnectToken });
  broadcast(room);
}

function joinRoom(socket, roomId, name, avatarIndex, reconnectToken, appVersion, appBuild) {
  const room = rooms.get(String(roomId || "").trim().toUpperCase());
  if (!room) {
    return send(socket, {
      type: "error",
      code: "ROOM_NOT_FOUND",
      message: "Room not found. Check the 6-digit code, paste the latest invite, or create a new room.",
    });
  }
  const requestedName = cleanName(name, "Player");
  if (room.gameType === 'trump' && room.started && !room.winner && !(Number.isSafeInteger(appBuild) && appBuild >= 103)) return send(socket, { type: 'error', message: 'Install Jhoota build 103 or newer to rejoin this Trump game.' });
  const returning = room.players.find((player) => !player.isBot && player.reconnectToken && player.reconnectToken === reconnectToken)
    || room.players.find((player) => !player.isBot && !player.connected && samePlayerName(player.name, requestedName));
  if (returning) {
    returning.name = uniquePlayerName(room, cleanName(name, returning.name), returning.id);
    returning.appVersion = cleanVersion(appVersion);
    returning.appBuild = Number.isSafeInteger(appBuild) ? appBuild : 0;
    returning.avatarIndex = cleanAvatarIndex(avatarIndex, returning.name);
    if (!room.started || room.winner) returning.ready = false;
    if (returning.socket?.readyState === 1 && returning.socket !== socket) {
      returning.socket.roomId = null;
      returning.socket.playerId = null;
      returning.socket.close(1000, "reconnected elsewhere");
    }
    attach(socket, room, returning);
    room.log.push(`${returning.name} reconnected.`);
    send(socket, { type: "joined", roomId: room.id, playerId: returning.id, reconnectToken: returning.reconnectToken });
    return broadcast(room);
  }
  if (room.started) {
    return send(socket, {
      type: "error",
      message: "Game already started. If this is your seat, enter the same name you used before. Otherwise ask the host to use Bot Offline or Restart Round.",
    });
  }
  if (room.players.length >= 8) return send(socket, { type: "error", message: "Room is full." });
  const player = makePlayer(
    uniquePlayerName(room, requestedName || `Player ${room.players.length + 1}`),
    false,
    appVersion,
    avatarIndex,
  );
  player.ready = false;
  player.appBuild = Number.isSafeInteger(appBuild) ? appBuild : 0;
  if (room.gameType === "trump") player.team = nextTrumpTeam(room);
  room.players.push(player);
  room.log.push(`${player.name} joined.`);
  attach(socket, room, player);
  send(socket, { type: "joined", roomId: room.id, playerId: player.id, reconnectToken: player.reconnectToken });
  broadcast(room);
}

function addBot(room, playerId, difficulty) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can add bots.");
  if (room.started && (room.gameType !== "trump" || !room.winner)) return sendToPlayer(room, playerId, "Bots can only be added before the round starts.");
  if (room.players.length >= 8) return sendToPlayer(room, playerId, "Room is full.");
  const bot = addBotSeat(room, difficulty);
  room.log.push(`${bot.name} (${bot.difficulty}) joined.`);
  broadcast(room);
}

function fillBots(room, playerId, target, difficulty) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can fill bot seats.");
  if (room.started && (room.gameType !== "trump" || !room.winner)) return sendToPlayer(room, playerId, "Bots can only be filled before the round starts.");
  const targetCount = Math.max(2, Math.min(8, Number.isInteger(Number(target)) ? Number(target) : 4));
  if (room.players.length >= targetCount) return sendToPlayer(room, playerId, `Room already has ${targetCount} seat(s).`);
  const before = room.players.length;
  const added = [];
  while (room.players.length < targetCount && room.players.length < 8) {
    added.push(addBotSeat(room, difficulty));
  }
  room.log.push(`Host filled room from ${before} to ${room.players.length} seats with ${botLevel(difficulty)} bot(s).`);
  if (added.length === 0) return sendToPlayer(room, playerId, "Room is full.");
  broadcast(room);
}

function addBotSeat(room, difficulty) {
  const level = botLevel(difficulty);
  const botNumber = room.players.filter((player) => player.isBot).length + 1;
  const bot = makePlayer(
    uniquePlayerName(room, `${level} Bot ${botNumber}`),
    false,
    "",
    7,
  );
  bot.isBot = true;
  bot.difficulty = level;
  bot.connected = true;
  bot.ready = true;
  if (room.gameType === "trump") bot.team = nextTrumpTeam(room);
  room.players.push(bot);
  return bot;
}

function botLevel(difficulty) {
  return ["Low", "Medium", "Pro"].includes(difficulty) ? difficulty : "Low";
}

function nextTrumpTeam(room) {
  return room.players.filter(p => p.team === 0).length <= room.players.filter(p => p.team === 1).length ? 0 : 1;
}

function changeTrumpTeams(room, playerId, message) {
  if (room.gameType !== "trump") return sendToPlayer(room, playerId, "Teams are only used in Trump.");
  if (room.started && !room.winner) return sendToPlayer(room, playerId, "Teams are locked during a game.");
  if (message.type === "shuffleTeams") {
    if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can shuffle teams.");
    shuffle([...room.players]).forEach((p, i) => { p.team = i % 2; });
    room.log.push("Host shuffled the teams for the next game.");
  } else {
    const team = Number(message.team);
    if (![0, 1].includes(team)) return sendToPlayer(room, playerId, "Choose Team A or Team B.");
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    // Temporary unequal sides let a full room exchange teammates; start still requires equal teams.
    player.team = team;
    room.log.push(`${player.name} joined Team ${team === 0 ? 'A' : 'B'}.`);
  }
  room.players.forEach(p => { if (!p.isBot) p.ready = false; });
  room.teamsChanged = true;
  broadcast(room);
}

function trumpTeamsEqual(room) {
  return room.players.filter(p => p.team === 0).length === room.players.filter(p => p.team === 1).length;
}

function clearBots(room, playerId) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can clear bots.");
  if (room.started) return sendToPlayer(room, playerId, "Bots can only be cleared before the round starts.");
  const before = room.players.length;
  room.players = room.players.filter((player) => !player.isBot);
  const removed = before - room.players.length;
  room.log.push(`Host cleared ${removed} bot(s).`);
  broadcast(room);
}

function setBotSpeed(room, playerId, speed) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can change bot speed.");
  const speeds = { Slow: 1200, Normal: 650, Fast: 250 };
  if (!Object.prototype.hasOwnProperty.call(speeds, speed)) return sendToPlayer(room, playerId, "Choose Slow, Normal, or Fast bot speed.");
  room.botSpeedMs = speeds[speed];
  room.log.push(`Bot speed set to ${speed}.`);
  broadcast(room);
}

function setOpeningCards(room, playerId, count) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can change start minimum.");
  if (room.started && !room.winner) return sendToPlayer(room, playerId, "Start minimum can only be changed before the round starts.");
  const value = Number(count);
  if (!Number.isInteger(value) || value < 1 || value > 4) return sendToPlayer(room, playerId, "Start minimum must be 1 to 4.");
  room.minimumOpeningCards = value;
  room.log.push(`Start minimum set to ${value}.`);
  broadcast(room);
}

function setReady(room, playerId, ready) {
  if (room.started && !room.winner) return sendToPlayer(room, playerId, "Round is already running.");
  const player = room.players.find((item) => item.id === playerId);
  if (!player || player.isBot) return;
  player.ready = Boolean(ready);
  room.log.push(`${player.name} is ${player.ready ? "ready" : "not ready"}.`);
  broadcast(room);
}

function claimHost(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  const currentHost = room.players.find((item) => item.id === room.hostId);
  if (!player || player.isBot) return;
  if (currentHost && currentHost.connected) return sendToPlayer(room, playerId, "Current host is still connected.");
  room.hostId = playerId;
  room.log.push(`${player.name} claimed host.`);
  broadcast(room);
}

function kickOffline(room, playerId) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can kick offline seats.");
  if (room.started && !room.winner) return sendToPlayer(room, playerId, "Offline seats can only be removed before the round starts.");
  const before = room.players.length;
  room.players = room.players.filter((player) => player.isBot || player.connected || player.id === room.hostId);
  const removed = before - room.players.length;
  room.log.push(`Host removed ${removed} offline seat(s).`);
  broadcast(room);
}

function replaceOfflineWithBot(room, playerId) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can replace offline seats.");
  const offlineHumans = room.players.filter((player) => !player.isBot && !player.connected && player.id !== room.hostId);
  if (offlineHumans.length === 0) return sendToPlayer(room, playerId, "No offline player seats to replace.");
  for (const player of offlineHumans) {
    player.name = `${player.name} Bot`;
    player.isBot = true;
    player.avatarIndex = 7;
    player.difficulty = "Low";
    player.connected = true;
    player.ready = true;
    player.socket = null;
    player.appVersion = "";
  }
  room.log.push(`Host replaced ${offlineHumans.length} offline seat(s) with bots.`);
  broadcast(room);
  runBots(room);
}

function skipOfflineTurn(room, playerId) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can skip offline turns.");
  if (!room.started || room.winner) return sendToPlayer(room, playerId, "No running round to skip.");
  if (room.gameType === "trump") return sendToPlayer(room, playerId, "Trump seats cannot skip a hand. Replace the offline seat with a bot or wait for reconnection.");
  const current = currentPlayer(room);
  if (!current || current.connected || current.isBot) return sendToPlayer(room, playerId, "Current player is not offline.");
  room.log.push(`Host skipped ${current.name}'s offline turn.`);
  nextTurn(room);
  advancePastOfflinePlayers(room);
  broadcast(room);
  runBots(room);
}

function restartRound(room, playerId) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can restart the round.");
  if (!room.started || room.winner) return sendToPlayer(room, playerId, "Use Start Game for a new round.");
  return startGame(room, playerId, true);
}

function startGame(room, playerId, forceRestart = false) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can start the game.");
  if (room.players.length < 2 || room.players.length > 8) return sendToPlayer(room, playerId, "Need 2 to 8 players.");
  if (room.gameType === "trump" && trumpSeatError(room.players.length)) return sendToPlayer(room, playerId, trumpSeatError(room.players.length));
  if (room.gameType === "trump" && !trumpTeamsEqual(room)) return sendToPlayer(room, playerId, "Choose equal teams before starting.");
  if (room.started && !room.winner && !forceRestart) return sendToPlayer(room, playerId, "Round is already running.");
  const versions = humanVersionSet(room);
  const unsupportedVersions = unsupportedHumanVersions(versions);
  if (versions.length > 1) return sendToPlayer(room, playerId, `All players must install the same APK version before start. Found: ${versions.join(" / ")}`);
  if (unsupportedVersions.length > 0) return sendToPlayer(room, playerId, `Install the latest APK v${SERVER_BUILD} before start. Found: ${unsupportedVersions.join(" / ")}`);
  if (outdatedTrumpClients(room)) return sendToPlayer(room, playerId, 'Every phone needs Jhoota build 103 or newer for the balanced Trump rules.');
  let readiness = roomReadiness(room);
  const canHostAutoReady = !room.winner && hostCanAutoReady(room, playerId);
  if (!forceRestart && !readiness.allReady && canHostAutoReady) {
    const host = room.players.find((player) => player.id === playerId);
    if (host) {
      host.ready = true;
      room.log.push(`${host.name} is ready.`);
    }
    readiness = roomReadiness(room);
  }
  if (!forceRestart && !readiness.allReady) {
    const reason = room.winner ? "All connected human players must ready up again before rematch." : "All connected human players must be ready before start.";
    return sendToPlayer(room, playerId, reason);
  }
  room.started = true;
  room.roundNumber = (room.roundNumber || 0) + 1;
  room.matchId = `${room.id}-${Date.now()}-${room.roundNumber}`;
  room.matchPlayerIds = room.players.map(p => p.id);
  room.turnExtensions = [];
  room.winner = null;
  room.winnerId = null;
  room.activeRank = null;
  room.centerPile = [];
  room.lastPlayedMove = null;
  room.pendingWinnerId = null;
  room.lastBluffResult = "";
  room.winnerReason = "";
  room.consecutivePasses = 0;
  room.currentIndex = Math.floor(Math.random() * room.players.length);
  for (const player of room.players) player.hand = [];
  if (room.gameType === "trump") {
    beginTrump(room);
    for (const player of room.players) if (!player.isBot) player.ready = false;
    broadcast(room);
    return runBots(room);
  }
  const deck = shuffle(makeDeck());
  deck.forEach((card, index) => room.players[index % room.players.length].hand.push(card));
  for (const player of room.players) player.hand.sort(sortCard);
  for (const player of room.players) {
    if (!player.isBot) player.ready = false;
  }
  room.log.push(forceRestart ? "Host restarted the round. Cards were shuffled and dealt." : "New round started. Cards were shuffled and dealt.");
  room.log.push(`${currentPlayer(room).name} gets the first turn.`);
  broadcast(room);
  runBots(room);
}

function play(room, playerId, cards, rank) {
  if (room.winner) return sendToPlayer(room, playerId, "Round is already over.");
  if (!isTurn(room, playerId)) return sendToPlayer(room, playerId, "It is not your turn.");
  if (room.pendingWinnerId && room.pendingWinnerId !== playerId) {
    const pending = room.players.find((item) => item.id === room.pendingWinnerId);
    awardWin(room, pending, "Last play survived.");
    room.log.push(`${room.winner}'s last play survived and they win!`);
    return broadcast(room);
  }
  const player = currentPlayer(room);
  const chosen = uniqueCards(cards).filter((card) => player.hand.includes(card));
  if (chosen.length === 0) return sendToPlayer(room, playerId, "Choose cards from your hand.");
  if (!room.activeRank) {
    if (!RANKS.includes(rank)) return sendToPlayer(room, playerId, "Choose a valid rank.");
    if (player.hand.length === 1) {
      room.log.push(`${player.name} has one card and cannot start a fresh claim.`);
      sendToPlayer(room, playerId, "With one card left, you cannot call a fresh rank. Play only after someone else starts a rank.");
      return broadcast(room);
    }
    const requiredOpeningCards = Math.min(room.minimumOpeningCards, player.hand.length);
    if (chosen.length < requiredOpeningCards) {
      room.log.push(`${player.name} must play at least ${requiredOpeningCards} card(s) to start an empty center.`);
      sendToPlayer(room, playerId, `Play at least ${requiredOpeningCards} card(s) to start.`);
      return broadcast(room);
    }
    room.activeRank = rank;
  }
  for (const card of chosen) player.hand.splice(player.hand.indexOf(card), 1);
  room.centerPile.push(...chosen);
  room.lastPlayedMove = { playerId, claimedRank: room.activeRank, cards: chosen };
  room.lastBluffResult = "";
  room.consecutivePasses = 0;
  room.log.push(`${player.name} played ${chosen.length} card(s) as ${room.activeRank}.`);
  if (player.hand.length === 0) {
    room.pendingWinnerId = player.id;
    room.log.push(`${player.name} has no cards left. Challenge now or they may win.`);
  }
  nextTurn(room);
  broadcast(room);
  runBots(room);
}

function pass(room, playerId) {
  if (room.winner) return sendToPlayer(room, playerId, "Round is already over.");
  if (!isTurn(room, playerId)) return sendToPlayer(room, playerId, "It is not your turn.");
  if (room.pendingWinnerId && room.pendingWinnerId !== playerId) {
    const pending = room.players.find((item) => item.id === room.pendingWinnerId);
    awardWin(room, pending, "Final play was passed.");
    room.log.push(`${room.winner}'s last play survived the pass and they win!`);
    return broadcast(room);
  }
  const player = currentPlayer(room);
  room.consecutivePasses += 1;
  room.lastBluffResult = "";
  room.log.push(`${player.name} passed.`);
  if (room.activeRank && room.consecutivePasses >= room.players.length) {
    const removed = room.centerPile.length;
    room.centerPile = [];
    room.lastPlayedMove = null;
    room.activeRank = null;
    room.consecutivePasses = 0;
    room.log.push(`Everyone passed. ${removed} center card(s) were removed.`);
    if (room.pendingWinnerId) {
      const pending = room.players.find((item) => item.id === room.pendingWinnerId);
      awardWin(room, pending, "Final play was not challenged.");
      room.log.push(`${room.winner}'s final play was not challenged and they win!`);
      return broadcast(room);
    }
  }
  nextTurn(room);
  broadcast(room);
  runBots(room);
}

function bluff(room, playerId) {
  if (room.winner) return sendToPlayer(room, playerId, "Round is already over.");
  if (!isTurn(room, playerId)) return sendToPlayer(room, playerId, "It is not your turn.");
  if (!room.lastPlayedMove) return sendToPlayer(room, playerId, "There is no move to challenge.");
  const caller = currentPlayer(room);
  const callerIndex = room.currentIndex;
  const accused = room.players.find((player) => player.id === room.lastPlayedMove.playerId);
  const accusedIndex = room.players.findIndex((player) => player.id === room.lastPlayedMove.playerId);
  const honest = room.lastPlayedMove.cards.every((card) => rankOf(card) === room.lastPlayedMove.claimedRank);
  if (honest) {
    caller.hand.push(...room.centerPile);
    caller.hand.sort(sortCard);
    room.lastBluffResult = `${caller.name} was wrong. ${accused.name} was honest.`;
    room.log.push(`${caller.name} called bluff, but ${accused.name} was honest. ${caller.name} picked up the pile.`);
    if (room.pendingWinnerId === room.lastPlayedMove.playerId) {
      awardWin(room, accused, "Final play was honest.");
      room.log.push(`${accused.name}'s final play was honest and they win!`);
    }
  } else {
    accused.hand.push(...room.centerPile);
    accused.hand.sort(sortCard);
    room.lastBluffResult = `${caller.name} caught ${accused.name}.`;
    room.log.push(`${caller.name} caught ${accused.name} bluffing. ${accused.name} picked up the pile.`);
    if (room.pendingWinnerId === room.lastPlayedMove.playerId) {
      room.pendingWinnerId = null;
    }
  }
  room.centerPile = [];
  room.activeRank = null;
  room.lastPlayedMove = null;
  room.consecutivePasses = 0;
  if (room.winner) return broadcast(room);
  room.currentIndex = honest && accusedIndex >= 0 ? accusedIndex : callerIndex;
  room.log.push(`${currentPlayer(room).name} calls the next rank.`);
  broadcast(room);
  runBots(room);
}

function sticker(room, playerId, value) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return;
  const sticker = String(value).slice(0, 30);
  room.log.push(`${player.name} sent sticker: ${sticker}`);
  room.chat.push({ name: player.name, value: sticker });
  room.chat = room.chat.slice(-20);
  broadcast(room);
}

function chat(room, playerId, value) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return;
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!text) return sendToPlayer(room, playerId, "Enter a message first.");
  room.chat.push({ name: player.name, value: text });
  room.chat = room.chat.slice(-20);
  room.log.push(`${player.name} chatted.`);
  broadcast(room);
}

function voice(room, playerId, data, requestedDurationMs) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player || player.isBot || !player.connected) return;
  const audio = String(data || "").trim();
  if (!audio || audio.length > MAX_VOICE_BASE64_CHARS || audio.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
    return sendToPlayer(room, playerId, "Voice clip was invalid or too large. Record a new clip under 6 seconds.");
  }
  const padding = audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor(audio.length * 3 / 4) - padding;
  if (decodedBytes < 8 || decodedBytes > MAX_VOICE_AUDIO_BYTES) {
    return sendToPlayer(room, playerId, "Voice clip was invalid or too large. Record a new clip under 6 seconds.");
  }
  const now = Date.now();
  if (player.lastVoiceAt && now - player.lastVoiceAt < 900) {
    return sendToPlayer(room, playerId, "Wait a moment before sending another voice clip.");
  }
  player.lastVoiceAt = now;
  const durationMs = Math.max(400, Math.min(MAX_VOICE_DURATION_MS, Math.round(Number(requestedDurationMs) || 1000)));
  const voiceMessage = {
    type: "voice",
    senderId: player.id,
    name: player.name,
    mime: "audio/mp4",
    durationMs,
    data: audio,
  };
  for (const recipient of room.players) {
    if (recipient.id !== player.id && recipient.socket?.readyState === 1) {
      send(recipient.socket, voiceMessage);
    }
  }
  if (player.socket?.readyState === 1) {
    send(player.socket, { type: "voiceSent", durationMs });
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  room.chat.push({ name: player.name, value: `Voice clip (${seconds}s)` });
  room.chat = room.chat.slice(-20);
  room.log.push(`${player.name} sent a voice clip.`);
  broadcast(room);
}

function leaveRoom(room, socket) {
  const playerId = socket.playerId;
  const player = room.players.find((item) => item.id === playerId);
  if (!player || player.isBot) return;
  player.connected = false;
  if (player.socket === socket) player.socket = null;
  socket.roomId = null;
  socket.playerId = null;
  room.log.push(`${player.name} left the room.`);
  if (room.hostId === playerId) {
    const nextHost = room.players.find((item) => !item.isBot && item.connected);
    if (nextHost) {
      room.hostId = nextHost.id;
      room.log.push(`${nextHost.name} is now host.`);
    }
  }
  broadcast(room);
}

function endRoom(room, playerId) {
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only the host can end the room.");
  clearTimeout(room.botTimer);
  for (const player of room.players) {
    if (player.socket?.readyState === 1) {
      send(player.socket, { type: "roomEnded", message: "Host ended the room." });
      player.socket.roomId = null;
      player.socket.playerId = null;
    }
  }
  rooms.delete(room.id);
}

function testSetup(room, playerId, message) {
  if (!TEST_COMMANDS) return sendToPlayer(room, playerId, "Test commands are disabled.");
  if (room.hostId !== playerId) return sendToPlayer(room, playerId, "Only host can use test setup.");
  if (!Array.isArray(message.hands) || message.hands.length !== room.players.length) {
    return sendToPlayer(room, playerId, "Test setup needs one hand per player.");
  }
  const seen = new Set();
  const hands = message.hands.map((hand) => {
    if (!Array.isArray(hand)) return null;
    return hand.map((card) => String(card).trim().toUpperCase()).filter(Boolean);
  });
  if (hands.some((hand) => !hand)) return sendToPlayer(room, playerId, "Invalid test hands.");
  for (const hand of hands) {
    for (const card of hand) {
      if (!isValidCard(card) || seen.has(card)) return sendToPlayer(room, playerId, "Invalid or duplicate test card.");
      seen.add(card);
    }
  }
  room.started = true;
  room.roundNumber = (room.roundNumber || 0) + 1;
  room.winner = null;
  room.winnerId = null;
  room.activeRank = message.activeRank && RANKS.includes(message.activeRank) ? message.activeRank : null;
  room.centerPile = [];
  room.lastPlayedMove = null;
  room.pendingWinnerId = null;
  room.lastBluffResult = "";
  room.winnerReason = "";
  room.consecutivePasses = 0;
  const currentIndex = Number(message.currentIndex);
  room.currentIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < room.players.length ? currentIndex : 0;
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].hand = hands[i].sort(sortCard);
  }
  room.log.push("Test setup loaded.");
  broadcast(room);
}

function broadcast(room) {
  room.updatedAt = Date.now();
  if (room.gameType !== 'trump') syncBluffDeadline(room, room.updatedAt);
  for (const player of room.players) {
    if (player.socket?.readyState === 1) {
      send(player.socket, { type: "state", state: stateFor(room, player) });
    }
  }
}

function syncBluffDeadline(room, now) {
  if (!room.started || room.winner) { room.turnDeadline = 0; room.turnKey = ''; return; }
  const key = [room.roundNumber, room.currentIndex, room.activeRank, room.centerPile.length,
    currentPlayer(room).hand.length, room.consecutivePasses, room.lastBluffResult].join('|');
  if (key !== room.turnKey) { room.turnKey = key; room.turnDeadline = now + TURN_MS; }
}

function stateFor(room, viewer) {
  const pendingWinner = room.players.find((player) => player.id === room.pendingWinnerId);
  const lastMovePlayer = room.players.find((player) => player.id === room.lastPlayedMove?.playerId);
  const scoreLeader = [...room.players].sort((a, b) => (b.wins || 0) - (a.wins || 0))[0];
  const connectedCount = room.players.filter((player) => player.connected).length;
  const offlineHumans = room.players.filter((player) => !player.isBot && !player.connected);
  const unreadyHumans = room.players.filter((player) => !player.isBot && player.connected && !player.ready);
  const offlineHumanCount = offlineHumans.length;
  const totalKnownCards = room.centerPile.length + room.players.reduce((total, player) => total + player.hand.length, 0);
  const readiness = roomReadiness(room);
  const humanVersions = humanVersionSet(room);
  const unsupportedVersions = unsupportedHumanVersions(humanVersions);
  const versionMismatch = humanVersions.length > 1 || unsupportedVersions.length > 0;
  const canStart = room.hostId === viewer.id && (!room.started || Boolean(room.winner)) && room.players.length >= 2
    && (room.gameType !== "trump" || !trumpSeatError(room.players.length))
    && (room.gameType !== "trump" || trumpTeamsEqual(room))
    && !outdatedTrumpClients(room)
    && !versionMismatch
    && (readiness.allReady || (!room.winner && hostCanAutoReady(room, viewer.id)));
  return {
    roomId: room.id,
    gameType: room.gameType,
    playerId: viewer.id,
    hostId: room.hostId,
    started: room.started,
    activeRank: room.activeRank,
    minimumOpeningCards: room.minimumOpeningCards,
    phase: room.winner ? "Round over" : room.started ? "Playing" : "Lobby",
    botSpeedMs: room.botSpeedMs || 650,
    turnDeadline: room.turnDeadline || 0, serverTime: Date.now(), turnDurationMs: TURN_MS,
    turnDirection: 'anticlockwise',
    extensionUsed: room.turnExtensions.includes(viewer.id),
    canExtendTurn: Boolean(room.started && !room.winner && currentPlayer(room).id === viewer.id && !viewer.isBot && room.turnDeadline > Date.now() && !room.turnExtensions.includes(viewer.id)),
    deckOk: totalKnownCards === 52,
    roundNumber: room.roundNumber || 0,
    matchId: room.matchId || '',
    matchPlayerIds: room.matchPlayerIds || [],
    playerCount: room.players.length,
    connectedCount,
    offlineHumanCount,
    offlineHumanNames: offlineHumans.map((player) => player.name).join(", "),
    unreadyHumanNames: unreadyHumans.map((player) => player.name).join(", "),
    humanCount: readiness.humanCount,
    readyCount: readiness.readyCount,
    allReady: readiness.allReady,
    maxPlayers: 8,
    voiceClips: true,
    liveCalls: liveCallConfigured(),
    maxVoiceDurationMs: MAX_VOICE_DURATION_MS,
    totalKnownCards,
    serverProtocol: SERVER_PROTOCOL,
    serverBuild: SERVER_BUILD,
    rulesRevision: 103,
    versionMismatch,
    versionWarning: versionMismatch ? humanVersions.join(" / ") : "",
    serverVersionMismatch: unsupportedVersions.length > 0,
    currentPlayerId: room.started && !room.winner ? currentPlayer(room).id : "",
    currentPlayerName: room.started && !room.winner ? currentPlayer(room).name : "",
    currentPlayerConnected: room.started && !room.winner ? currentPlayer(room).connected : true,
    centerCount: room.centerPile.length,
    pendingWinnerId: room.pendingWinnerId || "",
    pendingWinnerName: pendingWinner?.name || "",
    lastBluffResult: room.lastBluffResult || "",
    winnerReason: room.winnerReason || "",
    lastMovePlayerName: lastMovePlayer?.name || "",
    lastMoveRank: room.lastPlayedMove?.claimedRank || "",
    lastMoveCount: room.lastPlayedMove?.cards.length || 0,
    canBluff: Boolean(room.started && !room.winner && room.lastPlayedMove),
    canStart,
    startBlockReason: startBlockReasonFor(room, viewer, readiness, humanVersions, versionMismatch, offlineHumans, unreadyHumans, canStart),
    winner: room.winner || "",
    winnerId: room.winnerId || "",
    scoreLeaderName: scoreLeader?.name || "",
    scoreLeaderWins: scoreLeader?.wins || 0,
    scoreSummary: room.players
      .map((player) => `${player.name}: ${player.wins || 0}`)
      .join(" | "),
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatarIndex: player.avatarIndex,
      cardCount: player.hand.length,
      connected: player.connected,
      isBot: Boolean(player.isBot),
      difficulty: player.difficulty || "",
      appVersion: player.isBot ? "" : player.appVersion || "old",
      appBuild: player.appBuild || 0,
      wins: player.wins || 0,
      ready: Boolean(player.ready || player.isBot),
      team: room.gameType === "trump" ? player.team : null,
    })),
    hand: viewer.hand,
    log: room.log.slice(-14),
    chat: (room.chat || []).slice(-12),
    latestEvent: room.log.at(-1) || "",
    ...(room.gameType === "trump" ? { ...trumpPublicState(room, viewer), canBluff: false } : {}),
  };
}

function startBlockReasonFor(room, viewer, readiness, humanVersions, versionMismatch, offlineHumans, unreadyHumans, canStart) {
  if (canStart) return room.winner ? "Ready for rematch. Host can tap Play Again." : "Ready. Host can tap Start Game.";
  if (room.hostId !== viewer.id) {
    const host = room.players.find((player) => player.id === room.hostId);
    return `Waiting for host${host?.name ? ` ${host.name}` : ""}.`;
  }
  if (room.started && !room.winner) return "Round is already running.";
  if (room.players.length < 2) return "Need at least 2 players or bots.";
  if (room.gameType === "trump" && trumpSeatError(room.players.length)) return trumpSeatError(room.players.length);
  if (room.gameType === "trump" && !trumpTeamsEqual(room)) return "Choose equal Team A and Team B seats before starting.";
  const unsupportedVersions = unsupportedHumanVersions(humanVersions);
  if (humanVersions.length > 1) return `All phones need the same APK version. Found: ${humanVersions.join(" / ")}. Install the latest APK, then use Check Room.`;
  if (unsupportedVersions.length > 0) return `This server needs APK v${SERVER_BUILD}. Found: ${unsupportedVersions.join(" / ")}. Install the latest APK, then use Check Room.`;
  if (outdatedTrumpClients(room)) return 'Every phone needs Jhoota build 103 or newer for the balanced Trump rules.';
  if (offlineHumans.length > 0) {
    return `Offline seat blocking start: ${offlineHumans.map((player) => player.name).join(", ")}. Host can Kick Offline or Bot Offline, then Check Room.`;
  }
  if (!readiness.allReady && unreadyHumans.length > 0) {
    return `Waiting for ready: ${unreadyHumans.map((player) => player.name).join(", ")}.`;
  }
  if (!readiness.allReady) return room.winner ? "Everyone must ready up again before rematch." : "All human players must ready up.";
  return "Host checklist is not complete.";
}

function attach(socket, room, player) {
  socket.roomId = room.id;
  socket.playerId = player.id;
  player.socket = socket;
  player.connected = true;
}

function roomReadiness(room) {
  const humans = room.players.filter((player) => !player.isBot);
  const readyHumans = humans.filter((player) => player.connected && player.ready);
  return {
    humanCount: humans.length,
    readyCount: readyHumans.length,
    allReady: humans.length > 0 && readyHumans.length === humans.length,
  };
}

function outdatedTrumpClients(room) {
  return room.gameType === 'trump' && room.players.some(p => !p.isBot && !(p.appBuild >= 103));
}

function humanVersionSet(room) {
  return [...new Set(room.players
    .filter((player) => !player.isBot)
    .map((player) => player.appVersion || "old")
    .filter(Boolean))];
}

function unsupportedHumanVersions(humanVersions) {
  return humanVersions.filter((version) => version !== SERVER_BUILD);
}

function hostCanAutoReady(room, playerId) {
  return room.players.every((player) => {
    if (player.isBot) return true;
    if (player.id === playerId) return player.connected;
    return player.connected && player.ready;
  });
}

function currentPlayer(room) {
  return room.players[room.currentIndex];
}

function runBots(room) {
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => {
    if (!room.started || room.winner) return;
    if (!room.players.some(p => !p.isBot && p.connected)) return;
    const bot = currentPlayer(room);
    if (!bot?.isBot) return;
    if (room.gameType === "trump") {
      if (!['choose', 'play'].includes(room.trump.phase)) return;
      const error = room.trump.phase === "choose"
        ? chooseTrump(room, bot.id, chooseBotTrump(bot))
        : playTrump(room, bot.id, [chooseBotTrumpCard(room, bot)]);
      if (!error) { broadcast(room); runBots(room); }
      return;
    }
    takeBotTurn(room, bot);
  }, room.botSpeedMs || 650);
}

function takeBotTurn(room, bot) {
  if (room.lastPlayedMove && shouldBotCallBluff(room, bot)) {
    return bluff(room, bot.id);
  }
  if (room.activeRank && shouldBotPass(room, bot)) {
    return pass(room, bot.id);
  }
  if (!room.activeRank && bot.hand.length === 1) {
    return pass(room, bot.id);
  }
  const rank = room.activeRank || chooseBotRank(bot);
  const cards = chooseBotCards(room, bot, rank);
  if (cards.length === 0) return pass(room, bot.id);
  play(room, bot.id, cards, rank);
}

function shouldBotCallBluff(room, bot) {
  if (!room.lastPlayedMove) return false;
  const count = room.lastPlayedMove.cards.length;
  const claimedRank = room.lastPlayedMove.claimedRank;
  const ownClaimedRank = cardsOfRank(bot, claimedRank).length;
  const impossibleClaim = ownClaimedRank + count > 4;
  const finalClaim = room.pendingWinnerId === room.lastPlayedMove.playerId;
  if (bot.difficulty === "Pro" && impossibleClaim) return true;
  let chance = bot.difficulty === "Pro" ? 18 : bot.difficulty === "Medium" ? 11 : 6;
  if (count >= 3) chance += bot.difficulty === "Pro" ? 36 : bot.difficulty === "Medium" ? 24 : 8;
  if (impossibleClaim) chance += bot.difficulty === "Pro" ? 65 : bot.difficulty === "Medium" ? 45 : 16;
  if (ownClaimedRank >= 3 && count >= 2) chance += bot.difficulty === "Pro" ? 26 : bot.difficulty === "Medium" ? 16 : 4;
  if (finalClaim) chance += bot.difficulty === "Pro" ? 24 : bot.difficulty === "Medium" ? 16 : 8;
  if (bot.hand.length <= 2) chance -= 6;
  return Math.random() * 100 < chance;
}

function shouldBotPass(room, bot) {
  if (cardsOfRank(bot, room.activeRank).length > 0) return false;
  let chance = bot.difficulty === "Pro" ? 52 : bot.difficulty === "Medium" ? 34 : 16;
  if (room.centerPile.length >= 6) chance += bot.difficulty === "Pro" ? 14 : bot.difficulty === "Medium" ? 8 : 0;
  if (bot.hand.length <= 2) chance += 10;
  return Math.random() * 100 < chance;
}

function chooseBotRank(bot) {
  let bestRanks = [];
  let bestCount = -1;
  for (const rank of RANKS) {
    const count = cardsOfRank(bot, rank).length;
    if (count > bestCount) {
      bestRanks = [rank];
      bestCount = count;
    } else if (count === bestCount) {
      bestRanks.push(rank);
    }
  }
  if (bot.difficulty === "Low" && Math.random() < 0.45) {
    return RANKS[Math.floor(Math.random() * RANKS.length)];
  }
  if (bot.difficulty === "Medium" && Math.random() < 0.18) {
    return RANKS[Math.floor(Math.random() * RANKS.length)];
  }
  return bestRanks[Math.floor(Math.random() * bestRanks.length)];
}

function chooseBotCards(room, bot, rank) {
  const matching = cardsOfRank(bot, rank);
  if (!room.activeRank && bot.hand.length === 1) return [];
  const minimum = room.activeRank ? 1 : Math.min(room.minimumOpeningCards, bot.hand.length);
  if (matching.length >= minimum) {
    const max = Math.min(bot.difficulty === "Pro" ? 3 : 2, matching.length);
    let count = room.activeRank ? 1 : minimum;
    if (room.activeRank && matching.length > 1) {
      const extraChance = bot.difficulty === "Pro" ? 46 : bot.difficulty === "Medium" ? 28 : 14;
      if (Math.random() * 100 < extraChance) count = 1 + Math.floor(Math.random() * max);
    } else if (!room.activeRank && bot.difficulty === "Pro" && matching.length > minimum && Math.random() < 0.35) {
      count = Math.min(matching.length, minimum + 1);
    }
    return matching.slice(0, Math.min(count, matching.length));
  }
  const bluffChance = bot.difficulty === "Pro" ? 42 : bot.difficulty === "Medium" ? 66 : 86;
  if (Math.random() * 100 >= bluffChance) return [];
  if (bot.hand.length < minimum) return [];
  return chooseBluffCards(bot, rank, minimum);
}

function cardsOfRank(player, rank) {
  return player.hand.filter((card) => rankOf(card) === rank);
}

function chooseBluffCards(bot, claimedRank, minimum) {
  const nonMatching = bot.hand.filter((card) => rankOf(card) !== claimedRank);
  if (nonMatching.length < minimum) return [];
  const grouped = [...nonMatching].sort((a, b) => {
    const countDiff = cardsOfRank(bot, rankOf(a)).length - cardsOfRank(bot, rankOf(b)).length;
    return countDiff || sortCard(a, b);
  });
  if (bot.difficulty === "Low") return grouped.slice(0, minimum);
  if (bot.difficulty === "Medium") return grouped.slice(0, minimum);
  const safestRank = rankOf(grouped[0]);
  const safestGroup = grouped.filter((card) => rankOf(card) === safestRank);
  return (safestGroup.length >= minimum ? safestGroup : grouped).slice(0, minimum);
}

function isTurn(room, playerId) {
  return room.started && currentPlayer(room).id === playerId;
}

function nextTurn(room) {
  room.currentIndex = (room.currentIndex + 1) % room.players.length;
}

function advancePastOfflinePlayers(room) {
  for (let i = 0; i < room.players.length; i++) {
    const player = currentPlayer(room);
    if (player?.isBot || player?.connected) return;
    room.currentIndex = (room.currentIndex + 1) % room.players.length;
  }
}

function makeDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit}`));
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function makeRoomId() {
  let id;
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(id));
  return id;
}

function makePlayer(name, host, appVersion, avatarIndex) {
  const cleanPlayerName = cleanName(name, host ? "Host" : "Player");
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    reconnectToken: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`,
    name: cleanPlayerName,
    avatarIndex: cleanAvatarIndex(avatarIndex, cleanPlayerName),
    appVersion: cleanVersion(appVersion),
    hand: [],
    wins: 0,
    ready: false,
    isBot: false,
    difficulty: "",
    connected: true,
    socket: null,
  };
}

function awardWin(room, player, reason) {
  if (room.winner) return;
  const winner = player || null;
  if (winner) {
    winner.wins = (winner.wins || 0) + 1;
    room.winner = winner.name;
    room.winnerId = winner.id;
  } else {
    room.winner = "Winner";
    room.winnerId = null;
  }
  room.winnerReason = reason;
}

function cleanVersion(value) {
  const version = String(value || "old").trim();
  if (!version) return "old";
  return version.slice(0, 16);
}

function serverStats() {
  return {
    rooms: rooms.size,
    players: [...rooms.values()].reduce((total, room) => total + room.players.length, 0),
    connected: [...rooms.values()].reduce((total, room) => total + room.players.filter((player) => player.connected).length, 0),
  };
}

function roomSummary(room) {
  const readiness = roomReadiness(room);
  const humanVersions = humanVersionSet(room);
  const unsupportedVersions = unsupportedHumanVersions(humanVersions);
  const versionMismatch = humanVersions.length > 1 || unsupportedVersions.length > 0;
  const offlineHumans = room.players.filter((player) => !player.isBot && !player.connected);
  const unreadyHumans = room.players.filter((player) => !player.isBot && player.connected && !player.ready);
  const connected = room.players.filter((player) => player.connected).length;
  const host = room.players.find((player) => player.id === room.hostId);
  const canStart = (!room.started || Boolean(room.winner))
    && room.players.length >= 2
    && (room.gameType !== "trump" || !trumpSeatError(room.players.length) && trumpTeamsEqual(room))
    && Boolean(host?.connected)
    && !outdatedTrumpClients(room)
    && !versionMismatch
    && readiness.allReady;
  const totalKnownCards = room.centerPile.length + room.players.reduce((total, player) => total + player.hand.length, 0);
  return {
    id: room.id,
    gameType: room.gameType,
    started: room.started,
    hostId: room.hostId || "",
    currentPlayerId: room.started && !room.winner ? currentPlayer(room).id : "",
    currentPlayerName: room.started && !room.winner ? currentPlayer(room).name : "",
    phase: room.winner ? "Round over" : room.started ? "Playing" : "Lobby",
    roundNumber: room.roundNumber || 0,
    playerCount: room.players.length,
    connected,
    connectedCount: connected,
    humanCount: readiness.humanCount,
    readyCount: readiness.readyCount,
    allReady: readiness.allReady,
    offlineHumanCount: offlineHumans.length,
    offlineHumanNames: offlineHumans.map((player) => player.name).join(", "),
    unreadyHumanNames: unreadyHumans.map((player) => player.name).join(", "),
    serverProtocol: SERVER_PROTOCOL,
    serverBuild: SERVER_BUILD,
    versionMismatch,
    versionWarning: versionMismatch ? humanVersions.join(" / ") : "",
    serverVersionMismatch: unsupportedVersions.length > 0,
    canStart,
    startBlockReason: roomSummaryStartBlockReason(room, readiness, humanVersions, versionMismatch, offlineHumans, unreadyHumans, canStart),
    activeRank: room.activeRank || "",
    minimumOpeningCards: room.minimumOpeningCards,
    centerCount: room.centerPile.length,
    voiceClips: true,
    liveCalls: liveCallConfigured(),
    maxVoiceDurationMs: MAX_VOICE_DURATION_MS,
    totalKnownCards: room.gameType === "trump" ? trumpPublicState(room, {}).totalKnownCards : totalKnownCards,
    deckOk: room.gameType === "trump" ? trumpPublicState(room, {}).deckOk : totalKnownCards === 52,
    botSpeedMs: room.botSpeedMs || 650,
    winner: room.winner || "",
    winnerId: room.winnerId || "",
    winnerReason: room.winnerReason || "",
    latestEvent: room.log.at(-1) || "",
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatarIndex: player.avatarIndex,
      host: player.id === room.hostId,
      current: room.started && !room.winner && player.id === currentPlayer(room).id,
      connected: player.connected,
      ready: Boolean(player.ready || player.isBot),
      isBot: Boolean(player.isBot),
      difficulty: player.difficulty || "",
      appVersion: player.isBot ? "" : player.appVersion || "old",
      cardCount: player.hand.length,
      wins: player.wins || 0,
      team: room.gameType === "trump" ? player.team : null,
    })),
  };
}

function roomSummaryStartBlockReason(room, readiness, humanVersions, versionMismatch, offlineHumans, unreadyHumans, canStart) {
  if (canStart) return room.winner ? "Ready for rematch. Host can tap Play Again." : "Ready. Host can tap Start Game.";
  if (room.started && !room.winner) return "Round is already running.";
  if (room.players.length < 2) return "Need at least 2 players or bots.";
  if (room.gameType === "trump" && trumpSeatError(room.players.length)) return trumpSeatError(room.players.length);
  if (room.gameType === "trump" && !trumpTeamsEqual(room)) return "Choose equal teams before starting.";
  const host = room.players.find((player) => player.id === room.hostId);
  if (!host?.connected) return "Host is offline. A connected player should Claim Host.";
  const unsupportedVersions = unsupportedHumanVersions(humanVersions);
  if (humanVersions.length > 1) return `All phones need the same APK version. Found: ${humanVersions.join(" / ")}.`;
  if (unsupportedVersions.length > 0) return `This server needs APK v${SERVER_BUILD}. Found: ${unsupportedVersions.join(" / ")}.`;
  if (outdatedTrumpClients(room)) return 'Every phone needs Jhoota build 103 or newer for the balanced Trump rules.';
  if (offlineHumans.length > 0) return `Offline seat blocking start: ${offlineHumans.map((player) => player.name).join(", ")}.`;
  if (!readiness.allReady && unreadyHumans.length > 0) return `Waiting for ready: ${unreadyHumans.map((player) => player.name).join(", ")}.`;
  if (!readiness.allReady) return room.winner ? "Everyone must ready up again before rematch." : "All human players must ready up.";
  return "Host checklist is not complete.";
}

function localServerUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`ws://${entry.address}:${PORT}`);
      }
    }
  }
  urls.push(`ws://127.0.0.1:${PORT}`);
  return [...new Set(urls)];
}

function rankOf(card) {
  return card.slice(0, -1);
}

function isValidCard(card) {
  return SUITS.includes(card.slice(-1)) && RANKS.includes(rankOf(card));
}

function sortCard(a, b) {
  const rankDiff = RANKS.indexOf(rankOf(a)) - RANKS.indexOf(rankOf(b));
  return rankDiff || a.localeCompare(b);
}

function send(socket, payload) {
  socket.send(JSON.stringify(payload));
}

function sendToPlayer(room, playerId, message) {
  const player = room.players.find((item) => item.id === playerId);
  if (player?.socket?.readyState === 1) {
    send(player.socket, { type: "error", message });
  }
}

function cleanName(name, fallback) {
  return String(name || "")
    .replace(/[^\w .-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18) || fallback;
}

function cleanAvatarIndex(value, name = "Player") {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed < AVATAR_COUNT) {
    return parsed;
  }
  let hash = 0;
  for (const character of String(name || "Player")) {
    hash = ((hash * 31) + character.charCodeAt(0)) | 0;
  }
  return 8 + Math.abs(hash) % 8;
}

function uniquePlayerName(room, name, exceptId = "") {
  const base = cleanName(name, "Player");
  const existing = new Set(room.players
    .filter((player) => player.id !== exceptId)
    .map((player) => player.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix <= 99; suffix++) {
    const candidate = cleanName(`${base} ${suffix}`, base);
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 14)} ${Math.floor(100 + Math.random() * 900)}`;
}

function samePlayerName(left, right) {
  return cleanName(left, "").toLowerCase() === cleanName(right, "").toLowerCase();
}

function uniqueCards(cards) {
  return [...new Set(Array.isArray(cards) ? cards : [])];
}

function json(response, payload) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
