import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTrump, callTrumpToss, selectTrumpCaller, chooseTrump, reviewTrumpHand, requestTrumpRedeal, catchTrumpCheat, playTrump, legalTrumpCards, chooseBotTrumpCard, chooseBotTrump, takeTrumpBotTurn, advanceTrump, trumpPublicState, trumpDeck } from '../trump.js';

function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function opening(count = 4, seed = 1) {
  const room = { started: true, cheatingAllowed: true, log: [], players: Array.from({ length: count }, (_, i) => ({ id: String(i), name: 'Player ' + i, team: i % 2, hand: [], difficulty: 'Pro' })) };
  beginTrump(room, rng(seed), 1000); callTrumpToss(room, '0', 'heads', 1000, () => 0); advanceTrump(room, 4000); selectTrumpCaller(room, '0', '0', 4000);
  return room;
}
function playing(count = 4, seed = 1) {
  const r = opening(count, seed);
  for (let i = 0; r.trump.phase === 'choose' && i < 100; i++) chooseTrump(r, '0', 'H', 4000);
  r.players.forEach(p => reviewTrumpHand(r, p.id, 4000)); return r;
}
function cheatFixture() {
  const r = playing(); r.currentIndex = 0;
  r.players[0].hand = ['AH', '3H', '2C'];
  r.trump.trick = [{ playerId: '3', name: 'Player 3', team: 1, card: 'KH' }]; return r;
}

test('weak caller first five are openly redealt, not other players hands', () => {
  let found = false;
  for (let seed = 1; seed <= 500 && !found; seed++) {
    const r = opening(4, seed);
    assert(r.players[0].hand.some(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.slice(0, -1))));
    assert(r.players.slice(1).every(p => p.hand.length === 0));
    if (r.trump.reshuffleCount) { found = true; assert.match(r.trump.reshuffleReason, /below 10/); assert(r.log.some(line => line.includes('below 10'))); }
  }
  assert(found);
});

test('seven trump cards automatically redeal before full hands are published', () => {
  const r = opening(); const hand = ['AH', 'KH', 'QH', 'JH', '10H']; r.players[0].hand = hand;
  // Deal the remaining hearts into the caller's next slots without changing the deck.
  const remaining = trumpDeck(4).filter(c => !hand.includes(c));
  const hearts = remaining.filter(c => c.endsWith('H')), others = remaining.filter(c => !c.endsWith('H'));
  const order = [], counts = [5, 0, 0, 0]; let seat = 1;
  while (order.length < remaining.length) {
    while (counts[seat] >= 13) seat = (seat + 1) % 4;
    order.push(seat === 0 && hearts.length ? hearts.shift() : others.length ? others.shift() : hearts.shift()); counts[seat]++; seat = (seat + 1) % 4;
  }
  r.trump.undealt = order; chooseTrump(r, '0', 'H', 5000);
  assert.equal(r.trump.phase, 'choose'); assert.equal(r.trump.suit, null); assert.match(r.trump.reshuffleReason, /seven or more trump/);
  assert(r.players.slice(1).every(p => p.hand.length === 0)); assert(trumpPublicState(r, r.players[0]).deckOk);
});

test('seven non-trump suit is a verified optional request and closes at first play', () => {
  const r = playing(); r.trump.phase = 'review'; r.players[1].hand = ['2S','3S','4S','5S','6S','7S','8S','AH'];
  assert.equal(trumpPublicState(r, r.players[1]).canRequestRedeal, true);
  assert(requestTrumpRedeal(r, '2', 5000)); assert.equal(requestTrumpRedeal(r, '1', 5000), '');
  assert.equal(r.trump.phase, 'choose'); assert.equal(r.trump.callerIndex, 0); assert.match(r.trump.reshuffleReason, /Player 1/);
  const p = playing(); assert(requestTrumpRedeal(p, '0', 5000));
});

test('saved card is private, once per player, and ordinary matching cards must follow', () => {
  const r = cheatFixture(); assert.equal(playTrump(r, '0', ['2C'], 5000, 'AH'), '');
  assert.equal(trumpPublicState(r, r.players[0]).hiddenCard, 'AH');
  const opponent = trumpPublicState(r, r.players[1]); assert.equal(opponent.hiddenCard, ''); assert.equal(opponent.cheatingUsed, false); assert(!('cheatEvidence' in opponent));
  r.currentIndex = 0; r.players[0].hand.push('4C');
  assert.deepEqual(legalTrumpCards(r, r.players[0]).sort(), ['3H', 'AH'].sort());
  assert(playTrump(r, '0', ['4C'], 6000)); assert(playTrump(r, '0', ['4C'], 6000, '3H'));
});

test('protected only heart allows discarding, but the last remaining card and timeouts can use it', () => {
  const r = cheatFixture(); playTrump(r, '0', ['2C'], 5000, 'AH'); r.currentIndex = 0;
  r.players[0].hand = ['AH','3C'];
  assert.deepEqual(legalTrumpCards(r, r.players[0]).sort(), ['AH','3C'].sort());
  assert.equal(chooseBotTrumpCard(r, r.players[0], () => 0), '3C');
  r.players[0].hand = ['AH']; assert.deepEqual(legalTrumpCards(r, r.players[0]), ['AH']);
  r.trump.deadline = 6000; advanceTrump(r, 6000); assert.equal(r.trump.trick.at(-1).card, 'AH'); assert.equal(r.players[0].hand.length, 0);
  assert.equal(r.trump.hiddenCards['0'], undefined); assert(r.trump.cheatEvidence['0']);
});

test('playing saved card does not erase evidence and an opponent wins immediately on catch', () => {
  const r = cheatFixture(); playTrump(r, '0', ['2C'], 5000, 'AH'); r.currentIndex = 0; playTrump(r, '0', ['AH'], 6000);
  assert(catchTrumpCheat(r, '2', '0', 6001));
  assert.equal(catchTrumpCheat(r, '1', '0', 6001), ''); assert.equal(r.winner, 'Team B'); assert.equal(r.trump.coat, false);
  assert.deepEqual(r.trump.scores, [0,0]); assert.equal(r.trump.verdict.evidence.hiddenCard, 'AH'); assert.match(r.winnerReason, /catching a cheat/);
});

test('wrong accusation pauses then restores the exact remaining turn time, only once', () => {
  const r = playing(); r.trump.deadline = 12000;
  assert.equal(catchTrumpCheat(r, '1', '0', 7000), ''); assert.equal(r.trump.phase, 'accusation'); assert.equal(r.trump.deadline, 0);
  assert.equal(advanceTrump(r, 8999), false); advanceTrump(r, 9000);
  assert.equal(r.trump.phase, 'play'); assert.equal(r.trump.deadline, 14000);
  assert.match(catchTrumpCheat(r, '1', '0', 9001), /already used/); assert.equal(r.winner, undefined);
});

test('cheating disabled and invalid hidden card reject without consuming allowance', () => {
  const r = cheatFixture(); r.trump.cheatingAllowed = false; assert(playTrump(r, '0', ['2C'], 5000, 'AH'));
  r.trump.cheatingAllowed = true; assert(playTrump(r, '0', ['2C'], 5000, 'AS')); assert(playTrump(r, '0', ['3H'], 5000, 'AH'));
  assert.deepEqual(r.trump.cheatEvidence, {}); assert.deepEqual(r.players[0].hand, ['AH','3H','2C']);
});

test('final hand gives a challenge window and retains winner evidence', () => {
  const r = cheatFixture(); playTrump(r, '0', ['2C'], 5000, 'AH'); r.trump.phase = 'reveal'; r.trump.gameComplete = true; r.trump.resolveAt = 7000;
  advanceTrump(r, 7000); assert.equal(r.trump.phase, 'finishChallenge'); assert(!r.winner);
  assert(trumpPublicState(r, r.players[1]).canCatchCheat);
  catchTrumpCheat(r, '1', '0', 11000); assert.equal(r.winner, 'Team B');
});

test('Pro avoids feeding a known void suit and does not inspect opponents hands', () => {
  const r = playing(); r.currentIndex = 0; r.players[0].hand = ['AS','AC'];
  r.trump.trickHistory = [{ leadSuit: 'S', cards: [{ playerId:'0',team:0,card:'KS' }, {playerId:'1',team:1,card:'2H'}] }];
  for (const p of r.players.slice(1)) Object.defineProperty(p, 'hand', { get() { throw Error('Private opponent hand read'); } });
  assert.equal(chooseBotTrumpCard(r, r.players[0], () => 0), 'AC');
});

test('Pro supports winning partner and spends the cheapest winning card', () => {
  const r = playing(); r.currentIndex=0; r.players[0].hand=['2S','QS','AS'];
  r.trump.trick=[{playerId:'2',team:0,card:'KS'}]; assert.equal(chooseBotTrumpCard(r,r.players[0]),'2S');
  r.trump.trick=[{playerId:'1',team:1,card:'JS'}]; assert.equal(chooseBotTrumpCard(r,r.players[0]),'QS');
});

test('equal trump choices vary without a fixed spade bias', () => {
  const p = { hand:['AS','AH','AD','AC'] }; assert.equal(chooseBotTrump(p,()=>0),'S'); assert.equal(chooseBotTrump(p,()=>.99),'C');
});

test('bots stay honest; Pro only catches a cheat from public historical proof', () => {
  const r=playing(); r.currentIndex=1; r.players[1].isBot=true;
  r.trump.cheatEvidence['0']={playerId:'0',leadSuit:'H',playedCard:'2C',hiddenCard:'AH',hand:1};
  r.trump.trickHistory=[{leadSuit:'H',cards:[{playerId:'3',team:1,card:'KH'},{playerId:'0',team:0,card:'2C'}]}];
  takeTrumpBotTurn(r,5000); assert(!r.winner); assert(!r.trump.cheatEvidence['1']);
  r.currentIndex=1; r.trump.phase='play'; r.trump.trickHistory.push({leadSuit:'H',cards:[{playerId:'0',team:0,card:'AH'}]});
  takeTrumpBotTurn(r,6000); assert.equal(r.winner,'Team B');
});

for (const count of [4,6,8]) for (const difficulty of ['Low','Medium','Pro']) test(`${count} ${difficulty}: 30 full deals, every move legal, all histories and tied Baap awards correct`, () => {
  for (let seed=1; seed<=30; seed++) {
    const r=playing(count,seed); r.trump.cheatingAllowed=false; let moves=0;
    while (!r.winner && moves++<110) {
      const p=r.players[r.currentIndex]; p.difficulty=difficulty; const card=chooseBotTrumpCard(r,p,rng(seed+moves));
      const lead=r.trump.trick[0]?.card.slice(-1); if (lead && p.hand.some(c=>c.endsWith(lead))) assert(card.endsWith(lead));
      assert.equal(playTrump(r,p.id,[card],5000+moves),'');
      if(r.trump.phase==='reveal') advanceTrump(r,r.trump.resolveAt);
    }
    assert(r.winner); const state=trumpPublicState(r,r.players[0]); assert(state.deckOk);
    assert.equal(state.trickHistory.length,state.completedTricks); assert(state.trickHistory.every(h=>h.cards.length===count));
    const best=Math.max(...state.handWins.map(p=>p.handsWon));
    assert.deepEqual(state.baapPlayerIds.sort(),state.handWins.filter(p=>p.handsWon===best).map(p=>p.playerId).sort());
  }
});
