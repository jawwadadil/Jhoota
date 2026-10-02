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
  client.send = message => client.ws.send(JSON.stringify(message));
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
  const status = await fetch(`${url.replace('ws:', 'http:')}/room/${roomId}`).then(r => r.json());
  assert.equal(status.room.gameType, 'trump');
  assert.ok(status.room.players.every(p => [0, 1].includes(p.team)));
  for (const p of players) p.send({ type: 'setReady', ready: true });
  await wait(() => host.state.allReady, 'ready');
  host.send({ type: 'start' });
  await wait(() => players.every(p => p.state.trumpPhase === 'choose'), 'first five');
  assert.ok(players.every(p => p.state.hand.length === 5 && p.state.deckOk));
  assert.ok(players.every(p => !('reserve' in p.state) && !('captured' in p.state)));
  await expectError(host, { type: 'chooseTeam', team: 1 }, 'locked');
  await expectError(host, { type: 'shuffleTeams' }, 'locked');
  const caller = players.find(p => p.state.playerId === host.state.trumpCallerId);
  const other = players.find(p => p !== caller);
  await expectError(other, { type: 'chooseTrump', suit: 'H' }, 'Only the trump caller');
  caller.send({ type: 'chooseTrump', suit: 'H' });
  await wait(() => players.every(p => p.state.trumpPhase === 'play'), 'full deal');
  assert.ok(players.every(p => p.state.hand.length === (count === 4 ? 13 : count === 6 ? 8 : 6)));
  assert.equal(new Set(players.flatMap(p => p.state.hand)).size, count === 4 ? 52 : 48);
  await expectError(caller, { type: 'chooseTrump', suit: 'S' }, 'already');
  await expectError(host, { type: 'bluff' }, 'Bluff');
  let moves = 0;
  while (!host.state.winner) {
    const current = players.find(p => p.state.playerId === host.state.currentPlayerId);
    await wait(() => current.state.currentPlayerId === current.state.playerId, 'current private state');
    const before = JSON.stringify(host.state);
    const legal = current.state.legalCards;
    assert.ok(legal.length > 0);
    if (moves === 0) await expectError(other, { type: 'play', cards: [other.state.hand[0]] }, 'not your turn');
    current.send({ type: 'play', cards: [legal[0]] });
    await wait(() => JSON.stringify(host.state) !== before, 'move');
    assert.equal(host.state.trumpSuit, 'H'); assert.equal(host.state.deckOk, true);
    assert.equal(host.state.totalKnownCards, count === 4 ? 52 : 48);
    if (++moves > 52) throw new Error('Game failed to finish');
  }
  const winningIds = host.state.players.filter(p => p.team === (host.state.winner === 'Team A' ? 0 : 1)).map(p => p.id);
  const draw = host.state.winner === 'Draw';
  host.send({ type: 'shuffleTeams' });
  await wait(() => host.state.latestEvent.includes('shuffled'), 'postgame shuffle');
  for (const p of players) p.send({ type: 'setReady', ready: true });
  await wait(() => host.state.allReady, 'rematch ready');
  host.send({ type: 'start' });
  await wait(() => host.state.roundNumber === 2, 'rematch');
  if (!draw) assert.ok(winningIds.includes(host.state.trumpCallerId));
  assert.equal(host.state.trumpSuit, ''); assert.equal(host.state.hand.length, 5);
  host.send({ type: 'endRoom' });
  await wait(() => host.messages.some(m => m.type === 'roomEnded'), 'cleanup');
  players.forEach(p => p.ws.terminate());
  console.log(`Trump ${count} seats: team selection, shuffle, full game and rematch passed (${moves} cards).`);
}

try {
  for (const count of [4, 6, 8]) await scenario(count);
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
  await wait(() => host.state.trumpPhase === 'play' || host.state.trumpCallerId === host.state.playerId, 'bot call');
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
