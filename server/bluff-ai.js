// Decisions receive only the bot's hand and public claims/verdicts.
export function bluffBotPersonality(id = '') {
  let hash = 0;
  for (const c of String(id)) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  return ['careful', 'balanced', 'bold'][hash % 3];
}
export function bluffChallengeChance(info) {
  const { hand, rank, count, difficulty, pileCount = 0, targetId, botId, history = [], finalClaim } = info;
  if (!count || targetId === botId) return 0;
  const own = hand.filter(c => c.slice(0, -1) === rank).length;
  if (own + count > 4) return difficulty === 'Pro' ? 1 : difficulty === 'Medium' ? .96 : .65;
  const personality = bluffBotPersonality(botId), factor = personality === 'careful' ? .82 : personality === 'bold' ? 1.15 : 1;
  let chance = difficulty === 'Pro' ? .065 : difficulty === 'Medium' ? .045 : .025;
  chance += count >= 3 ? difficulty === 'Pro' ? .14 : .085 : count === 2 ? .025 : 0;
  chance += own * .015 + (own >= 2 && count >= 2 ? .055 : 0);
  const past = history.filter(h => h.targetId === targetId).slice(-5);
  if (past.length && difficulty !== 'Low') chance += (past.filter(h => h.guilty).length / past.length - .35) * .11;
  const recentWrong = history.slice(-5).filter(h => h.callerId === botId && !h.guilty).length;
  chance = Math.max(.008, chance - recentWrong * .025);
  if (finalClaim) return Math.min(.9, .48 + chance * 1.2);
  chance *= factor / (1 + Math.max(0, pileCount - 4) / 16);
  if (own > 0) chance *= .75;
  if (hand.length <= 2) chance *= .65;
  return Math.max(.008, Math.min(.65, chance));
}
export function bluffPassChance(info) {
  if (info.hand.some(c => c.slice(0, -1) === info.rank)) return 0;
  let chance = info.difficulty === 'Pro' ? .55 : info.difficulty === 'Medium' ? .39 : .23;
  const style = bluffBotPersonality(info.botId);
  if (style === 'careful') chance += .09;
  if (style === 'bold') chance -= .07;
  chance += Math.min(.2, Math.max(0, info.pileCount - 3) / 55);
  if (info.hand.length <= 2) chance += .10;
  return Math.max(.1, Math.min(.85, chance));
}
export function bluffThinkingDelay(base, difficulty, random = Math.random) {
  const scale = difficulty === 'Pro' ? 1.1 : difficulty === 'Medium' ? .95 : .8;
  return Math.max(100, Math.min(1900, Math.round(base * (scale + random() * .55))));
}
