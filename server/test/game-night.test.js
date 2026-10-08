import test from 'node:test';
import assert from 'node:assert/strict';
import { beginSeriesGame, setSeries, recordNightResult, gameNightState } from '../game-night.js';

function room() { return { id: '123456', nightId: 'night', hostId: 'a', gameType: 'trump', players: [{ id: 'a', name: 'Jawwad', team: 0 }, { id: 'b', name: 'Musab', team: 1 }], trump: { winnerTeam: 0, handWins: { a: 4, b: 3 } } }; }
test('series authorisation, validation and game-night result idempotence', () => {
  const r = room(); assert(setSeries(r, 'b', 3)); assert(setSeries(r, 'a', 4)); assert.equal(setSeries(r, 'a', 3), '');
  beginSeriesGame(r); r.started = true; r.winner = 'Team A'; r.matchId = 'first'; recordNightResult(r); recordNightResult(r);
  assert.equal(r.night.games, 1); assert.equal(r.night.players.a.baap, 1); assert.equal(r.series.wins['team-0'], 1);
  r.matchId = 'second'; recordNightResult(r); assert.equal(r.series.complete, true); assert.equal(r.series.champion, 'Team A');
  const state = gameNightState(r); state.gameNight.players[0].wins = 999; assert.equal(r.night.players.a.wins, 2);
  beginSeriesGame(r); assert.equal(r.series.games, 0); assert.equal(r.night.games, 2);
});
test('draws, joint Baap awards and changed teams', () => {
  const r = room(); setSeries(r, 'a', 5); beginSeriesGame(r);
  r.winner = 'Draw'; r.matchId = 'draw'; r.trump.handWins = { a: 3, b: 3 }; recordNightResult(r);
  assert.equal(r.night.players.a.wins, 0); assert.equal(r.night.players.b.baap, 1); assert.deepEqual(r.series.wins, {});
  r.players[0].team = 1; r.players[1].team = 0; beginSeriesGame(r); assert.equal(r.series.games, 0);
});
test('Bluff best of three can end with joint session winners', () => {
  const r = room(); r.gameType = 'bluff'; r.trump = null; r.players.push({ id: 'c', name: 'Haris' }); setSeries(r, 'a', 3); beginSeriesGame(r);
  for (const id of ['a', 'b', 'c']) { r.matchId = id; r.winner = id; r.winnerId = id; recordNightResult(r); }
  assert.equal(r.series.complete, true); assert.equal(r.series.champion, 'Jawwad & Musab & Haris');
});
