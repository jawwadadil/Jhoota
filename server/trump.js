const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const TURN_MS = 30000;
export const REVEAL_MS = 3000;
export const EXTENSION_MS = 15000;

export function trumpDeck(count) {
  const base = SUITS.flatMap(suit => RANKS.map(rank => rank + suit));
  const extraRanks = count === 6 ? RANKS.slice(0, 5) : count === 8 ? RANKS.slice(0, 7) : [];
  return [...base, ...SUITS.flatMap(suit => extraRanks.map(rank => '2:' + rank + suit))];
}

export function trumpSeatError(count) {
  return [4, 6, 8].includes(count) ? '' : 'Trump needs 4, 6 or 8 seats. Add a bot to balance the teams.';
}

export function beginTrump(room, random = Math.random, now = Date.now()) {
  const error = trumpSeatError(room.players.length);
  if (error) throw new Error(error);
  const a = room.players.filter(p => p.team === 0);
  const b = room.players.filter(p => p.team === 1);
  if (a.length !== b.length || a.length * 2 !== room.players.length) throw new Error('Choose equal Team A and Team B seats before starting.');
  room.players = a.flatMap((p, i) => [p, b[i]]);
  const previous = room.teamsChanged ? null : room.trump;
  room.teamsChanged = false;
  const count = room.players.length;
  let caller = Math.floor(random() * count);
  if (previous?.winnerPlayerIds?.some(id => room.players.some(p => p.id === id))) {
    for (let offset = 1; offset <= count; offset++) {
      const oldCaller = room.players.findIndex(p => p.id === previous.playerIds[previous.callerIndex]);
      const candidate = (Math.max(0, oldCaller) + offset) % count;
      if (previous.winnerPlayerIds.includes(room.players[candidate].id)) { caller = candidate; break; }
    }
  }
  const deck = trumpDeck(count);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = room.players.map(() => []);
  deck.forEach((card, i) => hands[i % count].push(card));
  room.trump = {
    phase: 'toss', suit: null, callerIndex: caller, playerIds: room.players.map(p => p.id),
    callerSource: previous?.winnerPlayerIds?.length ? 'previous-winners' : 'toss',
    resolveAt: now + REVEAL_MS, deadline: 0,
    reserve: hands.map(hand => hand.slice(5)), trick: [], lastTrick: [], lastTrickWinner: '',
    captured: [], scores: [0, 0], points: previous?.points || [0, 0],
    handWins: Object.fromEntries(room.players.map(p => [p.id, 0])), handHistory: [],
    resultPlayers: room.players.map(p => ({ playerId: p.id, name: p.name, avatarIndex: p.avatarIndex, team: p.team })),
    extensions: [], requireTrumpOpened: Boolean(room.requireTrumpOpened), trumpOpened: false,
    totalTricks: deck.length / count, completedTricks: 0, winnerTeam: -1, winnerPlayerIds: [], coat: false,
  };
  room.players.forEach((player, i) => { player.hand = hands[i].slice(0, 5).sort(compareCards); });
  room.currentIndex = caller;
  room.log.push(`${room.players[caller].name} ${previous?.winnerTeam >= 0 ? 'calls for the previous winning team' : 'won the toss'}. Choose trump from the first five cards.`);
}

export function chooseTrump(room, playerId, suit, now = Date.now()) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'choose') return 'Trump has already been called or the game is not running.';
  if (room.players[t.callerIndex].id !== playerId) return 'Only the trump caller can choose the suit.';
  if (!SUITS.includes(suit)) return 'Choose a valid trump suit.';
  t.suit = suit;
  t.phase = 'play';
  t.deadline = now + TURN_MS;
  room.players.forEach((p, i) => { p.hand.push(...t.reserve[i]); p.hand.sort(compareCards); });
  t.reserve = room.players.map(() => []);
  room.log.push(`${room.players[t.callerIndex].name} called ${suitName(suit)}. Trump stays fixed for this game.`);
  return '';
}

export function legalTrumpCards(room, player) {
  if (room.trump?.phase !== 'play' || room.winner) return [];
  const lead = room.trump.trick[0]?.card.slice(-1);
  const following = lead ? player.hand.filter(card => card.endsWith(lead)) : [];
  if (!lead && room.trump.requireTrumpOpened && !room.trump.trumpOpened) {
    const nonTrump = player.hand.filter(card => !card.endsWith(room.trump.suit));
    if (nonTrump.length) return nonTrump;
  }
  return following.length ? following : [...player.hand];
}

export function trickWinner(trick, trump) {
  const lead = trick[0].card.slice(-1);
  const strength = card => (card.endsWith(trump) ? 200 : card.endsWith(lead) ? 100 : 0) + RANKS.indexOf(cardRank(card));
  return trick.reduce((best, play) => strength(play.card) > strength(best.card) ? play : best);
}

export function playTrump(room, playerId, cards, now = Date.now()) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'play') return 'Wait for trump to be called.';
  const player = room.players[room.currentIndex];
  if (player.id !== playerId) return 'It is not your turn.';
  if (!Array.isArray(cards) || cards.length !== 1 || !player.hand.includes(cards[0])) return 'Play exactly one card from your hand.';
  const card = cards[0];
  if (!legalTrumpCards(room, player).includes(card)) return t.trick.length ? 'You must follow the led suit while you have it.' : 'Trump is not open yet. Lead another suit unless you only hold trump.';
  if (card.endsWith(t.suit)) t.trumpOpened = true;
  player.hand.splice(player.hand.indexOf(card), 1);
  t.trick.push({ playerId, name: player.name, card, team: room.currentIndex % 2 });
  room.log.push(`${player.name} played ${card.split(':').at(-1)}.`);
  if (t.trick.length < room.players.length) {
    room.currentIndex = (room.currentIndex + 1) % room.players.length;
    t.deadline = now + TURN_MS;
    return '';
  }
  const winning = trickWinner(t.trick, t.suit);
  room.currentIndex = room.players.findIndex(p => p.id === winning.playerId);
  t.scores[winning.team]++;
  t.completedTricks++;
  t.handWins[winning.playerId] = (t.handWins[winning.playerId] || 0) + 1;
  t.handHistory.push({ hand: t.completedTricks, playerId: winning.playerId, name: winning.name, team: winning.team });
  t.lastTrick = [...t.trick];
  t.lastTrickWinner = winning.name;
  t.phase = 'reveal';
  t.resolveAt = now + REVEAL_MS;
  t.deadline = 0;
  room.log.push(`${winning.name} takes hand ${t.completedTricks}. Team ${winning.team === 0 ? 'A' : 'B'} leads next.`);
  const target = Math.floor(t.totalTricks / 2) + 1;
  t.gameComplete = Math.max(...t.scores) >= target || t.completedTricks >= t.totalTricks;
  return '';
}

export function extendTrumpTurn(room, playerId, now = Date.now()) {
  const t = room.trump, player = room.players[room.currentIndex];
  if (!room.started || room.winner || !['choose', 'play'].includes(t?.phase) || !t.deadline || now >= t.deadline) return 'No active turn to extend.';
  if (!player || player.id !== playerId || player.isBot) return 'Only the current human player can extend their turn.';
  if (t.extensions.includes(playerId)) return 'Your extra time has already been used this game.';
  t.extensions.push(playerId); t.deadline += EXTENSION_MS;
  room.log.push(`${player.name} added 15 seconds to their turn.`);
  return '';
}

// Both the server and offline controller advance the same timed phases.
export function advanceTrump(room, now = Date.now()) {
  const t = room.trump;
  if (!room.started || room.winner || !t) return false;
  if (t.phase === 'toss' && now >= t.resolveAt) {
    t.phase = 'choose'; t.resolveAt = 0; t.deadline = now + TURN_MS;
    return true;
  }
  if (t.phase === 'reveal' && now >= t.resolveAt) {
    t.captured.push(...t.trick.map(p => p.card)); t.trick = [];
    t.resolveAt = 0;
    if (t.gameComplete) finishTrump(room);
    else { t.phase = 'play'; t.deadline = now + TURN_MS; }
    return true;
  }
  if (t.deadline && now >= t.deadline) {
    const player = room.players[room.currentIndex];
    room.log.push(`${player.name}'s turn timed out. System plays safely.`);
    if (t.phase === 'choose') chooseTrump(room, player.id, chooseBotTrump(player), now);
    else if (t.phase === 'play') playTrump(room, player.id, [chooseBotTrumpCard(room, { ...player, difficulty: 'Pro' })], now);
    return true;
  }
  return false;
}

function finishTrump(room) {
  const t = room.trump;
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
}

export function trumpPublicState(room, viewer) {
  const t = room.trump;
  const caller = t && room.players[t.callerIndex];
  return {
    gameType: 'trump', trumpSuit: t?.suit || '', trumpPhase: t?.phase || 'lobby',
    trumpCallerId: caller?.id || '', trumpCallerName: caller?.name || '',
    callerSource: t?.callerSource || '', phaseEndsAt: t?.resolveAt || 0,
    turnDeadline: t?.deadline || 0, serverTime: Date.now(), turnDurationMs: TURN_MS,
    turnDirection: 'anticlockwise', leadSuit: t?.trick[0]?.card.slice(-1) || '',
    handWinnerId: t?.phase === 'reveal' ? room.players[room.currentIndex]?.id || '' : '',
    teamScores: t?.scores || [0, 0], teamPoints: t?.points || [0, 0],
    totalTricks: t?.totalTricks || ([4, 6, 8].includes(room.players.length) ? trumpDeck(room.players.length).length / room.players.length : 0),
    deckType: room.players.length === 4 ? 'Classic' : [6, 8].includes(room.players.length) ? 'Balanced ' + room.players.length : 'Choose 4, 6 or 8 seats',
    cardsPerPlayer: t?.totalTricks || ([4, 6, 8].includes(room.players.length) ? trumpDeck(room.players.length).length / room.players.length : 0),
    requireTrumpOpened: room.started && !room.winner ? Boolean(t?.requireTrumpOpened) : Boolean(room.requireTrumpOpened), trumpOpened: Boolean(t?.trumpOpened),
    extensionUsed: Boolean(t?.extensions.includes(viewer.id)),
    canExtendTurn: Boolean(t && room.started && !room.winner && ['choose', 'play'].includes(t.phase) && t.deadline > Date.now() && room.players[room.currentIndex]?.id === viewer.id && !viewer.isBot && !t.extensions.includes(viewer.id)),
    deckCount: room.players.length === 4 ? 1 : 2,
    completedTricks: t?.completedTricks || 0, trick: t?.trick || [],
    handWins: (t?.resultPlayers || room.players.map(p => ({ playerId: p.id, name: p.name, avatarIndex: p.avatarIndex, team: p.team }))).map(p => ({ ...p, handsWon: t?.handWins?.[p.playerId] || 0 })),
    handHistory: t?.handHistory || [],
    lastTrick: t?.lastTrick || [], lastTrickWinner: t?.lastTrickWinner || '', coat: Boolean(t?.coat),
    legalCards: room.players[room.currentIndex]?.id === viewer.id ? legalTrumpCards(room, viewer) : [],
    centerCount: t?.trick.length || 0, phase: room.winner ? 'Game over' : t?.phase === 'choose' ? 'Choose trump' : room.started ? 'Playing' : 'Lobby',
    totalKnownCards: t ? t.captured.length + t.trick.length + room.players.reduce((sum, p) => sum + p.hand.length, 0) + t.reserve.reduce((sum, h) => sum + h.length, 0) : 0,
    deckOk: !t || t.captured.length + t.trick.length + room.players.reduce((sum, p) => sum + p.hand.length, 0) + t.reserve.reduce((sum, h) => sum + h.length, 0) === trumpDeck(room.players.length).length,
  };
}

export function chooseBotTrump(player) {
  return SUITS.reduce((best, suit) => {
    const value = s => player.hand.filter(c => c.endsWith(s)).reduce((sum, c) => sum + 14 + RANKS.indexOf(cardRank(c)), 0);
    return value(suit) > value(best) ? suit : best;
  }, 'S');
}

export function chooseBotTrumpCard(room, player, random = Math.random) {
  const cards = legalTrumpCards(room, player).sort(compareCards);
  if (player.difficulty === 'Low') return cards[Math.floor(random() * cards.length)];
  const trick = room.trump.trick;
  if (!trick.length) return player.difficulty === 'Pro' ? cards.at(-1) : cards[0];
  const best = trickWinner(trick, room.trump.suit);
  if (best.team === room.currentIndex % 2 && player.difficulty === 'Pro') return cards.sort((a, b) => Number(a.endsWith(room.trump.suit)) - Number(b.endsWith(room.trump.suit)) || RANKS.indexOf(cardRank(a)) - RANKS.indexOf(cardRank(b)))[0];
  return cards.find(card => trickWinner([...trick, { card, playerId: player.id }], room.trump.suit).playerId === player.id) || cards[0];
}

function cardRank(card) { return card.split(':').at(-1).slice(0, -1); }
function compareCards(a, b) { return a.slice(-1).localeCompare(b.slice(-1)) || RANKS.indexOf(cardRank(a)) - RANKS.indexOf(cardRank(b)); }
function suitName(suit) { return { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[suit]; }
