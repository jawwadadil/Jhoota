import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const asset = new URL('../../app/src/main/assets/nearby-engine.js', import.meta.url);

function harness(initialTime = 1000) {
  let now = initialTime, next = 0, snapshot = '';
  const timers = new Map(), states = new Map(), messages = [];
  const context = vm.createContext({ window: { NearbyBridge: {
    uuid: randomUUID, send: (id, value) => { const message = JSON.parse(value); messages.push({ id, ...message }); if (message.state) states.set(id, message.state); },
    save: value => { snapshot = value; }, room() {}, ready() {},
  } }, Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { timers.set(++next, { fn, at: now + delay }); return next; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(readFileSync(asset, 'utf8'), context);
  const engine = context.window.NearbyEngine;
  return { engine, states, messages, get snapshot() { return snapshot; }, get now() { return now; },
    advance(ms = 250) {
      const target = now + ms;
      let steps = 0;
      while (steps++ < 10000) {
        const task = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!task || task[1].at > target) break;
        timers.delete(task[0]); now = task[1].at; task[1].fn(); engine.tick();
      }
      now = target; engine.tick();
    },
    send(id, message) { engine.message(id, JSON.stringify(message)); },
  };
}
const skip = !existsSync(asset);
test('host removes individual bots and a friend replaces a bot in a full pregame lobby', { skip }, () => {
  const h = harness(); h.engine.open('host'); h.send('host', { type: 'create', name: 'Jawwad', appVersion: '0.95', appBuild: 108, gameType: 'trump' });
  const roomId = h.states.get('host').roomId;
  h.send('host', { type: 'fillBots', target: 8, difficulty: 'Pro' });
  h.engine.open('friend'); h.send('friend', { type: 'join', roomId, name: 'Musab', appVersion: '0.95', appBuild: 108 });
  assert.equal(h.states.get('host').playerCount, 8); assert.equal(h.states.get('friend').waiting, false);
  const bot = h.states.get('host').players.find(p => p.isBot);
  h.send('friend', { type: 'removeBot', botId: bot.id }); assert.equal(h.states.get('host').playerCount, 8);
  h.send('host', { type: 'removeBot', botId: h.states.get('host').playerId }); assert.equal(h.states.get('host').playerCount, 8);
  h.send('host', { type: 'removeBot', botId: bot.id }); assert.equal(h.states.get('host').playerCount, 7);
});
test('active match admits waiting friends privately; same room expands from four to six', { skip }, () => {
  const h = harness(); h.engine.open('host'); h.send('host', { type: 'create', name: 'Jawwad', appVersion: '0.95', appBuild: 108, gameType: 'trump' });
  const roomId = h.states.get('host').roomId; h.send('host', { type: 'fillBots', target: 4, difficulty: 'Pro' }); h.send('host', { type: 'start' });
  for (let i = 0; i < 2; i++) { h.engine.open(`friend${i}`); h.send(`friend${i}`, { type: 'join', roomId, name: `Friend ${i}`, appVersion: '0.95', appBuild: 108 }); }
  const waiting = h.states.get('friend0'); assert.equal(waiting.waiting, true); assert.deepEqual(waiting.hand, []); assert.deepEqual(waiting.legalCards, []);
  assert.equal(h.states.get('host').playerCount, 4); assert.equal(h.states.get('host').waitingPlayers.length, 2);
  h.send('friend0', { type: 'returnLobby' }); assert.equal(h.states.get('host').started, true);
  h.send('friend0', { type: 'start' }); assert.equal(h.states.get('host').started, true);
  h.send('friend0', { type: 'chat', value: 'Ready for next game' }); assert.equal(h.states.get('host').chat.at(-1).value, 'Ready for next game');
  h.send('host', { type: 'returnLobby' }); assert.equal(h.states.get('host').started, false); assert.equal(h.states.get('host').roomId, roomId);
  assert.equal(h.states.get('host').playerCount, 6); assert.equal(h.states.get('friend0').waiting, false);
  assert.equal(h.states.get('host').trumpPhase, 'lobby');
  for (let i = 0; i < 2; i++) h.send(`friend${i}`, { type: 'setReady', ready: true });
  h.send('host', { type: 'start' }); assert.equal(h.states.get('host').playerCount, 6); assert.equal(h.states.get('host').started, true); assert.equal(h.states.get('host').totalKnownCards, 72);
});
test('call presence is seat authenticated, separately connected, and never exposes tokens', { skip }, () => {
  const h = harness(); h.engine.open('host'); h.send('host', { type: 'create', name: 'Jawwad', appVersion: '0.95', appBuild: 108, gameType: 'bluff' });
  const identity = h.messages.find(m => m.type === 'created');
  h.engine.open('call'); h.send('call', { type: 'callPresence', roomId: identity.roomId, playerId: identity.playerId, reconnectToken: 'wrong', joined: true, muted: false, speaking: true });
  assert(h.messages.some(m => m.id === 'call' && m.type === 'callPresenceError'));
  // Nearby rooms do not issue LiveKit tokens, so even the genuine seat cannot announce a fabricated call.
  h.send('call', { type: 'callPresence', roomId: identity.roomId, playerId: identity.playerId, reconnectToken: identity.reconnectToken, joined: true, muted: false, speaking: true });
  assert.deepEqual(h.states.get('host').callParticipants, []); assert.equal(h.states.get('host').players[0].connected, true);
});
test('saving a long-paused game preserves the remaining turn after reopening', { skip }, () => {
  const h = harness(); h.engine.botStart({ gameType: 'bluff', count: 2, name: 'Jawwad', difficulty: 'Pro', speed: 'Slow' }, null);
  h.engine.pause(true);
  const first = JSON.parse(h.snapshot).rooms[0], remaining = first.turnDeadline - h.now;
  h.advance(60000); const saved = h.engine.exportSnapshot();
  assert.equal(JSON.parse(saved).rooms[0].turnDeadline - h.now, remaining);
  const next = harness(h.now + 3600000); next.engine.botStart({}, saved);
  const room = JSON.parse(next.snapshot).rooms[0];
  assert.equal(room.turnDeadline - next.now, remaining);
  assert.equal(room.pausedAt, undefined); next.engine.stop();
});
for (const gameType of ['bluff', 'trump']) for (const count of gameType === 'trump' ? [4, 6, 8] : [2, 4, 8]) {
  test(`canonical offline ${gameType} ${count}: full match and saved-seat recovery`, { skip }, () => {
    const h = harness(); h.engine.botStart({ gameType, count, name: 'Jawwad', avatarIndex: 0, difficulty: 'Pro', speed: 'Fast', seriesLength: 3 }, null);
    let state = h.states.get('solo'), moves = 0, restored = false;
    while (!state.winner && moves++ < 2000) {
      assert.equal(state.offline, true); assert.equal(state.liveCalls, false);
      assert(state.players.every(p => !('hand' in p) && !('reconnectToken' in p)));
      if (state.gameType === 'trump' && state.trumpPhase === 'review') h.engine.botAction('review', '');
      else if (state.currentPlayerId === state.playerId) {
        if (gameType === 'bluff') {
          if (!state.activeRank && state.hand.length === 1) h.engine.botAction('pass', '');
          else h.engine.botAction('play', JSON.stringify({ cards: state.hand.slice(0, state.activeRank ? 1 : Math.min(2, state.hand.length)), rank: state.activeRank || 'A' }));
        }
        else if (state.trumpPhase === 'tossPick') h.engine.botAction('toss', 'heads');
        else if (state.trumpPhase === 'caller') h.engine.botAction('caller', state.playerId);
        else if (state.trumpPhase === 'choose') h.engine.botAction('trump', 'H');
        else if (state.trumpPhase === 'play') h.engine.botAction('play', JSON.stringify({ cards: [state.legalCards[0]] }));
        else h.advance(1000);
      } else h.advance(1000);
      state = h.states.get('solo');
      if (!restored && state.started && state.hand.length > 2 && (!state.trumpPhase || state.trumpPhase === 'play')) {
        h.engine.pause(true); const saved = h.snapshot, before = h.states.get('solo'); h.advance(60000);
        assert.deepEqual(h.states.get('solo').hand, before.hand);
        const recovery = harness(); recovery.engine.botStart({}, saved);
        assert.deepEqual(recovery.states.get('solo').hand, before.hand); assert.equal(recovery.states.get('solo').matchId, before.matchId);
        assert.equal(recovery.states.get('solo').playerId, before.playerId); recovery.engine.stop();
        h.engine.pause(false); restored = true;
      }
    }
    assert(state.winner, 'game must finish'); assert.equal(state.gameNight.games, 1); assert.equal(state.canStart, true);
    h.engine.botAction('start', ''); state = h.states.get('solo'); assert.equal(state.roundNumber, 2); assert.equal(state.winner, ''); assert.equal(state.gameNight.games, 1);
  });
}
test('nearby players share lobby, private hands, voice notes and token-only reconnect', { skip }, () => {
  const h = harness(); h.engine.open('host'); h.send('host', { type: 'create', name: 'Jawwad', appVersion: '0.95', appBuild: 106, gameType: 'bluff' });
  const roomId = h.states.get('host').roomId;
  h.engine.open('guest'); h.send('guest', { type: 'join', roomId, name: 'Musab', appVersion: '0.95', appBuild: 106 });
  const seat = h.messages.find(m => m.id === 'guest' && m.type === 'joined');
  h.send('guest', { type: 'setReady', ready: true }); h.send('host', { type: 'start' });
  assert.equal(h.states.get('guest').hand.length, 26); assert.equal(h.states.get('host').hand.length, 26);
  assert.equal(new Set([...h.states.get('guest').hand, ...h.states.get('host').hand]).size, 52);
  assert.equal(h.states.get('guest').nearby, true); assert.equal(h.states.get('guest').liveCalls, false);
  h.send('host', { type: 'voice', data: 'AAAAAAAAAAAA', durationMs: 600 }); assert(h.messages.some(m => m.id === 'guest' && m.type === 'voice'));
  const hand = h.states.get('guest').hand; h.engine.close('guest');
  h.engine.open('impostor'); h.send('impostor', { type: 'join', roomId, name: 'Musab', appVersion: '0.95', appBuild: 106 });
  assert.equal(h.states.get('impostor').waiting, true); assert.deepEqual(h.states.get('impostor').hand, []);
  assert.notEqual(h.states.get('impostor').playerId, seat.playerId);
  h.engine.open('return'); h.send('return', { type: 'join', roomId, name: 'Musab', reconnectToken: seat.reconnectToken, appVersion: '0.95', appBuild: 106 });
  assert.deepEqual(h.states.get('return').hand, hand); assert.equal(h.states.get('return').playerId, seat.playerId);
});

for (const count of [4, 6, 8]) test(`nearby Trump ${count}: caller-only deal, legal tricks and shared result`, { skip }, () => {
  const h = harness();
  h.engine.open('p0'); h.send('p0', { type: 'create', name: 'Jawwad', appVersion: '0.95', appBuild: 106, gameType: 'trump' });
  const roomId = h.states.get('p0').roomId;
  for (let i = 1; i < count; i++) {
    h.engine.open(`p${i}`); h.send(`p${i}`, { type: 'join', roomId, name: `Cousin ${i}`, appVersion: '0.95', appBuild: 106 });
    h.send(`p${i}`, { type: 'setReady', ready: true });
  }
  h.send('p0', { type: 'start' });
  let moves = 0, sawFirstFive = false, sawFullDeal = false;
  while (!h.states.get('p0').winner && moves++ < 1000) {
    const states = [...h.states];
    assert(states.every(([, s]) => s.nearby && !s.liveCalls && s.players.every(p => !('hand' in p) && !('reconnectToken' in p))));
    const current = states.find(([, s]) => s.playerId === s.currentPlayerId);
    assert(current); const [id, state] = current;
    if (state.trumpPhase === 'tossPick') h.send(id, { type: 'trumpToss', choice: 'heads' });
    else if (state.trumpPhase === 'caller') h.send(id, { type: 'selectTrumpCaller', callerId: state.playerId });
    else if (state.trumpPhase === 'choose') {
      assert.equal(state.hand.length, 5);
      for (const [other, s] of states) if (other !== id) assert.equal(s.hand.length, 0);
      sawFirstFive = true; h.send(id, { type: 'chooseTrump', suit: 'H' });
    } else if (state.trumpPhase === 'review') {
      const hands = states.flatMap(([, s]) => s.hand);
      assert.equal(hands.length, count === 4 ? 52 : count === 6 ? 72 : 80);
      assert.equal(new Set(hands).size, hands.length); sawFullDeal = true;
      for (const [player] of states) h.send(player, { type: 'reviewTrumpHand' });
    } else if (state.trumpPhase === 'play') {
      const illegal = state.hand.find(card => !state.legalCards.includes(card));
      if (illegal) {
        const before = state.hand.slice(); h.send(id, { type: 'play', cards: [illegal] });
        assert.deepEqual(h.states.get(id).hand, before);
        assert.equal(h.messages.at(-1).type, 'error');
      }
      h.send(id, { type: 'play', cards: [state.legalCards[0]] });
    } else h.advance(3100);
  }
  assert(sawFirstFive && sawFullDeal); assert(h.states.get('p0').winner);
  const result = h.states.get('p0');
  for (const state of h.states.values()) {
    assert.equal(state.winner, result.winner); assert.equal(state.gameNight.games, 1);
    assert.deepEqual(state.teamTricks, result.teamTricks);
  }
  h.engine.stop();
});
