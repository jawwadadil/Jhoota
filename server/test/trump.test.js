import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTrump, chooseTrump, playTrump, legalTrumpCards, trickWinner, trumpPublicState, chooseBotTrumpCard, chooseBotTrump } from '../trump.js';

function room(count) {
  return { started: true, winner: null, log: [], players: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Player ${i}`, team: i % 2, hand: [], wins: 0, difficulty: 'Pro' })) };
}
function random(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }

for (const count of [4, 6, 8]) {
  test(`${count} players: exactly five visible cards, private reserve, equal complete deal`, () => {
    const r = room(count); beginTrump(r, random(count));
    assert(r.players.every(p => p.hand.length === 5));
    const snapshot = trumpPublicState(r, r.players[0]);
    assert(!('reserve' in snapshot));
    assert(snapshot.deckOk);
    const caller = r.players[r.currentIndex];
    assert.equal(chooseTrump(r, r.players[(r.currentIndex + 1) % count].id, 'S'), 'Only the trump caller can choose the suit.');
    assert(chooseTrump(r, caller.id, 'X'));
    assert.equal(chooseTrump(r, caller.id, 'H'), '');
    assert(r.players.every(p => p.hand.length === (count === 4 ? 13 : count === 6 ? 8 : 6)));
    const cards = r.players.flatMap(p => p.hand);
    assert.equal(new Set(cards).size, count === 4 ? 52 : 48);
    if (count !== 4) assert(!cards.some(c => c.startsWith('2')));
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
      }
      assert(r.winner); assert(moves <= 104);
      const winners = [...r.trump.winnerPlayerIds];
      const oldSuit = r.trump.suit;
      assert(chooseTrump(r, r.players[0].id, oldSuit === 'H' ? 'S' : 'H'));
      r.players.forEach(p => { p.team = 1 - p.team; });
      r.winner = null; beginTrump(r, random(seed + 200));
      if (winners.length) assert(winners.includes(r.players[r.currentIndex].id));
      assert.equal(r.trump.suit, null);
      assert(r.players.every(p => p.hand.length === 5));
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

test('winner collects each hand immediately and leads the next one', () => {
  const r = room(4); beginTrump(r, random(1)); chooseTrump(r, r.players[r.currentIndex].id, 'H'); r.currentIndex = 0;
  r.players.forEach((p, i) => { p.hand = [['AS', '3C'], ['3H', '4C'], ['KS', '5C'], ['QS', '6C']][i]; });
  for (const [id, card] of [['0', 'AS'], ['1', '3H'], ['2', 'KS'], ['3', 'QS']]) assert.equal(playTrump(r, id, [card]), '');
  assert.deepEqual(r.trump.scores, [0, 1]); assert.equal(r.currentIndex, 1); assert.equal(r.trump.trick.length, 0);
  assert.equal(r.trump.captured.length, 4); assert.equal(r.trump.lastTrickWinner, 'Player 1');
});

test('coat scores three total, not four; even-hand ties are draws', () => {
  const r = room(8); beginTrump(r, random(2)); chooseTrump(r, r.players[r.currentIndex].id, 'H');
  r.currentIndex = 7; r.trump.trick = r.players.slice(0, 7).map((p, i) => ({ playerId: p.id, name: p.name, card: i === 0 ? 'AH' : '3C', team: i % 2 }));
  r.players[7].hand = ['4C']; r.trump.scores = [3, 0]; r.trump.completedTricks = 3;
  playTrump(r, '7', ['4C']); assert.equal(r.winner, 'Team A'); assert(r.trump.coat); assert.deepEqual(r.trump.points, [3, 0]);
  const d = room(8); beginTrump(d, random(3)); chooseTrump(d, d.players[d.currentIndex].id, 'H');
  d.currentIndex = 7; d.trump.trick = d.players.slice(0, 7).map((p, i) => ({ playerId: p.id, name: p.name, card: i === 0 ? 'AH' : '3C', team: i % 2 }));
  d.players[7].hand = ['4C']; d.trump.scores = [2, 3]; d.trump.completedTricks = 5;
  playTrump(d, '7', ['4C']); assert.equal(d.winner, 'Draw'); assert.deepEqual(d.trump.points, [0, 0]);
});

test('odd counts and unbalanced selected teams cannot start', () => {
  assert.throws(() => beginTrump(room(5)), /4, 6 or 8/);
  const r = room(4); r.players[1].team = 0; assert.throws(() => beginTrump(r), /equal/);
});
