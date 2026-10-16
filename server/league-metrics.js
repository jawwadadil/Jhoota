export function emptyRecord() {
  return { games: 0, wins: 0, draws: 0, streak: 0, bestStreak: 0, hands: 0, baap: 0 };
}

export function addResult(old, result) {
  const row = { ...emptyRecord(), ...old };
  row.games++;
  row.wins += result.win ? 1 : 0;
  row.draws += result.draw ? 1 : 0;
  row.streak = result.win ? row.streak + 1 : 0;
  row.bestStreak = Math.max(row.bestStreak, row.streak);
  row.hands += result.hands;
  row.baap += result.baap ? 1 : 0;
  return row;
}

// Capture server-owned results before a rematch can replace the deal.
export function verifiedResult(room) {
  const leagueId = room.matchLeagueId ?? room.leagueId;
  if (!room.winner || !room.matchId || !leagueId || !room.matchAccounts || room.players.some(p => p.isBot)) return null;
  const seats = room.matchAccounts;
  if (seats.length < 2 || seats.some(p => p.isBot || !p.uid) || new Set(seats.map(p => p.uid)).size !== seats.length) return null;
  const mode = room.gameType === 'trump' ? 'trump' : 'bluff';
  const draw = room.winner === 'Draw';
  const hands = room.trump?.handWins || {};
  const most = Math.max(0, ...Object.values(hands));
  return {
    id: room.matchId, leagueId, mode, finishedAt: Date.now(),
    winner: room.winner, scores: [...(room.trump?.scores || [])], variant: room.trump?.variant || '',
    players: seats.map(p => ({ uid: p.uid, name: p.name, avatar: p.avatarIndex, team: p.team,
      win: !draw && (mode === 'trump' ? p.team === room.trump.winnerTeam : p.id === room.winnerId),
      draw, hands: mode === 'trump' ? hands[p.id] || 0 : 0,
      baap: mode === 'trump' && most > 0 && hands[p.id] === most }))
  };
}

export function publicRecord(record) {
  const row = { ...emptyRecord(), ...record };
  return { ...row, losses: row.games - row.wins - row.draws,
    winRate: row.games ? Math.round(row.wins / row.games * 100) : 0, provisional: row.games < 5 };
}

export function leagueNight(time) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(time - 4 * 60 * 60 * 1000));
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

export function sharedMatchProfile(rooms, uid, target) {
  return [...rooms.values()].some(r => r.matchAccounts?.some(p => p.uid === uid) && r.matchAccounts?.some(p => p.uid === target));
}
