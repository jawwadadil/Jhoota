const validLengths = [0, 3, 5];

export function setSeries(room, actor, length) {
  if (actor !== room.hostId || room.started && !room.winner) return 'Only the host can change the series in the lobby.';
  if (!validLengths.includes(length)) return 'Choose a single game, best of 3 or best of 5.';
  room.seriesLength = length;
  room.series = null;
  room.players.forEach(p => { if (!p.isBot) p.ready = false; });
  return '';
}

export function beginSeriesGame(room) {
  const roster = room.players.map(p => `${p.id}:${room.gameType === 'trump' ? p.team : '-'}`).sort().join('|');
  if (!room.series || room.series.roster !== roster || room.series.complete) {
    room.series = { roster, length: room.seriesLength || 0, games: 0, wins: {}, complete: false, champion: '' };
  }
}

export function recordNightResult(room) {
  if (!room.winner || !room.matchId || room.nightRecordedMatch === room.matchId) return;
  room.nightRecordedMatch = room.matchId;
  room.night = room.night || { games: 0, players: {} };
  room.night.games++;
  const handWins = room.trump?.handWins || {};
  const best = Math.max(0, ...Object.values(handWins));
  const team = room.trump?.winnerTeam;
  for (const player of room.players) {
    const row = room.night.players[player.id] ||= { playerId: player.id, name: player.name, avatarIndex: player.avatarIndex, wins: 0, hands: 0, baap: 0, games: 0 };
    row.name = player.name; row.avatarIndex = player.avatarIndex; row.games++;
    if (room.gameType === 'trump' ? room.winner !== 'Draw' && player.team === team : player.id === room.winnerId) row.wins++;
    row.hands += handWins[player.id] || 0;
    if (room.gameType === 'trump' && best > 0 && handWins[player.id] === best) row.baap++;
  }
  const series = room.series;
  if (!series || !series.length) return;
  series.games++;
  const key = room.gameType === 'trump' ? room.winner === 'Draw' ? '' : `team-${team}` : room.winnerId;
  if (key) series.wins[key] = (series.wins[key] || 0) + 1;
  const needed = Math.floor(series.length / 2) + 1;
  if (key && series.wins[key] >= needed) {
    series.complete = true;
    series.champion = room.winner;
  } else if (room.gameType !== 'trump' && series.games >= series.length) {
    series.complete = true;
    const most = Math.max(0, ...Object.values(series.wins));
    series.champion = room.players.filter(p => series.wins[p.id] === most).map(p => p.name).join(' & ');
  }
}

export function gameNightState(room) {
  return {
    seriesLength: room.seriesLength || 0,
    series: room.series ? { length: room.series.length, games: room.series.games, wins: { ...room.series.wins }, complete: room.series.complete, champion: room.series.champion } : null,
    gameNight: { id: room.nightId || room.id, games: room.night?.games || 0, players: Object.values(room.night?.players || {}).map(p => ({ ...p })).sort((a, b) => b.wins - a.wins || b.baap - a.baap || b.hands - a.hands || a.name.localeCompare(b.name)) },
  };
}
