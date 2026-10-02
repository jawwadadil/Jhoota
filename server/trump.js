const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function trumpSeatError(count) {
  return [4, 6, 8].includes(count) ? '' : 'Trump needs 4, 6 or 8 seats. Add a bot to balance the teams.';
}

export function beginTrump(room, random = Math.random) {
  const error = trumpSeatError(room.players.length);
  if (error) throw new Error(error);
  const a = room.players.filter(p => p.team === 0);
  const b = room.players.filter(p => p.team === 1);
  if (a.length !== b.length || a.length * 2 !== room.players.length) throw new Error('Choose equal Team A and Team B seats before starting.');
  room.players = a.flatMap((p, i) => [p, b[i]]);
  const previous = room.trump;
  const count = room.players.length;
  let caller = Math.floor(random() * count);
  if (previous?.winnerPlayerIds?.some(id => room.players.some(p => p.id === id))) {
    for (let offset = 1; offset <= count; offset++) {
      const candidate = (previous.callerIndex + offset) % count;
      if (previous.winnerPlayerIds.includes(room.players[candidate].id)) { caller = candidate; break; }
    }
  }
  const deck = SUITS.flatMap(suit => RANKS.filter(rank => count === 4 || rank !== '2').map(rank => rank + suit));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = room.players.map(() => []);
  deck.forEach((card, i) => hands[i % count].push(card));
  room.trump = {
    phase: 'choose', suit: null, callerIndex: caller, playerIds: room.players.map(p => p.id),
    reserve: hands.map(hand => hand.slice(5)), trick: [], lastTrick: [], lastTrickWinner: '',
    captured: [], scores: [0, 0], points: previous?.points || [0, 0],
    totalTricks: deck.length / count, completedTricks: 0, winnerTeam: -1, winnerPlayerIds: [], coat: false,
  };
  room.players.forEach((player, i) => { player.hand = hands[i].slice(0, 5).sort(compareCards); });
  room.currentIndex = caller;
  room.log.push(`${room.players[caller].name} ${previous?.winnerTeam >= 0 ? 'calls for the previous winning team' : 'won the toss'}. Choose trump from the first five cards.`);
}

export function chooseTrump(room, playerId, suit) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'choose') return 'Trump has already been called or the game is not running.';
  if (room.players[t.callerIndex].id !== playerId) return 'Only the trump caller can choose the suit.';
  if (!SUITS.includes(suit)) return 'Choose a valid trump suit.';
  t.suit = suit;
  t.phase = 'play';
  room.players.forEach((p, i) => { p.hand.push(...t.reserve[i]); p.hand.sort(compareCards); });
  t.reserve = room.players.map(() => []);
  room.log.push(`${room.players[t.callerIndex].name} called ${suitName(suit)}. Trump stays fixed for this game.`);
  return '';
}

export function legalTrumpCards(room, player) {
  if (room.trump?.phase !== 'play' || room.winner) return [];
  const lead = room.trump.trick[0]?.card.slice(-1);
  const following = lead ? player.hand.filter(card => card.endsWith(lead)) : [];
  return following.length ? following : [...player.hand];
}

export function trickWinner(trick, trump) {
  const lead = trick[0].card.slice(-1);
  const strength = card => (card.endsWith(trump) ? 200 : card.endsWith(lead) ? 100 : 0) + RANKS.indexOf(card.slice(0, -1));
  return trick.reduce((best, play) => strength(play.card) > strength(best.card) ? play : best);
}

export function playTrump(room, playerId, cards) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'play') return 'Wait for trump to be called.';
  const player = room.players[room.currentIndex];
  if (player.id !== playerId) return 'It is not your turn.';
  if (!Array.isArray(cards) || cards.length !== 1 || !player.hand.includes(cards[0])) return 'Play exactly one card from your hand.';
  const card = cards[0];
  if (!legalTrumpCards(room, player).includes(card)) return 'You must follow the led suit while you have it.';
  player.hand.splice(player.hand.indexOf(card), 1);
  t.trick.push({ playerId, name: player.name, card, team: room.currentIndex % 2 });
  room.log.push(`${player.name} played ${card}.`);
  if (t.trick.length < room.players.length) {
    room.currentIndex = (room.currentIndex + 1) % room.players.length;
    return '';
  }
  const winning = trickWinner(t.trick, t.suit);
  room.currentIndex = room.players.findIndex(p => p.id === winning.playerId);
  t.scores[winning.team]++;
  t.completedTricks++;
  t.lastTrick = [...t.trick];
  t.lastTrickWinner = winning.name;
  t.captured.push(...t.trick.map(p => p.card));
  t.trick = [];
  room.log.push(`${winning.name} takes hand ${t.completedTricks}. Team ${winning.team === 0 ? 'A' : 'B'} leads next.`);
  const target = Math.floor(t.totalTricks / 2) + 1;
  if (Math.max(...t.scores) < target && t.completedTricks < t.totalTricks) return '';
  t.phase = 'over';
  if (t.scores[0] === t.scores[1]) {
    room.winner = 'Draw';
    room.winnerReason = `${t.scores[0]}-${t.scores[1]} hands. No points awarded.`;
  } else {
    t.winnerTeam = t.scores[0] > t.scores[1] ? 0 : 1;
    t.winnerPlayerIds = room.players.filter((p, i) => i % 2 === t.winnerTeam).map(p => p.id);
    t.coat = t.scores[1 - t.winnerTeam] === 0;
    t.points[t.winnerTeam] += t.coat ? 3 : 1;
    room.winner = `Team ${t.winnerTeam === 0 ? 'A' : 'B'}`;
    room.players.forEach((p, i) => { if (i % 2 === t.winnerTeam) p.wins = (p.wins || 0) + 1; });
    room.winnerReason = `${t.scores[0]}-${t.scores[1]} hands${t.coat ? ' - Coat! 3 points.' : ' - 1 point.'}`;
  }
  room.log.push(`${room.winner}. ${room.winnerReason}`);
  return '';
}

export function trumpPublicState(room, viewer) {
  const t = room.trump;
  const caller = t && room.players[t.callerIndex];
  return {
    gameType: 'trump', trumpSuit: t?.suit || '', trumpPhase: t?.phase || 'lobby',
    trumpCallerId: caller?.id || '', trumpCallerName: caller?.name || '',
    teamScores: t?.scores || [0, 0], teamPoints: t?.points || [0, 0],
    totalTricks: t?.totalTricks || (room.players.length === 4 ? 13 : room.players.length === 6 ? 8 : 6),
    completedTricks: t?.completedTricks || 0, trick: t?.trick || [],
    lastTrick: t?.lastTrick || [], lastTrickWinner: t?.lastTrickWinner || '', coat: Boolean(t?.coat),
    legalCards: room.players[room.currentIndex]?.id === viewer.id ? legalTrumpCards(room, viewer) : [],
    centerCount: t?.trick.length || 0, phase: room.winner ? 'Game over' : t?.phase === 'choose' ? 'Choose trump' : room.started ? 'Playing' : 'Lobby',
    totalKnownCards: t ? t.captured.length + t.trick.length + room.players.reduce((sum, p) => sum + p.hand.length, 0) + t.reserve.reduce((sum, h) => sum + h.length, 0) : 0,
    deckOk: !t || t.captured.length + t.trick.length + room.players.reduce((sum, p) => sum + p.hand.length, 0) + t.reserve.reduce((sum, h) => sum + h.length, 0) === (room.players.length === 4 ? 52 : 48),
  };
}

export function chooseBotTrump(player) {
  return SUITS.reduce((best, suit) => {
    const value = s => player.hand.filter(c => c.endsWith(s)).reduce((sum, c) => sum + 14 + RANKS.indexOf(c.slice(0, -1)), 0);
    return value(suit) > value(best) ? suit : best;
  }, 'S');
}

export function chooseBotTrumpCard(room, player, random = Math.random) {
  const cards = legalTrumpCards(room, player).sort(compareCards);
  if (player.difficulty === 'Low') return cards[Math.floor(random() * cards.length)];
  const trick = room.trump.trick;
  if (!trick.length) return player.difficulty === 'Pro' ? cards.at(-1) : cards[0];
  const best = trickWinner(trick, room.trump.suit);
  if (best.team === room.currentIndex % 2 && player.difficulty === 'Pro') return cards[0];
  return cards.find(card => trickWinner([...trick, { card, playerId: player.id }], room.trump.suit).playerId === player.id) || cards[0];
}

function compareCards(a, b) { return a.slice(-1).localeCompare(b.slice(-1)) || RANKS.indexOf(a.slice(0, -1)) - RANKS.indexOf(b.slice(0, -1)); }
function suitName(suit) { return { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[suit]; }
