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
    let state, errors = [], timers = new Map(), next = 0, now = 1000;
    const context = vm.createContext({ window: { OfflineBridge: {
      state: value => { state = JSON.parse(value); }, error: value => errors.push(value),
    } }, Date: class extends Date { static now() { return now; } }, setTimeout: (fn, delay) => { timers.set(++next, { fn, at: now + delay }); return next; }, clearTimeout: id => timers.delete(id) });
    vm.runInContext(rules.replaceAll('export function ', 'function ').replaceAll('export const ', 'const ') + '\n' + glue, context);
    context.window.OfflineTrump.start({ count, difficulty, name: 'You', avatarIndex: 8, requireTrumpOpened: difficulty === 'Pro' });
    assert.equal(state.hand.length, 5); assert.equal(state.offline, true);
    assert.equal(state.requireTrumpOpened, difficulty === 'Pro');
    let moves = 0, extended = false;
    while (!state.winner && moves++ < 150) {
      assert.equal(state.deckOk, true); assert.equal(state.playerCount, count);
      assert.equal(state.totalKnownCards, count === 4 ? 52 : count === 6 ? 72 : 80);
      assert(!('reserve' in state)); assert(state.players.every(p => !('hand' in p)));
      if (state.currentPlayerId === 'you' && ['choose', 'play'].includes(state.trumpPhase)) {
        if (!extended) {
          const deadline = state.turnDeadline; assert.equal(state.canExtendTurn, true);
          context.window.OfflineTrump.action('extend', ''); assert.equal(state.turnDeadline, deadline + 15000); assert.equal(state.extensionUsed, true); assert.equal(state.canExtendTurn, false);
          context.window.OfflineTrump.action('extend', ''); assert.match(errors.pop(), /already been used/); extended = true;
        }
        if (state.trumpPhase === 'choose') context.window.OfflineTrump.action('trump', 'H');
        else context.window.OfflineTrump.action('play', JSON.stringify({ cards: [state.legalCards[0]] }));
      } else {
        const [id, task] = timers.entries().next().value; timers.delete(id); now = task.at; task.fn();
      }
    }
    assert(state.winner); assert.deepEqual(errors, []);
    const oldTeam = state.players.find(p => p.id === 'you').team;
    context.window.OfflineTrump.action('team', String(1 - oldTeam));
    assert.equal(state.players.find(p => p.id === 'you').team, 1 - oldTeam);
    assert.equal(state.players.filter(p => p.team === 0).length, count / 2);
    context.window.OfflineTrump.action('shuffle', '');
    assert.equal(state.players.filter(p => p.team === 0).length, count / 2);
    context.window.OfflineTrump.action('trumpLeadRule', 'true'); assert.equal(state.requireTrumpOpened, true);
    context.window.OfflineTrump.action('start', '');
    assert.equal(state.roundNumber, 2); assert.equal(state.hand.length, 5); assert.equal(state.winner, '');
    assert.equal(state.requireTrumpOpened, true); assert.equal(state.extensionUsed, false);
  });
}
