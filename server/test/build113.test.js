import test from 'node:test';
import assert from 'node:assert/strict';
import { table } from './helpers/room-harness.js';

test('host disconnect reserves ownership for 15 seconds then promotes first eligible seat', () => {
  const { h, host, guest, room } = table(); h.join('Third', room.id);
  h.disconnect(host);
  const state = h.states.get('Guest');
  assert.equal(state.hostId, host.playerId); assert.equal(state.hostStatus, 'reconnecting');
  assert.equal(state.hostGraceUntil, 16000); assert.equal(state.canClaimHost, false);
  h.send(guest, { type: 'claimHost' }); assert.equal(room.hostId, host.playerId);
  h.advance(14999); assert.equal(room.hostId, host.playerId);
  h.advance(1); assert.equal(room.hostId, guest.playerId);
  assert.equal(h.states.get('Third').hostStatus, 'connected');
  assert.equal(h.states.get('Third').hostGraceUntil, 0);
});

test('rejoin inside grace retains host, old close is ignored, late creator cannot steal host', () => {
  const { h, host, guest, room } = table(), identity = room.players[0];
  h.disconnect(host); h.advance(14000);
  const restored = h.join('HostAgain', room.id, identity.reconnectToken);
  h.advance(2000); assert.equal(room.hostId, identity.id);
  h.disconnect(host); assert.equal(identity.connected, true); assert.equal(identity.socket, restored);
  h.disconnect(restored); h.advance(15000); assert.equal(room.hostId, guest.playerId);
  h.join('Creator', room.id, identity.reconnectToken); assert.equal(room.hostId, guest.playerId);
});

test('intentional leave promotes immediately; new humans recover the same room after everyone leaves', () => {
  const { h, host, guest, room } = table(); h.send(host, { type: 'addBot' });
  h.send(host, { type: 'leave' }); assert.equal(room.hostId, guest.playerId);
  h.send(guest, { type: 'leave' });
  const newcomer = h.join('Newcomer', room.id);
  assert.equal(h.room(newcomer), room); assert.equal(room.hostId, newcomer.playerId);
  assert.equal(h.states.get('Newcomer').hostStatus, 'connected');
});

test('orphan host recovery ignores stale grace and manual claim is restricted to connected seats', () => {
  const { h, host, guest, room } = table(), seat = room.players[1];
  h.disconnect(host); h.disconnect(guest); h.advance(15000);
  room.hostId = 'missing'; room.hostGraceUntil = h.now + 50000;
  assert.equal(h.state(room, seat).hostStatus, 'unavailable');
  assert.equal(h.state(room, seat).canClaimHost, false);
  const restored = h.join('Returned', room.id, seat.reconnectToken);
  assert.equal(room.hostId, restored.playerId);
  room.hostId = 'missing'; assert.equal(h.state(room, seat).canClaimHost, true);
  h.send(restored, { type: 'claimHost' }); assert.equal(room.hostId, seat.id);
  h.send(h.open('Outsider'), { type: 'claimHost', playerId: host.playerId }); assert.equal(room.hostId, seat.id);
});

test('transfers reject bots, offline seats, waiters and nonhosts; repeated transfers preserve deal and tally', () => {
  const { h, host, guest, room } = table(); h.send(host, { type: 'addBot' });
  const bot = room.players.find(p => p.isBot);
  h.send(host, { type: 'transferHost', targetId: bot.id }); assert.equal(room.hostId, host.playerId);
  h.send(guest, { type: 'transferHost', targetId: guest.playerId }); assert.equal(room.hostId, host.playerId);
  h.send(guest, { type: 'setReady', ready: true }); h.send(host, { type: 'start' });
  const waiting = h.join('Waiting', room.id);
  h.send(host, { type: 'transferHost', targetId: waiting.playerId }); assert.equal(room.hostId, host.playerId);
  h.send(waiting, { type: 'claimHost' }); assert.equal(room.hostId, host.playerId);
  const matchId = room.matchId, hands = JSON.stringify(room.players.map(p => p.hand));
  room.teamMatchTally = { contestId: 'existing', games: 2, wins: [1, 1], draws: 0, history: [] };
  h.send(host, { type: 'transferHost', targetId: guest.playerId }); assert.equal(room.hostId, guest.playerId);
  h.send(guest, { type: 'transferHost', playerId: host.playerId }); assert.equal(room.hostId, host.playerId);
  h.disconnect(guest); h.send(host, { type: 'transferHost', targetId: guest.playerId }); assert.equal(room.hostId, host.playerId);
  assert.equal(room.matchId, matchId); assert.equal(JSON.stringify(room.players.map(p => p.hand)), hands);
  assert.equal(room.teamMatchTally.games, 2);
});

test('host timers are cancelled on reconnect and room end', () => {
  const { h, host, room } = table(), seat = room.players[0];
  h.disconnect(host); assert.equal(h.timers.size, 1);
  const restored = h.join('Returned', room.id, seat.reconnectToken); assert.equal(h.timers.size, 0);
  h.send(restored, { type: 'chat', value: 'bye' });
  h.send(restored, { type: 'endRoom' }); assert.equal(h.room(restored), undefined);
  assert.equal(h.timers.size, 0); h.advance(30000);
});

test('bubbles use server identity, dedupe events, expire, and preserve turn and private hands', () => {
  const { h, host, guest, room } = table();
  h.send(guest, { type: 'setReady', ready: true }); h.send(host, { type: 'start' });
  const before = h.states.get('Guest'), deadline = room.turnDeadline;
  const payload = { type: 'chat', value: 'hello table', id: 'hello-1', playerId: host.playerId, name: 'Spoof', avatarIndex: 15 };
  h.send(guest, payload);
  let state = h.states.get('Host'); assert.equal(state.tableBubbles.length, 1);
  const bubble = state.tableBubbles[0];
  assert.deepEqual({ ...bubble, id: 'server-id' }, { id: 'server-id', playerId: guest.playerId, name: 'Guest', avatarIndex: 4, kind: 'text', value: 'hello table', createdAt: 1000, expiresAt: 6000 });
  assert.notEqual(bubble.id, payload.id); assert.equal(state.currentPlayerId, before.currentPlayerId);
  assert.equal(room.turnDeadline, deadline); assert.deepEqual(h.states.get('Guest').hand, before.hand);
  assert(state.players.every(p => !('hand' in p) && !('reconnectToken' in p)));
  const count = room.chat.length; h.advance(2100); h.send(guest, payload);
  assert.equal(room.chat.length, count); assert.equal(h.states.get('Host').tableBubbles[0].id, bubble.id);
  h.send(guest, { type: 'sticker', value: 'yey-lay', id: 'sticker-1' });
  state = h.states.get('Host'); assert.equal(state.tableBubbles.length, 1);
  assert.equal(state.tableBubbles[0].kind, 'sticker'); assert.equal(state.tableBubbles[0].expiresAt, 5900);
  h.advance(2800); assert.deepEqual(h.states.get('Host').tableBubbles, []);
  assert.equal(room.chat.at(-2).value, 'hello table');
  const token = room.players[1].reconnectToken; h.disconnect(guest); h.join('Rejoined', room.id, token);
  assert.deepEqual(h.states.get('Rejoined').tableBubbles, []);
});

test('sticker allowlist, legacy reactions, cooldown, text limit and expiry are enforced', () => {
  const { h, host, guest, room } = table(), count = room.chat.length;
  for (const value of ['<script>', 'unknown', {}, 12, '']) h.send(guest, { type: 'sticker', value });
  assert.equal(room.chat.length, count);
  for (const value of ['yey-lay', 'two-j', 'maalik', 'ghup-ghup', 'nahi-yar', 'laugh', 'side-eye', 'shocked', 'wink', 'cry', 'applause', 'Nice try!', 'Good play!', 'I doubt it', 'Caught!', 'Big bluff!']) {
    h.send(guest, { type: 'sticker', value }); assert.equal(h.states.get('Host').tableBubbles.at(-1).value, value);
    const accepted = room.chat.length; h.send(guest, { type: 'sticker', value: 'laugh' }); assert.equal(room.chat.length, accepted);
    h.advance(2000);
  }
  h.send(host, { type: 'chat', value: 'a'.repeat(400) }); assert.equal(room.chat.at(-1).value.length, 120);
  assert.equal(h.states.get('Host').tableBubbles.find(b => b.playerId === host.playerId).value.length, 120);
  h.advance(5000); assert.deepEqual(h.states.get('Guest').tableBubbles, []); assert(room.chat.length <= 20);
});

test('waiting friends can send social bubbles but cannot acquire host', () => {
  const { h, host, guest, room } = table();
  h.send(guest, { type: 'setReady', ready: true }); h.send(host, { type: 'start' });
  const waiter = h.join('Waiter', room.id); h.send(waiter, { type: 'chat', value: 'Next game!' });
  assert.equal(h.states.get('Host').tableBubbles[0].playerId, waiter.playerId);
  assert.deepEqual(h.states.get('Waiter').hand, []); assert.equal(h.states.get('Waiter').canClaimHost, false);
});

test('public build113 presentation retains rules108, bot111 and protocol7', () => {
  const { h } = table('trump'), state = h.states.get('Host');
  assert.equal(state.presentationRevision, 113); assert.equal(state.rulesRevision, 108);
  assert.equal(state.botRevision, 111); assert.equal(state.serverProtocol, 7);
});

test('starting a match snapshots its league before later host changes', () => {
  const { h, host, guest, room } = table(); room.leagueId = 'original-club';
  h.send(guest, { type: 'setReady', ready: true }); h.send(host, { type: 'start' });
  assert.equal(room.matchLeagueId, 'original-club');
  h.send(host, { type: 'transferHost', targetId: guest.playerId }); room.leagueId = 'replacement-club';
  assert.equal(room.matchLeagueId, 'original-club');
});

test('expired host grace is resolved before a late creator attaches even if its timer was delayed', () => {
  const { h, host, guest, room } = table(), creator = room.players[0];
  h.disconnect(host); h.timers.clear(); h.advance(16000);
  h.join('LateCreator', room.id, creator.reconnectToken); assert.equal(room.hostId, guest.playerId);
});

test('newly connected seats wait out an offline host grace; fresh rejoin replaces old sockets safely', () => {
  const { h, host, guest, room } = table(), seat = room.players[1];
  h.disconnect(host); h.disconnect(guest); h.advance(5000);
  const returned = h.join('Returned', room.id, seat.reconnectToken);
  assert.equal(room.hostId, host.playerId); assert.equal(h.states.get('Returned').canClaimHost, false);
  h.advance(10000); assert.equal(room.hostId, returned.playerId);
  const replacement = h.join('OtherPhone', room.id, seat.reconnectToken);
  assert.equal(seat.socket, replacement); assert.equal(seat.connected, true); assert.equal(room.hostId, replacement.playerId);
});

test('text and stickers work both on and off turn without changing Trump hands or collection scores', () => {
  const { h, host, guest, room } = table('trump');
  for (const id of ['Third', 'Fourth']) h.join(id, room.id);
  for (const p of room.players.slice(1)) h.send(p.socket, { type: 'setReady', ready: true });
  h.send(host, { type: 'start' });
  const before = h.states.get('Host'), scores = [...before.teamScores];
  for (const socket of [host, guest]) h.send(socket, { type: 'sticker', value: 'shocked' });
  const after = h.states.get('Host');
  assert.equal(after.tableBubbles.length, 2); assert.deepEqual(after.hand, before.hand);
  assert.deepEqual(after.teamScores, scores); assert.equal(after.currentPlayerId, before.currentPlayerId);
  assert.equal(after.trumpPhase, before.trumpPhase); assert.equal(after.turnDeadline, before.turnDeadline);
  assert.equal(after.teamMatchTally.games, 0);
  assert(after.players.every(p => !('hand' in p) && !('reconnectToken' in p)));
});
