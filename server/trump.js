const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const TURN_MS = 30000;
export const REVEAL_MS = 3000;
export const EXTENSION_MS = 15000;
export const REVIEW_MS = 20000;
export const CHALLENGE_MS = 5000;

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
  const previousWinners = previous?.winnerPlayerIds?.filter(id => room.players.some(p => p.id === id)) || [];
  const firstHuman = Math.max(0, room.players.findIndex(p => !p.isBot));
  const winningTeam = previousWinners.length ? room.players.find(p => p.id === previousWinners[0]).team : -1;
  const representative = winningTeam >= 0 ? room.players.findIndex(p => p.team === winningTeam && !p.isBot) : firstHuman;
  const selector = representative >= 0 ? representative : room.players.findIndex(p => p.team === winningTeam);
  const deck = trumpDeck(count);
  room.trumpRandom = random;
  room.trump = {
    phase: previousWinners.length ? 'caller' : 'tossPick', suit: null, callerIndex: -1, playerIds: room.players.map(p => p.id),
    callerSource: previousWinners.length ? 'previous-winners' : 'toss', winningTeam,
    tossSelectorId: room.players[selector].id, tossChoice: '', tossResult: '',
    resolveAt: 0, deadline: now + TURN_MS,
    undealt: deck, reserve: room.players.map(() => []), trick: [], lastTrick: [], lastTrickWinner: '',
    captured: [], scores: [0, 0], points: previous?.points || [0, 0],
    handWins: Object.fromEntries(room.players.map(p => [p.id, 0])), handHistory: [],
    resultPlayers: room.players.map(p => ({ playerId: p.id, name: p.name, avatarIndex: p.avatarIndex, team: p.team })),
    extensions: [], requireTrumpOpened: Boolean(room.requireTrumpOpened), trumpOpened: false,
    cheatingAllowed: Boolean(room.cheatingAllowed), hiddenCards: {}, cheatEvidence: {}, accusations: [], verdict: null,
    dealNumber: 0, reshuffleCount: 0, reshuffleReason: '', reviewed: [], trickHistory: [],
    totalTricks: deck.length / count, completedTricks: 0, winnerTeam: -1, winnerPlayerIds: [], coat: false,
  };
  room.players.forEach(player => { player.hand = []; });
  room.currentIndex = selector;
  room.log.push(previousWinners.length ? `Team ${winningTeam === 0 ? 'A' : 'B'} selects its next trump caller.` : `${room.players[selector].name} chooses Heads or Tails for Team ${room.players[selector].team === 0 ? 'A' : 'B'}.`);
}

export function callTrumpToss(room, playerId, choice, now = Date.now(), random = room.trumpRandom || Math.random) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'tossPick') return 'The toss is not waiting for a choice.';
  if (t.tossSelectorId !== playerId) return 'Only the team representative can choose Heads or Tails.';
  if (!['heads', 'tails'].includes(choice)) return 'Choose Heads or Tails.';
  t.tossChoice = choice; t.tossResult = random() < .5 ? 'heads' : 'tails';
  t.winningTeam = choice === t.tossResult ? room.players[room.currentIndex].team : 1 - room.players[room.currentIndex].team;
  const representative = room.players.findIndex(p => p.team === t.winningTeam && !p.isBot);
  room.currentIndex = representative >= 0 ? representative : room.players.findIndex(p => p.team === t.winningTeam);
  t.phase = 'toss'; t.deadline = 0; t.resolveAt = now + REVEAL_MS;
  room.log.push(`${t.tossResult === 'heads' ? 'Heads' : 'Tails'}! Team ${t.winningTeam === 0 ? 'A' : 'B'} wins the toss.`);
  return '';
}

export function selectTrumpCaller(room, playerId, callerId, now = Date.now()) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'caller') return 'Caller selection is not open.';
  if (room.players[room.currentIndex].id !== playerId) return 'Only the winning team representative selects the caller.';
  const caller = room.players.findIndex(p => p.id === callerId && p.team === t.winningTeam);
  if (caller < 0) return 'Choose a player from the winning team.';
  t.callerIndex = caller; room.currentIndex = caller;
  dealCaller(room, now);
  room.log.push(`${room.players[caller].name} calls trump from the first five cards. Other hands wait until trump is chosen.`);
  return '';
}

function dealCaller(room, now, reason = '') {
  const t = room.trump, caller = room.players[t.callerIndex];
  t.dealNumber++; t.phase = 'choose'; t.suit = null; t.deadline = now + TURN_MS; t.resolveAt = 0; t.reviewed = [];
  t.hiddenCards = {}; t.cheatEvidence = {}; t.trumpOpened = false; room.currentIndex = t.callerIndex;
  room.players.forEach(p => { p.hand = []; });
  if (reason) { t.reshuffleCount++; t.reshuffleReason = reason; room.log.push(`Reshuffle: ${reason} Trump will be called again.`); }
  for (let attempt = 0; attempt < 1000; attempt++) {
    const deck = shuffled(trumpDeck(room.players.length), room.trumpRandom || Math.random);
    if (deck.slice(0, 5).some(c => RANKS.indexOf(cardRank(c)) >= RANKS.indexOf('10'))) {
      caller.hand = deck.slice(0, 5).sort(compareCards); t.undealt = deck.slice(5); return;
    }
    t.reshuffleCount++; t.reshuffleReason = (reason ? reason + ' ' : '') + 'The caller received five cards below 10.';
    room.log.push('Reshuffle: the caller received five cards below 10. Same caller, fresh cards.');
  }
  throw Error('Could not prepare a valid deal. Start a new game.');
}

function shuffled(deck, random) {
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

export function chooseTrump(room, playerId, suit, now = Date.now()) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'choose') return 'Trump has already been called or the game is not running.';
  if (room.players[t.callerIndex].id !== playerId) return 'Only the trump caller can choose the suit.';
  if (!SUITS.includes(suit)) return 'Choose a valid trump suit.';
  t.suit = suit;
  const hands = room.players.map(p => [...p.hand]), size = t.totalTricks;
  let seat = (t.callerIndex + 1) % room.players.length;
  for (const card of t.undealt) {
    while (hands[seat].length >= size) seat = (seat + 1) % hands.length;
    hands[seat].push(card); seat = (seat + 1) % hands.length;
  }
  if (hands.some(hand => hand.filter(c => c.endsWith(suit)).length >= 7)) {
    dealCaller(room, now, 'A hand contained seven or more trump cards.'); return '';
  }
  t.undealt = []; room.players.forEach((p, i) => { p.hand = hands[i].sort(compareCards); });
  t.phase = 'review'; t.deadline = now + REVIEW_MS; t.reviewed = room.players.filter(p => p.isBot).map(p => p.id);
  room.log.push(`${room.players[t.callerIndex].name} called ${suitName(suit)}. Trump stays fixed for this game.`);
  if (t.reviewed.length === room.players.length) startTrumpPlay(room, now);
  return '';
}

export function reviewTrumpHand(room, playerId, now = Date.now()) {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'review' || !room.players.some(p => p.id === playerId)) return 'Hand review is closed.';
  if (!t.reviewed.includes(playerId)) t.reviewed.push(playerId);
  if (t.reviewed.length === room.players.length) startTrumpPlay(room, now);
  return '';
}
function startTrumpPlay(room, now) { room.trump.phase = 'play'; room.trump.deadline = now + TURN_MS; room.currentIndex = room.trump.callerIndex; }

export function requestTrumpRedeal(room, playerId, now = Date.now()) {
  const t = room.trump, player = room.players.find(p => p.id === playerId);
  if (!room.started || room.winner || t?.phase !== 'review' || !player) return 'Reshuffle requests close when the first hand starts.';
  if (!SUITS.some(s => s !== t.suit && player.hand.filter(c => c.endsWith(s)).length >= 7)) return 'You need seven or more cards of a non-trump suit to request a reshuffle.';
  dealCaller(room, now, `${player.name} requested a verified seven-card suit reshuffle.`);
  return '';
}

export function legalTrumpCards(room, player) {
  if (room.trump?.phase !== 'play' || room.winner) return [];
  const lead = room.trump.trick[0]?.card.slice(-1);
  const hidden = room.trump.hiddenCards?.[player.id];
  const ordinary = player.hand.length > 1 ? player.hand.filter(card => card !== hidden) : [...player.hand];
  const following = lead ? ordinary.filter(card => card.endsWith(lead)) : [];
  if (!lead && room.trump.requireTrumpOpened && !room.trump.trumpOpened) {
    const nonTrump = player.hand.filter(card => !card.endsWith(room.trump.suit));
    if (nonTrump.length) return nonTrump;
  }
  if (following.length) return hidden && hidden.endsWith(lead) && player.hand.includes(hidden) && !following.includes(hidden) ? [...following, hidden] : following;
  if (lead && hidden && hidden.endsWith(lead) && player.hand.includes(hidden)) return [...ordinary, hidden];
  return [...player.hand];
}

export function trickWinner(trick, trump) {
  const lead = trick[0].card.slice(-1);
  const strength = card => (card.endsWith(trump) ? 200 : card.endsWith(lead) ? 100 : 0) + RANKS.indexOf(cardRank(card));
  return trick.reduce((best, play) => strength(play.card) > strength(best.card) ? play : best);
}

export function playTrump(room, playerId, cards, now = Date.now(), hideCard = '') {
  const t = room.trump;
  if (!room.started || room.winner || t?.phase !== 'play') return 'Wait for trump to be called.';
  const player = room.players[room.currentIndex];
  if (player.id !== playerId) return 'It is not your turn.';
  if (!Array.isArray(cards) || cards.length !== 1 || !player.hand.includes(cards[0])) return 'Play exactly one card from your hand.';
  const card = cards[0];
  if (hideCard) {
    const lead = t.trick[0]?.card.slice(-1);
    if (!t.cheatingAllowed || player.isBot || t.cheatEvidence[playerId]) return 'Your hidden-card opportunity is unavailable.';
    if (!lead || !player.hand.includes(hideCard) || !hideCard.endsWith(lead) || card.endsWith(lead) || hideCard === card) return 'Save a card of the starting suit and play another suit.';
    t.hiddenCards[playerId] = hideCard;
    t.cheatEvidence[playerId] = { playerId, name: player.name, hand: t.completedTricks + 1, leadSuit: lead, playedCard: card, hiddenCard: hideCard };
  } else if (!legalTrumpCards(room, player).includes(card)) return t.trick.length ? 'You must follow the led suit while you have it.' : 'Trump is not open yet. Lead another suit unless you only hold trump.';
  if (card.endsWith(t.suit)) t.trumpOpened = true;
  player.hand.splice(player.hand.indexOf(card), 1);
  if (t.hiddenCards[playerId] === card) delete t.hiddenCards[playerId];
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
  t.trickHistory.push({ hand: t.completedTricks, leadSuit: t.trick[0].card.slice(-1), winnerId: winning.playerId, winnerName: winning.name, team: winning.team, cards: t.trick.map(p => ({ ...p })) });
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
    t.phase = 'caller'; t.resolveAt = 0; t.deadline = now + TURN_MS;
    return true;
  }
  if (t.phase === 'accusation' && now >= t.resolveAt) {
    t.phase = t.resume.phase;
    t.deadline = t.resume.deadline ? now + t.resume.deadline : 0;
    t.resolveAt = t.resume.resolveAt ? now + t.resume.resolveAt : 0;
    t.resume = null;
    return true;
  }
  if (t.phase === 'finishChallenge' && now >= t.resolveAt) { finishTrump(room); return true; }
  if (t.phase === 'reveal' && now >= t.resolveAt) {
    t.captured.push(...t.trick.map(p => p.card)); t.trick = [];
    t.resolveAt = 0;
    if (t.gameComplete && t.cheatingAllowed) { t.phase = 'finishChallenge'; t.resolveAt = now + CHALLENGE_MS; }
    else if (t.gameComplete) finishTrump(room);
    else { t.phase = 'play'; t.deadline = now + TURN_MS; }
    return true;
  }
  if (t.deadline && now >= t.deadline) {
    const player = room.players[room.currentIndex];
    if (t.phase === 'review') { startTrumpPlay(room, now); return true; }
    room.log.push(`${player.name}'s turn timed out. System completes the turn.`);
    if (t.phase === 'tossPick') callTrumpToss(room, player.id, 'heads', now);
    else if (t.phase === 'caller') selectTrumpCaller(room, player.id, player.id, now);
    else if (t.phase === 'choose') chooseTrump(room, player.id, chooseBotTrump(player), now);
    else if (t.phase === 'play') playTrump(room, player.id, [chooseBotTrumpCard(room, { ...player, difficulty: 'Pro' })], now);
    return true;
  }
  return false;
}

export function catchTrumpCheat(room, playerId, targetId, now = Date.now()) {
  const t = room.trump, accuser = room.players.find(p => p.id === playerId), target = room.players.find(p => p.id === targetId);
  if (!room.started || room.winner || !t?.cheatingAllowed || !['play', 'reveal', 'finishChallenge'].includes(t.phase)) return 'Cheat challenges are not open.';
  if (!accuser || !target || accuser.team === target.team) return 'Choose a player on the other team.';
  if (t.accusations.includes(playerId)) return 'You have already used your challenge this game.';
  t.accusations.push(playerId);
  const evidence = t.cheatEvidence[targetId];
  t.verdict = { accuserId: playerId, accuserName: accuser.name, targetId, targetName: target.name, guilty: Boolean(evidence), evidence: evidence || null };
  if (evidence) {
    finishTrump(room, accuser.team, `${accuser.name} caught ${target.name} hiding a ${suitName(evidence.leadSuit)} card in hand ${evidence.hand}.`);
  } else {
    t.resume = { phase: t.phase, deadline: t.deadline ? Math.max(1, t.deadline - now) : 0, resolveAt: t.resolveAt ? Math.max(1, t.resolveAt - now) : 0 };
    t.phase = 'accusation'; t.deadline = 0; t.resolveAt = now + 2000;
    room.log.push(`${target.name} was not cheating. The game continues.`);
  }
  return '';
}

function finishTrump(room, forcedTeam = -1, reason = '') {
  const t = room.trump;
  t.phase = 'over';
  t.deadline = 0; t.resolveAt = 0;
  if (forcedTeam < 0 && t.scores[0] === t.scores[1]) {
    room.winner = 'Draw';
    room.winnerReason = `${t.scores[0]}-${t.scores[1]} hands. No points awarded.`;
  } else {
    t.winnerTeam = forcedTeam >= 0 ? forcedTeam : t.scores[0] > t.scores[1] ? 0 : 1;
    t.winnerPlayerIds = room.players.filter((p, i) => i % 2 === t.winnerTeam).map(p => p.id);
    t.coat = forcedTeam < 0 && t.scores[1 - t.winnerTeam] === 0;
    t.points[t.winnerTeam] += t.coat ? 3 : 1;
    room.winner = `Team ${t.winnerTeam === 0 ? 'A' : 'B'}`;
    room.players.forEach((p, i) => { if (i % 2 === t.winnerTeam) p.wins = (p.wins || 0) + 1; });
    room.winnerReason = reason ? `Won by catching a cheat. ${reason} Hands: ${t.scores[0]}-${t.scores[1]}.` : `${t.scores[0]}-${t.scores[1]} hands${t.coat ? ' - Coat! 3 points.' : ' - 1 point.'}`;
  }
  room.log.push(`${room.winner}. ${room.winnerReason}`);
}

export function trumpPublicState(room, viewer) {
  const t = room.trump;
  const caller = t && room.players[t.callerIndex];
  const known = t ? t.captured.length + t.trick.length + room.players.reduce((sum, p) => sum + p.hand.length, 0) + t.undealt.length : 0;
  const most = t ? Math.max(0, ...Object.values(t.handWins)) : 0;
  return {
    gameType: 'trump', trumpSuit: t?.suit || '', trumpPhase: t?.phase || 'lobby',
    trumpCallerId: caller?.id || '', trumpCallerName: caller?.name || '',
    callerSource: t?.callerSource || '', phaseEndsAt: t?.resolveAt || 0,
    tossSelectorId: t?.tossSelectorId || '', tossChoice: t?.tossChoice || '', tossResult: t?.tossResult || '', tossWinningTeam: t?.winningTeam ?? -1,
    dealNumber: t?.dealNumber || 0, reshuffleCount: t?.reshuffleCount || 0, reshuffleReason: t?.reshuffleReason || '',
    reviewed: t?.reviewed || [],
    canRequestRedeal: Boolean(t?.phase === 'review' && SUITS.some(s => s !== t.suit && (viewer.hand || []).filter(c => c.endsWith(s)).length >= 7)),
    cheatingAllowed: room.started && !room.winner ? Boolean(t?.cheatingAllowed) : Boolean(room.cheatingAllowed),
    hiddenCard: t?.hiddenCards[viewer.id] || '', cheatingUsed: Boolean(t?.cheatEvidence[viewer.id]),
    canHideCard: Boolean(t?.cheatingAllowed && t.phase === 'play' && !t.cheatEvidence[viewer.id] && room.players[room.currentIndex]?.id === viewer.id && t.trick.length && viewer.hand.some(c => c.endsWith(t.trick[0].card.slice(-1))) && viewer.hand.some(c => !c.endsWith(t.trick[0].card.slice(-1)))),
    canCatchCheat: Boolean(t?.cheatingAllowed && room.started && !room.winner && ['play', 'reveal', 'finishChallenge'].includes(t.phase) && !t.accusations.includes(viewer.id)),
    cheatVerdict: t?.verdict || null,
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
    handHistory: t?.handHistory || [], trickHistory: t?.trickHistory || [],
    baapPlayerIds: room.winner && most > 0 ? Object.keys(t.handWins).filter(id => t.handWins[id] === most) : [],
    lastTrick: t?.lastTrick || [], lastTrickWinner: t?.lastTrickWinner || '', coat: Boolean(t?.coat),
    legalCards: room.players[room.currentIndex]?.id === viewer.id ? legalTrumpCards(room, viewer) : [],
    centerCount: t?.trick.length || 0, phase: room.winner ? 'Game over' : t?.phase === 'choose' ? 'Choose trump' : room.started ? 'Playing' : 'Lobby',
    totalKnownCards: known, deckOk: !t || known === trumpDeck(room.players.length).length,
  };
}

export function chooseBotTrump(player, random = Math.random) {
  const values = SUITS.map(suit => ({ suit, value: player.hand.filter(c => c.endsWith(suit)).reduce((sum, c) => sum + 14 + RANKS.indexOf(cardRank(c)), 0) }));
  const best = Math.max(...values.map(v => v.value)), tied = values.filter(v => v.value === best);
  return tied[Math.floor(random() * tied.length)].suit;
}

export function chooseBotTrumpCard(room, player, random = Math.random) {
  let cards = legalTrumpCards(room, player).sort(compareCards);
  const hidden = room.trump.hiddenCards[player.id];
  if (cards.length > 1 && hidden) cards = cards.filter(c => c !== hidden);
  if (!cards.length) return undefined;
  if (player.difficulty === 'Low') return cards[Math.floor(random() * cards.length)];
  const trick = room.trump.trick;
  const rank = card => RANKS.indexOf(cardRank(card));
  const cost = card => rank(card) + (card.endsWith(room.trump.suit) ? 15 : 0);
  const pick = list => list[Math.floor(random() * list.length)];
  if (!trick.length) {
    if (player.difficulty !== 'Pro') return pick(cards);
    // Memory uses public plays, never another player's private hand.
    const history = [...room.trump.trickHistory.flatMap(h => h.cards), ...trick];
    const voids = new Map();
    for (const hand of room.trump.trickHistory) for (const p of hand.cards) {
      if (!p.card.endsWith(hand.leadSuit)) {
        if (!voids.has(p.playerId)) voids.set(p.playerId, new Set());
        voids.get(p.playerId).add(hand.leadSuit);
      }
    }
    const scored = cards.map(card => {
      const suit = card.slice(-1), isTrump = suit === room.trump.suit;
      const opponentsVoid = room.players.filter(p => p.team !== player.team && voids.get(p.id)?.has(suit)).length;
      const unseenHigher = trumpDeck(room.players.length).filter(c => c.endsWith(suit) && rank(c) > rank(card) && !player.hand.includes(c) && !history.some(p => p.card === c)).length;
      const length = player.hand.filter(c => c.endsWith(suit)).length;
      return { card, value: (unseenHigher === 0 ? 22 : rank(card)) + length * 2 - (!isTrump ? opponentsVoid * 26 : 5) };
    });
    const maximum = Math.max(...scored.map(s => s.value));
    return pick(scored.filter(s => s.value === maximum)).card;
  }
  const best = trickWinner(trick, room.trump.suit);
  const cheapest = list => { const value = Math.min(...list.map(cost)); return pick(list.filter(c => cost(c) === value)); };
  if (best.team === player.team) return cheapest(cards);
  const winners = cards.filter(card => trickWinner([...trick, { card, playerId: player.id }], room.trump.suit).playerId === player.id);
  return cheapest(winners.length ? winners : cards);
}

export function takeTrumpBotTurn(room, now = Date.now()) {
  const t = room.trump, player = room.players[room.currentIndex];
  if (!player?.isBot || room.winner) return false;
  if (t.phase === 'tossPick') callTrumpToss(room, player.id, Math.random() < .5 ? 'heads' : 'tails', now);
  else if (t.phase === 'caller') selectTrumpCaller(room, player.id, player.id, now);
  else if (t.phase === 'choose') chooseTrump(room, player.id, chooseBotTrump(player), now);
  else if (t.phase === 'play') {
    if (t.cheatingAllowed && player.difficulty === 'Pro' && !t.accusations.includes(player.id)) {
      const withheld = new Map();
      for (const moves of [...t.trickHistory.map(h => h.cards), t.trick]) {
        const lead = moves[0]?.card.slice(-1);
        for (const move of moves) {
          if (move.team === player.team) continue;
          const old = withheld.get(move.playerId);
          if (old?.has(move.card.slice(-1))) { catchTrumpCheat(room, player.id, move.playerId, now); return true; }
          if (lead && !move.card.endsWith(lead)) { if (!old) withheld.set(move.playerId, new Set()); withheld.get(move.playerId).add(lead); }
        }
      }
    }
    playTrump(room, player.id, [chooseBotTrumpCard(room, player)], now);
  }
  else return false;
  return true;
}

function cardRank(card) { return card.split(':').at(-1).slice(0, -1); }
function compareCards(a, b) { return a.slice(-1).localeCompare(b.slice(-1)) || RANKS.indexOf(cardRank(a)) - RANKS.indexOf(cardRank(b)); }
function suitName(suit) { return { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[suit]; }
