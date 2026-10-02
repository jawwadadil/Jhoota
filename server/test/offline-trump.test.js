import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const rules = readFileSync(new URL('../trump.js', import.meta.url), 'utf8');
const asset = new URL('../../app/src/main/assets/trump.js', import.meta.url);
const glue = readFileSync(new URL('../offline-trump.js', import.meta.url), 'utf8');
test('local APK assets match the tested offline rules', { skip: !existsSync(asset) }, () => {
  assert.equal(readFileSync(asset, 'utf8'), rules);
  assert.equal(readFileSync(new URL('../../app/src/main/assets/offline-trump.js', import.meta.url), 'utf8'), glue);
});
for (const count of [4, 6, 8]) for (const difficulty of ['Low', 'Medium', 'Pro']) {
  test(`offline ${count} seats ${difficulty}: full game, team swap and rematch`, () => {
    let state, errors = [], timers = new Map(), next = 0;
    const context = vm.createContext({ window: { OfflineBridge: {
      state: value => { state = JSON.parse(value); }, error: value => errors.push(value),
    } }, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
    vm.runInContext(rules.replaceAll('export function ', 'function ') + '\n' + glue, context);
    context.window.OfflineTrump.start({ count, difficulty, name: 'You', avatarIndex: 8 });
    assert.equal(state.hand.length, 5); assert.equal(state.offline, true);
    let moves = 0;
    while (!state.winner && moves++ < 110) {
      assert.equal(state.deckOk, true); assert.equal(state.playerCount, count);
      assert.equal(state.totalKnownCards, count === 4 ? 52 : 48);
      assert(!('reserve' in state)); assert(state.players.every(p => !('hand' in p)));
      if (state.currentPlayerId === 'you') {
        if (state.trumpPhase === 'choose') context.window.OfflineTrump.action('trump', 'H');
        else context.window.OfflineTrump.action('play', JSON.stringify({ cards: [state.legalCards[0]] }));
      } else {
        const [id, fn] = timers.entries().next().value; timers.delete(id); fn();
      }
    }
    assert(state.winner); assert.deepEqual(errors, []);
    const oldTeam = state.players.find(p => p.id === 'you').team;
    context.window.OfflineTrump.action('team', String(1 - oldTeam));
    assert.equal(state.players.find(p => p.id === 'you').team, 1 - oldTeam);
    assert.equal(state.players.filter(p => p.team === 0).length, count / 2);
    context.window.OfflineTrump.action('shuffle', '');
    assert.equal(state.players.filter(p => p.team === 0).length, count / 2);
    context.window.OfflineTrump.action('start', '');
    assert.equal(state.roundNumber, 2); assert.equal(state.hand.length, 5); assert.equal(state.winner, '');
  });
}
