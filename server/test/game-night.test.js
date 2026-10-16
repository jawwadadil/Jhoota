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

test('Trump tally survives Play Again, completed series, seat order and host changes', () => {
  const r = room(); r.trump.scores = [7, 4]; setSeries(r, 'a', 3); beginSeriesGame(r);
  const contestId = gameNightState(r).teamMatchTally?.contestId; assert(contestId);
  for (const matchId of ['one', 'two']) { r.matchId = matchId; r.winner = 'Team A'; recordNightResult(r); }
  assert.equal(r.series.complete, true); r.hostId = 'b'; r.players.reverse(); beginSeriesGame(r); assert.equal(r.series.games, 0);
  r.matchId = 'three'; r.winner = 'Team B'; r.trump.winnerTeam = 1; r.trump.scores = [3, 7]; recordNightResult(r);
  const tally = gameNightState(r).teamMatchTally;
  assert.equal(tally.contestId, contestId); assert.equal(tally.games, 3); assert.deepEqual(tally.wins, [2, 1]); assert.equal(tally.draws, 0);
  assert.deepEqual(tally.history[2], { matchId: 'three', gameNumber: 3, winner: 'Team B', winnerTeam: 1, teamScores: [3, 7] });
  tally.history[0].teamScores[0] = 999; tally.wins[0] = 999;
  assert.deepEqual(gameNightState(r).teamMatchTally.history[0].teamScores, [7, 4]); assert.deepEqual(gameNightState(r).teamMatchTally.wins, [2, 1]);
  assert.equal(r.night.games, 3);
});

test('Trump tally counts draws and deduplicates nonconsecutive match IDs', () => {
  const r = room(); beginSeriesGame(r); r.matchId = 'win'; r.winner = 'Team A'; recordNightResult(r);
  r.matchId = 'draw'; r.winner = 'Draw'; r.trump.scores = [6, 6]; recordNightResult(r);
  r.matchId = 'win'; r.winner = 'Team A'; recordNightResult(r);
  const tally = gameNightState(r).teamMatchTally; assert(tally);
  assert.equal(tally.games, 2); assert.deepEqual(tally.wins, [1, 0]); assert.equal(tally.draws, 1);
  assert.equal(tally.history[1].winnerTeam, -1); assert.equal(r.night.games, 2);
});

test('Trump tally resets only at start on exact roster or team changes, preserving individual records', () => {
  const r = room(); beginSeriesGame(r); r.matchId = 'one'; r.winner = 'Team A'; recordNightResult(r);
  const first = gameNightState(r).teamMatchTally?.contestId; assert(first);
  r.players[0].name = 'Renamed'; r.players[0].avatarIndex = 7; beginSeriesGame(r); assert.equal(gameNightState(r).teamMatchTally.contestId, first);
  r.players.forEach(p => { p.team = 1 - p.team; }); assert.equal(gameNightState(r).teamMatchTally.games, 1); beginSeriesGame(r);
  const second = gameNightState(r).teamMatchTally.contestId; assert.notEqual(second, first); assert.equal(gameNightState(r).teamMatchTally.games, 0);
  r.players[0].id = 'replacement'; beginSeriesGame(r); assert.notEqual(gameNightState(r).teamMatchTally.contestId, second);
  assert.equal(r.night.games, 1); assert.equal(r.night.players.a.wins, 1);
});

test('Trump tally bounds history without losing total wins; Bluff has no team tally', () => {
  const r = room(); beginSeriesGame(r);
  for (let i = 1; i <= 30; i++) { r.matchId = `game-${i}`; r.winner = 'Team A'; recordNightResult(r); }
  const tally = gameNightState(r).teamMatchTally; assert(tally);
  assert.equal(tally.games, 30); assert.deepEqual(tally.wins, [30, 0]); assert(tally.history.length <= 20); assert.equal(tally.history.at(-1).gameNumber, 30);
  const bluff = room(); bluff.gameType = 'bluff'; beginSeriesGame(bluff); assert.equal(gameNightState(bluff).teamMatchTally, null);
});

test('replacing a human seat with a bot resets the exact-roster tally', () => {
 const r=room();beginSeriesGame(r);r.matchId='human-match';r.winner='Team A';recordNightResult(r);
 const previous=gameNightState(r).teamMatchTally.contestId;
 r.players[1].isBot=true;beginSeriesGame(r);
 assert.notEqual(gameNightState(r).teamMatchTally.contestId,previous);
 assert.equal(gameNightState(r).teamMatchTally.games,0);
 assert.equal(r.night.games,1);
});
