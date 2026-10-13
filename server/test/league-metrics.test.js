import test from 'node:test';
import assert from 'node:assert/strict';
import { addResult, publicRecord, verifiedResult, leagueNight, sharedMatchProfile } from '../league-metrics.js';
import { writeVerifiedResult, profileHealth, profileApi } from '../profile-store.js';
function room() {
 const players=[{id:'a',uid:'alice',name:'Alice',team:0,avatarIndex:8},{id:'b',uid:'bob',name:'Bob',team:1,avatarIndex:9}];
 return {winner:'Team A',matchId:'one',leagueId:'club',gameType:'trump',players,matchAccounts:players,
  trump:{winnerTeam:0,scores:[7,2],handWins:{a:6,b:3},variant:'double'}};
}
test('Only fully verified human games enter the shared league',()=>{
 const r=room();assert.equal(verifiedResult(r).players[0].win,true);
 r.winner='';assert.equal(verifiedResult(r),null);r.winner='Team A';
 r.matchAccounts[1].uid='';assert.equal(verifiedResult(r),null);
 r.matchAccounts[1].uid='alice';assert.equal(verifiedResult(r),null);
 r.matchAccounts[1].uid='bob';r.players[1].isBot=true;assert.equal(verifiedResult(r),null);
});
test('Finished snapshot remains unchanged during rematch',()=>{
 const r=room(),result=verifiedResult(r);r.matchAccounts[0].name='Changed';r.trump.handWins.a=0;
 assert.equal(result.players[0].name,'Alice');assert.equal(result.players[0].hands,6);
});
test('Individual Trump hands and Baap differ from team collections',()=>{
 const result=verifiedResult(room());assert.equal(result.players[0].hands,6);assert.equal(result.players[0].baap,true);
 assert.equal(result.players[1].hands,3);assert.equal(result.players[1].win,false);
});
test('Joint Baap and draws retain individual performance',()=>{
 const r=room();r.winner='Draw';r.trump.handWins.b=6;const result=verifiedResult(r);
 assert(result.players.every(p=>p.draw&&!p.win&&p.baap));
});
test('Bluff win belongs only to server winner ID',()=>{
 const r=room();r.gameType='bluff';r.winnerId='b';const result=verifiedResult(r);
 assert.equal(result.players[1].win,true);assert(result.players.every(p=>p.hands===0&&!p.baap));
});
test('Counter updates preserve streaks and honest percentages',()=>{
 let row=addResult({}, {win:true,draw:false,hands:5,baap:true});
 row=addResult(row,{win:true,draw:false,hands:4,baap:false});
 row=addResult(row,{win:false,draw:true,hands:2,baap:false});
 assert.deepEqual(publicRecord(row),{games:3,wins:2,draws:1,streak:0,bestStreak:2,hands:11,baap:1,losses:0,winRate:67,provisional:true});
 assert.equal(publicRecord({...row,games:5}).provisional,false);
});
test('Atomic match ID prevents duplicated wins after reconnect',async()=>{
 const data=new Map(),db={doc:path=>({path}),runTransaction:async fn=>{
  const writes=[];
  const snapshot=ref=>({exists:data.has(ref.path),data:()=>structuredClone(data.get(ref.path))});
  await fn({get:async ref=>snapshot(ref),getAll:async(...refs)=>refs.map(snapshot),
   set:(ref,value)=>writes.push([ref.path,value]),create:(ref,value)=>{assert(!data.has(ref.path));writes.push([ref.path,value]);}});
  for(const [path,value]of writes)data.set(path,{...(data.get(path)||{}),...structuredClone(value)});
 }};
 const result=verifiedResult(room());await writeVerifiedResult(db,result);await writeVerifiedResult(db,result);
 assert.equal(data.get('players/alice').trump.games,1);assert.equal(data.get('players/alice').trump.wins,1);
 assert.equal(data.get('leagues/club/members/bob').trump.games,1);
 assert.equal(data.get('matches/one').players.length,2);
 assert.equal(data.get('leagues/club/nights/'+leagueNight(result.finishedAt)+'/members/alice').trump.games,1);
});
test('Tonight follows Pakistan time and stays together until 4am',()=>{
 assert.equal(leagueNight(Date.parse('2026-10-13T22:00:00Z')),'2026-10-13');
 assert.equal(leagueNight(Date.parse('2026-10-13T23:05:00Z')),'2026-10-14');
});
test('Unconfigured Nearby server never exposes profiles',async()=>{
 assert.equal(profileHealth().configured,false);
 let status,payload;const response={writeHead:code=>status=code,end:text=>payload=JSON.parse(text)};
 await profileApi({method:'GET',url:'/api/league',headers:{}},response,new Map());
 assert.equal(status,503);assert(!('players'in payload));
});
test('Joining a lobby does not grant an outsider access to player records',()=>{
 const rooms=new Map([['room',{players:[{accountUid:'alice'},{accountUid:'bob'}]}]]);
 assert.equal(sharedMatchProfile(rooms,'alice','bob'),false);
 rooms.get('room').matchAccounts=[{uid:'alice'},{uid:'bob'}];
 assert.equal(sharedMatchProfile(rooms,'alice','bob'),true);
 assert.equal(sharedMatchProfile(rooms,'mallory','bob'),false);
});
