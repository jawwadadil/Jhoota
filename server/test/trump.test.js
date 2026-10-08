import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTrump as startTrump, advanceTrump, REVEAL_MS, TURN_MS, EXTENSION_MS, callTrumpToss, selectTrumpCaller, reviewTrumpHand, trumpDeck, extendTrumpTurn, chooseTrump as chooseRaw, playTrump, legalTrumpCards, trickWinner, trumpPublicState, chooseBotTrumpCard, chooseBotTrump } from '../trump.js';

function beginTrump(r, rng) {
  startTrump(r, rng);
  if (r.trump.phase === 'tossPick') { callTrumpToss(r, r.players[r.currentIndex].id, 'heads', Date.now(), () => 0); advanceTrump(r, r.trump.resolveAt); }
  selectTrumpCaller(r, r.players[r.currentIndex].id, r.players[r.currentIndex].id);
}
function chooseTrump(r, id, suit, now = Date.now()) {
  let error = chooseRaw(r, id, suit, now);
  for (let retry = 0; !error && r.trump.phase === 'choose' && retry < 100; retry++) error = chooseRaw(r, id, suit, now);
  if (!error && r.trump.phase === 'review') r.players.forEach(p => reviewTrumpHand(r, p.id, now));
  return error;
}
function resolve(r) { if (r.trump.phase === 'reveal') advanceTrump(r, r.trump.resolveAt); }

function room(count) {
  return { started: true, winner: null, log: [], players: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Player ${i}`, team: i % 2, hand: [], wins: 0, difficulty: 'Pro' })) };
}
function random(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }

for (const count of [4, 6, 8]) {
  test(`${count} players: exactly five visible cards, private reserve, equal complete deal`, () => {
    const r = room(count); beginTrump(r, random(count));
    assert(r.players.every((p, i) => p.hand.length === (i === r.currentIndex ? 5 : 0)));
    const snapshot = trumpPublicState(r, r.players[0]);
    assert(!('reserve' in snapshot));
    assert(snapshot.deckOk);
    const caller = r.players[r.currentIndex];
    assert.equal(chooseTrump(r, r.players[(r.currentIndex + 1) % count].id, 'S'), 'Only the trump caller can choose the suit.');
    assert(chooseTrump(r, caller.id, 'X'));
    assert.equal(chooseTrump(r, caller.id, 'H'), '');
    assert(r.players.every(p => p.hand.length === (count === 6 ? 12 : count === 8 ? 10 : 13)));
    const cards = r.players.flatMap(p => p.hand);
    assert.equal(new Set(cards).size, count === 4 ? 52 : count === 6 ? 72 : 80);
    assert.deepEqual([...cards].sort(), trumpDeck(count).sort());
    for (const rank of ['A', 'K', 'Q', 'J', '10', '9']) assert.equal(cards.filter(c => c.split(':').at(-1).slice(0, -1) === rank).length, 4);
    for (const card of cards.filter(c => c.startsWith('2:'))) { assert(cards.includes(card.slice(2))); assert(+card.slice(2, -1) <= (count === 6 ? 6 : 8)); }
    assert(chooseTrump(r, caller.id, 'S'));
    assert.equal(r.trump.suit, 'H');
  });

  test(`${count} players: complete legal game and previous winners call after team shuffle`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = room(count); beginTrump(r, random(seed));
      assert.equal(chooseTrump(r, r.players[r.currentIndex].id, chooseBotTrump(r.players[r.currentIndex])), '');
      let moves = 0;
      while (!r.winner && moves++ < 105) {
        const p = r.players[r.currentIndex];
        assert.equal(playTrump(r, p.id, [chooseBotTrumpCard(r, p)]), '');
        assert(trumpPublicState(r, p).deckOk);
        resolve(r);
      }
      assert(r.winner); assert(moves <= 104);
      const results = trumpPublicState(r, r.players[0]);
      assert.equal(results.handWins.reduce((sum, p) => sum + p.handsWon, 0), r.trump.completedTricks);
      for (const team of [0, 1]) assert.equal(results.handWins.filter(p => p.team === team).reduce((sum, p) => sum + p.handsWon, 0), r.trump.scores[team]);
      assert.equal(results.handHistory.length, r.trump.completedTricks);
      for (const [i, hand] of results.handHistory.entries()) {
        assert.equal(hand.hand, i + 1);
        assert(results.handWins.some(p => p.playerId === hand.playerId));
        assert(!('card' in hand));
      }
      const winners = [...r.trump.winnerPlayerIds];
      const oldSuit = r.trump.suit;
      assert(chooseTrump(r, r.players[0].id, oldSuit === 'H' ? 'S' : 'H'));
      r.winner = null; beginTrump(r, random(seed + 200));
      if (winners.length) assert(winners.includes(r.players[r.currentIndex].id));
      assert.equal(r.trump.suit, null);
      assert(r.players.every((p, i) => p.hand.length === (i === r.currentIndex ? 5 : 0)));
      assert(trumpPublicState(r, r.players[0]).handWins.every(p => p.handsWon === 0));
      assert.deepEqual(r.trump.handHistory, []);
    }
  });
}

test('follow suit is enforced, only current player plays exactly one owned card', () => {
  const r = room(4); beginTrump(r, random(1)); chooseTrump(r, r.players[r.currentIndex].id, 'H');
  r.currentIndex = 0; r.trump.trick = [{ playerId: '3', card: 'AS', team: 1 }];
  r.players[0].hand = ['3S', 'AH', '4C'];
  assert.deepEqual(legalTrumpCards(r, r.players[0]), ['3S']);
  assert(playTrump(r, '1', ['3S'])); assert(playTrump(r, '0', ['3S', 'AH'])); assert(playTrump(r, '0', ['KS']));
  assert(playTrump(r, '0', ['AH']));
  assert.equal(playTrump(r, '0', ['3S']), '');
  assert.equal(r.currentIndex, 1);
});

test('trump beats ace of led suit; highest trump wins; off-suit ace cannot win', () => {
  const trick = [{ playerId: 'a', card: 'AS' }, { playerId: 'b', card: '3H' }, { playerId: 'c', card: 'KH' }, { playerId: 'd', card: 'AC' }];
  assert.equal(trickWinner(trick, 'H').playerId, 'c');
  assert.equal(trickWinner(trick.filter(p => !p.card.endsWith('H')), 'H').playerId, 'a');
});

test('final card stays visible for three seconds, then winner leads an empty table', () => {
  const r = room(4); beginTrump(r, random(1)); chooseTrump(r, r.players[r.currentIndex].id, 'H'); r.currentIndex = 0;
  r.players.forEach((p, i) => { p.hand = [['AS', '3C'], ['3H', '4C'], ['KS', '5C'], ['QS', '6C']][i]; });
  for (const [id, card] of [['0', 'AS'], ['1', '3H'], ['2', 'KS'], ['3', 'QS']]) assert.equal(playTrump(r, id, [card]), '');
  assert.deepEqual(r.trump.scores, [0, 1]); assert.equal(r.currentIndex, 1); assert.equal(r.trump.trick.length, 4);
  assert.equal(r.trump.phase, 'reveal'); assert.equal(r.winner, null);
  const visible = trumpPublicState(r, r.players[0]); assert.equal(visible.handWinnerId, '1'); assert.equal(visible.lastTrickWinner, 'Player 1'); assert.equal(visible.trick.length, 4); assert.deepEqual(visible.teamScores, [0, 1]); assert.equal(visible.turnDeadline, 0);
  assert.equal(r.trump.handWins['1'], 1); assert.equal(r.trump.handHistory[0].playerId, '1');
  const at = r.trump.resolveAt;
  assert.equal(advanceTrump(r, at - 1), false);
  assert(playTrump(r, '1', ['4C']));
  assert.equal(advanceTrump(r, at), true); assert.equal(r.trump.trick.length, 0);
  assert.equal(r.trump.phase, 'play'); assert.equal(r.trump.deadline, at + TURN_MS);
  assert.equal(r.trump.captured.length, 4); assert.equal(r.trump.lastTrickWinner, 'Player 1');
  assert.equal(r.trump.handWins['1'], 1); assert.equal(r.trump.handHistory.length, 1);
});

test('coat scores three total, not four; even-hand ties are draws', () => {
  const r = room(8); beginTrump(r, random(2)); chooseTrump(r, r.players[r.currentIndex].id, 'H');
  r.currentIndex = 7; r.trump.trick = r.players.slice(0, 7).map((p, i) => ({ playerId: p.id, name: p.name, card: i === 0 ? 'AH' : '3C', team: i % 2 }));
  r.players[7].hand = ['4C']; r.trump.scores = [5, 0]; r.trump.completedTricks = 5;
  playTrump(r, '7', ['4C']); assert.equal(r.winner, null); resolve(r); assert.equal(r.winner, 'Team A'); assert(r.trump.coat); assert.deepEqual(r.trump.points, [3, 0]);
  const d = room(6); beginTrump(d, random(3)); chooseTrump(d, d.players[d.currentIndex].id, 'H');
  d.currentIndex = 5; d.trump.trick = d.players.slice(0, 5).map((p, i) => ({ playerId: p.id, name: p.name, card: i === 0 ? 'AH' : '3C', team: i % 2 }));
  d.players[5].hand = ['4C']; d.trump.scores = [5, 6]; d.trump.completedTricks = 11;
  playTrump(d, '5', ['4C']); resolve(d); assert.equal(d.winner, 'Draw'); assert.deepEqual(d.trump.points, [0, 0]);
});

test('interactive toss waits for a choice, then the winning team selects the caller', () => {
  const r = room(4); startTrump(r, random(1), 1000);
  assert.equal(r.trump.phase, 'tossPick'); assert(r.players.every(p => p.hand.length === 0));
  assert(callTrumpToss(r, '1', 'heads', 1000));
  assert.equal(callTrumpToss(r, '0', 'tails', 1000, () => .25), '');
  assert.equal(r.trump.winningTeam, 1); assert.equal(r.trump.phase, 'toss');
  assert.equal(advanceTrump(r, 3999), false); advanceTrump(r, 4000);
  assert.equal(r.trump.phase, 'caller'); assert(selectTrumpCaller(r, '0', '0', 4000));
  assert.equal(selectTrumpCaller(r, '1', '3', 4000), '');
  assert.equal(r.players[3].hand.length, 5); assert.equal(r.trump.deadline, 4000 + TURN_MS);
  advanceTrump(r, 34000); assert.equal(r.trump.phase, 'review');
  r.players.forEach(p => reviewTrumpHand(r, p.id, 34001)); assert.equal(r.trump.phase, 'play');
});

test('expiry auto-follows suit without consuming an extra turn; duplicate ranks tie first', () => {
  const r = room(8); beginTrump(r, random(8)); chooseTrump(r, r.players[r.currentIndex].id, 'H');
  r.currentIndex = 0; r.trump.trick = [{ playerId: '7', card: 'AS', team: 1 }];
  r.players[0].hand = ['3S', '2:3S', 'AH']; const deadline = r.trump.deadline;
  assert.equal(advanceTrump(r, deadline - 1), false); assert.equal(advanceTrump(r, deadline), true);
  assert.equal(r.trump.trick.at(-1).card.endsWith('S'), true); assert.equal(r.currentIndex, 1);
  assert.equal(advanceTrump(r, deadline), false);
  assert.equal(trickWinner([{ playerId: 'first', card: '3S' }, { playerId: 'second', card: '2:3S' }], 'H').playerId, 'first');
});

test('changed teams reset caller selection to a fresh toss', () => {
  const r = room(6); beginTrump(r, random(9)); r.trump.winnerTeam = 0; r.trump.winnerPlayerIds = ['0', '2', '4'];
  r.teamsChanged = true; startTrump(r, random(10)); assert.equal(r.trump.callerSource, 'toss');
});

test('odd counts and unbalanced selected teams cannot start', () => {
  assert.throws(() => beginTrump(room(5)), /4, 6 or 8/);
  const r = room(4); r.players[1].team = 0; assert.throws(() => beginTrump(r), /equal/);
});

test('finished leaderboard preserves the played teams after lobby team changes', () => {
  const r = room(4); beginTrump(r, random(5));
  chooseTrump(r, r.players[r.currentIndex].id, 'S');
  while (!r.winner) {
    const p = r.players[r.currentIndex]; playTrump(r, p.id, [chooseBotTrumpCard(r, p)]); resolve(r);
  }
  const result = trumpPublicState(r, r.players[0]);
  r.players.forEach(p => { p.team = 1 - p.team; });
  assert.deepEqual(trumpPublicState(r, r.players[0]).handWins, result.handWins);
  assert.deepEqual(trumpPublicState(r, r.players[0]).handHistory, result.handHistory);
});

test('leading trump is unrestricted by default; optional rule follows suit and opens safely', () => {
  const r = room(6); beginTrump(r, random(2)); chooseTrump(r, r.players[r.currentIndex].id, 'H');
  r.currentIndex = 0; r.players[0].hand = ['AH', '3S'];
  assert.deepEqual(legalTrumpCards(r, r.players[0]), ['AH', '3S']);
  r.trump.requireTrumpOpened = true;
  assert.deepEqual(legalTrumpCards(r, r.players[0]), ['3S']); assert.match(playTrump(r, '0', ['AH']), /not open/);
  assert.equal(r.trump.trumpOpened, false);
  assert.equal(playTrump(r, '0', ['3S']), '');
  r.players[1].hand = ['2S', '2:2H']; assert.deepEqual(legalTrumpCards(r, r.players[1]), ['2S']);
  r.players[1].hand = ['2H', '4C']; assert.equal(playTrump(r, '1', ['2H']), ''); assert.equal(r.trump.trumpOpened, true);
  r.trump.trick = []; r.players[2].hand = ['KH', '5D']; assert.deepEqual(legalTrumpCards(r, r.players[2]), ['KH', '5D']);
  r.trump.trumpOpened = false; r.players[2].hand = ['KH', '2:3H']; assert.deepEqual(legalTrumpCards(r, r.players[2]), ['KH', '2:3H']);
  assert.equal(playTrump(r, '2', ['KH']), ''); assert.equal(r.trump.trumpOpened, true);
});

test('extra time belongs to the current human, is once per game and survives a new turn', () => {
  const r = room(4); startTrump(r, random(1), 1000); callTrumpToss(r, '0', 'heads', 1000, () => 0);
  assert(extendTrumpTurn(r, '0', 1001)); advanceTrump(r, 4000); selectTrumpCaller(r, '0', '0', 4000);
  assert(extendTrumpTurn(r, '1', 4001)); assert.equal(extendTrumpTurn(r, '0', 4001), '');
  assert.equal(r.trump.deadline, 4000 + TURN_MS + EXTENSION_MS); assert(extendTrumpTurn(r, '0', 4002));
  chooseTrump(r, '0', 'S', 5000); assert(extendTrumpTurn(r, '0', 5001));
  assert.equal(trumpPublicState(r, r.players[0]).extensionUsed, true);
  r.currentIndex = 1; r.players[1].isBot = true; assert(extendTrumpTurn(r, '1', 5001));
  r.players[1].isBot = false; assert.equal(extendTrumpTurn(r, '1', 5001), '');
  assert(extendTrumpTurn(r, '1', r.trump.deadline)); r.trump.phase = 'reveal'; assert(extendTrumpTurn(r, '1', 5002));
  r.winner = 'Team A'; assert(extendTrumpTurn(r, '1', 5002)); r.winner = null;
  startTrump(r, random(2), 6000); assert.deepEqual(r.trump.extensions, []);
});

test('unfilled lobby exposes no fractional card counts', () => {
  const r = room(1); r.started = false; const s = trumpPublicState(r, r.players[0]);
  assert.equal(s.cardsPerPlayer, 0); assert.equal(s.totalTricks, 0); assert.equal(s.canExtendTurn, false); assert.equal(s.requireTrumpOpened, false);
});
