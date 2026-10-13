import test from 'node:test';
import assert from 'node:assert/strict';
import { bluffBotPersonality, bluffChallengeChance, bluffPassChance, bluffThinkingDelay } from '../bluff-ai.js';
import { chooseBotTrumpCard, legalTrumpCards, trumpDeck } from '../trump.js';

const claim = extra => ({hand:['2H','3D','4S','5C','6H'],rank:'K',count:1,difficulty:'Pro',pileCount:3,botId:'bot-2',targetId:'human',history:[],...extra});
test('ordinary Bluff claims are not challenged reflexively; proof and final claims matter', () => {
  assert(bluffChallengeChance(claim()) < .10);
  assert(bluffChallengeChance(claim({count:3})) > bluffChallengeChance(claim()));
  assert.equal(bluffChallengeChance(claim({hand:['KH','KD','KS','KC']})),1);
  assert(bluffChallengeChance(claim({finalClaim:true})) > .45);
  assert.equal(bluffChallengeChance(claim({targetId:'bot-2'})),0);
});
test('pile risk, honest opponents and recently wrong challenges temper Bluff bots', () => {
  const honest = [{targetId:'human',callerId:'someone',guilty:false}];
  const caught = [{targetId:'human',callerId:'someone',guilty:true}];
  assert(bluffChallengeChance(claim({history:honest})) < bluffChallengeChance(claim({history:caught})));
  assert(bluffChallengeChance(claim({pileCount:18})) < bluffChallengeChance(claim({pileCount:3})));
  assert(bluffChallengeChance(claim({history:[{targetId:'other',callerId:'bot-2',guilty:false}]})) < bluffChallengeChance(claim()));
  assert.equal(bluffChallengeChance(claim({hand:['KH','KD','KS','KC'],pileCount:30,history:honest})),1);
});
test('bot styles are stable, varied, and passes preserve playable ranks', () => {
  assert.equal(bluffBotPersonality('seat-1'),bluffBotPersonality('seat-1'));
  assert.equal(new Set(Array.from({length:20},(_,i)=>bluffBotPersonality('seat-'+i))).size,3);
  assert.equal(bluffPassChance(claim({hand:['KH','2D']})),0);
  assert(bluffPassChance(claim({pileCount:20})) > bluffPassChance(claim({pileCount:3})));
  assert(bluffThinkingDelay(650,'Pro',()=>.8) > bluffThinkingDelay(650,'Pro',()=>.1));
  assert(bluffThinkingDelay(350,'Medium',()=>.8) < bluffThinkingDelay(1400,'Medium',()=>.8));
});
function table(hand, difficulty='Pro', extra={}) {
  const players=Array.from({length:4},(_,i)=>({id:String(i),team:i%2,name:'P'+i,hand:i===2?hand:[],difficulty}));
  return {players,currentIndex:2,winner:null,trump:{phase:'play',suit:'S',hiddenCards:{},trickHistory:[],variant:'single',trick:[{playerId:'0',team:0,card:'AH'},{playerId:'1',team:1,card:'KH'}],...extra}};
}
for(const skill of ['Low','Medium','Pro'])test(skill+' conserves high cards when its partner is winning',()=>{
  const r=table(['2H','QH','KS'],skill);
  assert.equal(chooseBotTrumpCard(r,r.players[2],()=>.9),'2H');
  r.trump.trick=[{playerId:'0',team:0,card:'AS'},{playerId:'1',team:1,card:'KH'}];r.players[2].hand=['2H','QH','KS'];
  assert.equal(chooseBotTrumpCard(r,r.players[2],()=>.9),'KS'); // Following spades is compulsory.
  r.players[2].hand=['2D','AD','QS'];r.trump.trick=[{playerId:'0',team:0,card:'AH'}];
  assert.equal(chooseBotTrumpCard(r,r.players[2],()=>.9),'2D'); // Do not cut a winning partner.
});
test('strong bots win with the cheapest sufficient card and distinguish Double Hand collection',()=>{
  const r=table(['2H','QH','AH']);r.trump.trick=[{playerId:'1',team:1,card:'JH'}];
  assert.equal(chooseBotTrumpCard(r,r.players[2],()=>0),'QH');
  r.trump.trick=[{playerId:'0',team:0,card:'QH'}];r.trump.variant='double';r.trump.previousWinnerId='2';
  assert.equal(chooseBotTrumpCard(r,r.players[2],()=>0),'AH');
  r.trump.previousWinnerId='0';assert.equal(chooseBotTrumpCard(r,r.players[2],()=>0),'2H');
});
test('bot decisions cannot inspect another player hand and always follow available suit',()=>{
  const r=table(['2H','AD','KS']);
  for(const p of r.players)if(p.id!=='2')Object.defineProperty(p,'hand',{get(){throw Error('Private opponent hand accessed');}});
  for(let i=0;i<40;i++){const card=chooseBotTrumpCard(r,r.players[2],()=>i/40);assert(legalTrumpCards(r,r.players[2]).includes(card));assert.equal(card,'2H');}
  r.trump.trick=[];assert.doesNotThrow(()=>chooseBotTrumpCard(r,r.players[2],()=>0));
});
test('a publicly void opponent stops being a trumping threat once trumps are exhausted',()=>{
  const r=table(['AH','2C']);r.trump.trick=[];
  r.trump.trickHistory=[{leadSuit:'H',cards:[{playerId:'1',card:'2D'}]},...trumpDeck(4).filter(c=>c.endsWith('S')).map(c=>({leadSuit:'S',cards:[{playerId:'1',card:c}]}))];
  assert.equal(chooseBotTrumpCard(r,r.players[2],()=>0),'AH');
});
