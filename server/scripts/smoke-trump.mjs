import assert from 'node:assert/strict';
import WebSocket from 'ws';

const url = process.env.BLUFF_WS_URL || 'ws://127.0.0.1:8080';
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait(predicate, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect() {
  const client = { ws: new WebSocket(url), state: null, messages: [] };
  clients.push(client);
  client.ws.on('message', raw => {
    const message = JSON.parse(raw.toString()); client.messages.push(message);
    if (message.type === 'state') client.state = message.state;
  });
  await new Promise((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); });
  client.send = message => client.ws.send(JSON.stringify({ ...(['create', 'join'].includes(message.type) ? { appBuild: 103 } : {}), ...message }));
  return client;
}

async function expectError(client, message, text) {
  const start = client.messages.length; client.send(message);
  await wait(() => client.messages.slice(start).some(m => m.type === 'error' && m.message.includes(text)), text);
}

async function scenario(count) {
  const players = [];
  const host = await connect(); players.push(host);
  host.send({ type: 'create', name: `Trump${count}Host`, avatarIndex: 0, appVersion: '0.95', gameType: 'trump' });
  await wait(() => host.state, 'creation');
  const roomId = host.state.roomId;
  for (let i = 1; i < count; i++) {
    const client = await connect(); players.push(client);
    client.send({ type: 'join', roomId, name: `Trump${count}Guest${i}`, avatarIndex: i === count - 1 ? 15 : i, appVersion: '0.95' });
    await wait(() => client.state, 'join');
  }
  await wait(() => host.state.playerCount === count, 'full roster');
  assert.equal(host.state.players.at(-1).avatarIndex, 15);
  assert.equal(host.state.gameType, 'trump');
  await expectError(players[1], { type: 'shuffleTeams' }, 'Only the host');
  // Make the sides unequal, verify readiness/start blocking, then restore them.
  host.send({ type: 'chooseTeam', team: 1 });
  await wait(() => host.state.players.find(p => p.id === host.state.playerId).team === 1, 'team choice');
  assert.equal(host.state.players.filter(p => p.team === 1).length, count / 2 + 1);
  await expectError(host, { type: 'start' }, 'equal teams');
  host.send({ type: 'shuffleTeams' });
  await wait(() => host.state.players.filter(p => p.team === 0).length === count / 2, 'balanced shuffle');
  assert.ok(host.state.players.every(p => !p.ready));
  assert.equal(host.state.requireTrumpOpened, false);
  await expectError(players[1], { type: 'setTrumpLeadRule', enabled: true }, 'Only the host');
  host.send({ type: 'setTrumpLeadRule', enabled: true }); await wait(() => host.state.requireTrumpOpened, 'optional rule enabled');
  host.send({ type: 'setTrumpLeadRule', enabled: false }); await wait(() => !host.state.requireTrumpOpened, 'unrestricted default restored');
  const status = await fetch(`${url.replace('ws:', 'http:')}/room/${roomId}`).then(r => r.json());
  assert.equal(status.room.gameType, 'trump');
  assert.ok(status.room.players.every(p => [0, 1].includes(p.team)));
  for (const p of players) p.send({ type: 'setReady', ready: true });
  await wait(() => host.state.allReady, 'ready');
  if (count === 6) {
    host.send({ type: 'setTrumpLeadRule', enabled: true }); await wait(() => host.state.requireTrumpOpened && !host.state.allReady, 'rule change resets ready');
    assert.ok(host.state.players.every(p => !p.ready));
    for (const p of players) p.send({ type: 'setReady', ready: true }); await wait(() => host.state.allReady, 'ready for optional rule');
  }
  host.send({ type: 'start' });
  await wait(() => players.every(p => p.state.trumpPhase === 'choose'), 'first five');
  assert.ok(players.every(p => p.state.hand.length === 5 && p.state.deckOk));
  assert.ok(players.every(p => !('reserve' in p.state) && !('captured' in p.state)));
  await expectError(host, { type: 'chooseTeam', team: 1 }, 'locked');
  await expectError(host, { type: 'shuffleTeams' }, 'locked');
  const caller = players.find(p => p.state.playerId === host.state.trumpCallerId);
  const other = players.find(p => p !== caller);
  await expectError(host, { type: 'setTrumpLeadRule', enabled: true }, 'Only the host');
  await expectError(other, { type: 'extendTurn' }, 'current human');
  const deadline = caller.state.turnDeadline;
  caller.send({ type: 'extendTurn' }); await wait(() => caller.state.extensionUsed, 'extra time');
  assert.equal(caller.state.turnDeadline, deadline + 15000); assert.equal(caller.state.canExtendTurn, false);
  await expectError(caller, { type: 'extendTurn' }, 'already been used');
  await expectError(other, { type: 'chooseTrump', suit: 'H' }, 'Only the trump caller');
  caller.send({ type: 'chooseTrump', suit: 'H' });
  await wait(() => players.every(p => p.state.trumpPhase === 'play'), 'full deal');
  assert.ok(players.every(p => p.state.hand.length === (count === 6 ? 12 : count === 8 ? 10 : 13)));
  assert.equal(new Set(players.flatMap(p => p.state.hand)).size, count === 4 ? 52 : count === 6 ? 72 : 80);
  for (const rank of ['A', 'K', 'Q', 'J']) assert.equal(players.flatMap(p => p.state.hand).filter(c => c.split(':').at(-1).slice(0, -1) === rank).length, 4);
  await expectError(caller, { type: 'chooseTrump', suit: 'S' }, 'already');
  await expectError(host, { type: 'bluff' }, 'Bluff');
  let moves = 0;
  while (!host.state.winner) {
    await wait(() => host.state.winner || players.every(p => p.state.trumpPhase === 'play'), 'hand reveal ends');
    if (host.state.winner) break;
    const current = players.find(p => p.state.playerId === host.state.currentPlayerId);
    await wait(() => current.state.currentPlayerId === current.state.playerId, 'current private state');
    const before = JSON.stringify(host.state);
    const legal = current.state.legalCards;
    assert.ok(legal.length > 0);
    if (moves === 0) await expectError(other, { type: 'play', cards: [other.state.hand[0]] }, 'not your turn');
    current.send({ type: 'play', cards: [legal[0]] });
    await wait(() => JSON.stringify(host.state) !== before, 'move');
    assert.equal(host.state.trumpSuit, 'H'); assert.equal(host.state.deckOk, true);
    assert.equal(host.state.totalKnownCards, count === 4 ? 52 : count === 6 ? 72 : 80);
    if (host.state.trumpPhase === 'reveal') { assert.equal(host.state.trick.length, count); assert.ok(host.state.handWinnerId); assert.equal(host.state.teamScores.reduce((a, b) => a + b), host.state.completedTricks); assert.equal(host.state.turnDeadline, 0); }
    if (++moves > 80) throw new Error('Game failed to finish');
  }
  const winningIds = host.state.players.filter(p => p.team === (host.state.winner === 'Team A' ? 0 : 1)).map(p => p.id);
  const draw = host.state.winner === 'Draw';
  const leaderboard = host.state.handWins;
  assert.equal(leaderboard.reduce((sum, p) => sum + p.handsWon, 0), host.state.completedTricks);
  assert.equal(host.state.handHistory.length, host.state.completedTricks);
  for (const team of [0, 1]) assert.equal(leaderboard.filter(p => p.team === team).reduce((sum, p) => sum + p.handsWon, 0), host.state.teamScores[team]);
  host.send({ type: 'shuffleTeams' });
  await wait(() => host.state.latestEvent.includes('shuffled'), 'postgame shuffle');
  assert.deepEqual(host.state.handWins, leaderboard);
  for (const p of players) p.send({ type: 'setReady', ready: true });
  await wait(() => host.state.allReady, 'rematch ready');
  host.send({ type: 'start' });
  await wait(() => host.state.roundNumber === 2, 'rematch');
  assert.equal(host.state.callerSource, 'toss');
  assert.equal(host.state.trumpSuit, ''); assert.equal(host.state.hand.length, 5);
  assert.equal(host.state.extensionUsed, false);
  host.send({ type: 'endRoom' });
  await wait(() => host.messages.some(m => m.type === 'roomEnded'), 'cleanup');
  players.forEach(p => p.ws.terminate());
  console.log(`Trump ${count} seats: team selection, shuffle, full game and rematch passed (${moves} cards).`);
}

async function bluffExtensions() {
  const host = await connect(), guest = await connect();
  host.send({ type: 'create', name: 'ExtraTimeHost', gameType: 'bluff', appVersion: '0.95' }); await wait(() => host.state, 'extension lobby');
  guest.send({ type: 'join', roomId: host.state.roomId, name: 'ExtraTimeGuest', appVersion: '0.95' }); await wait(() => host.state.playerCount === 2, 'extension guest');
  await expectError(host, { type: 'extendTurn' }, 'active turn');
  host.send({ type: 'setReady', ready: true }); guest.send({ type: 'setReady', ready: true }); await wait(() => host.state.allReady, 'extension ready');
  host.send({ type: 'start' }); await wait(() => host.state.started && guest.state.started, 'extension game');
  const current = [host, guest].find(p => p.state.playerId === host.state.currentPlayerId), other = current === host ? guest : host;
  await expectError(other, { type: 'extendTurn' }, 'current human');
  const deadline = current.state.turnDeadline; current.send({ type: 'extendTurn' }); await wait(() => current.state.extensionUsed, 'bluff extension');
  assert.equal(current.state.turnDeadline, deadline + 15000); await expectError(current, { type: 'extendTurn' }, 'already been used');
  current.send({ type: 'chat', value: 'Deadline unchanged' }); await wait(() => current.state.chat.some(m => m.value === 'Deadline unchanged'), 'chat after extension');
  assert.equal(current.state.turnDeadline, deadline + 15000);
  current.send({ type: 'pass' }); await wait(() => other.state.currentPlayerId === other.state.playerId, 'next turn');
  assert.equal(other.state.canExtendTurn, true); other.send({ type: 'pass' }); await wait(() => current.state.currentPlayerId === current.state.playerId, 'return to used player');
  assert.equal(current.state.extensionUsed, true); assert.equal(current.state.canExtendTurn, false);
  host.send({ type: 'restartRound' }); await wait(() => current.state.roundNumber === 2, 'new extension allowance'); assert.equal(current.state.extensionUsed, false);
  host.send({ type: 'endRoom' }); await wait(() => host.messages.some(m => m.type === 'roomEnded'), 'extension cleanup'); host.ws.terminate(); guest.ws.terminate();
  console.log('Bluff extra time: owner, once per game, chat deadline, turn persistence and reset passed.');
}

try {
  const old = await connect(); old.send({ type: 'create', name: 'Old APK', gameType: 'trump', appVersion: '0.95', appBuild: 100 });
  await wait(() => old.state, 'old APK lobby'); old.send({ type: 'fillBots', target: 4, difficulty: 'Pro' });
  await wait(() => old.state.playerCount === 4, 'old APK balanced lobby');
  assert.equal(old.state.canStart, false); assert.match(old.state.startBlockReason, /build 103/);
  await expectError(old, { type: 'start' }, 'build 103'); old.send({ type: 'endRoom' });
  await wait(() => old.messages.some(m => m.type === 'roomEnded'), 'old APK cleanup');
  console.log('Old Trump APK cannot start incompatible two-deck rules.');
  for (const count of [4, 6, 8]) await scenario(count);
  await bluffExtensions();
  const host = await connect(); host.send({ type: 'create', name: 'OddSeats', gameType: 'trump', appVersion: '0.95' });
  await wait(() => host.state, 'odd lobby');
  host.send({ type: 'fillBots', target: 5, difficulty: 'Pro' });
  await wait(() => host.state.playerCount === 5, 'odd seats');
  await expectError(host, { type: 'start' }, '4, 6 or 8');
  host.send({ type: 'fillBots', target: 6, difficulty: 'Pro' });
  await wait(() => host.state.playerCount === 6, 'balance bot');
  host.send({ type: 'setBotSpeed', speed: 'Fast' }); host.send({ type: 'start' });
  await wait(() => host.state.started, 'balanced bot start');
  // Exercise scheduled bots and a human, independent of who wins the toss.
  await wait(() => host.state.trumpPhase === 'play' || host.state.trumpPhase === 'choose' && host.state.trumpCallerId === host.state.playerId, 'bot call');
  if (host.state.trumpPhase === 'choose') host.send({ type: 'chooseTrump', suit: 'S' });
  await wait(() => host.state.trumpPhase === 'play', 'bot play');
  await wait(() => host.state.currentPlayerId === host.state.playerId, 'bots reach human');
  assert.ok(host.state.legalCards.length);
  host.send({ type: 'play', cards: [host.state.legalCards[0]] });
  await wait(() => host.state.completedTricks > 0, 'bots finish hand');
  host.send({ type: 'endRoom' });
  await wait(() => host.messages.some(m => m.type === 'roomEnded'), 'bot cleanup');
  console.log('Trump odd-seat balancing and scheduled bots passed.');
} finally { clients.forEach(p => p.ws.terminate()); }
