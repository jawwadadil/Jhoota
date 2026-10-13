import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { addResult, publicRecord, verifiedResult, leagueNight, sharedMatchProfile } from './league-metrics.js';

let sdk, status = 'not-configured';
const pending = new Map(), limits = new Map();
const configured = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS));
export const profileHealth = () => ({ configured, status, pendingResults: pending.size });
async function services() {
  if (!configured) throw Error('Profiles are not configured on this server.');
  if (!sdk) sdk = Promise.all([import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore')])
    .then(([app, auth, store]) => {
      const instance = app.getApps().find(x => x.name === 'jhoota-records') ||
        app.initializeApp({ credential: app.applicationDefault(), projectId: 'jhoota-7c44e' }, 'jhoota-records');
      return { auth: auth.getAuth(instance), db: store.getFirestore(instance) };
    }).catch(error => { sdk = null; throw error; });
  return sdk;
}
async function probe() {
  if (!configured) return;
  try { const { db } = await services(); await db.doc('_diagnostics/connection').get(); status = 'ready'; }
  catch { status = 'unavailable'; }
}
void probe();
export async function verifyPlayer(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 8192) throw Error('Sign in again to connect your record.');
  const { auth } = await services();
  const identity = await auth.verifyIdToken(token, true);
  if (identity.firebase?.sign_in_provider !== 'google.com' || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.uid)) throw Error('Connect a Google account for verified records.');
  return identity.uid;
}
function profileRef(db, uid) { return db.doc('players/' + uid); }
function visible(row, uid) {
  return { uid, name: row.name || 'Player', avatar: row.avatar ?? 8,
    bluff: publicRecord(row.bluff), trump: publicRecord(row.trump),
    baapAwards: row.trump?.baap || 0, totalHands: row.trump?.hands || 0 };
}
export async function connectProfile(uid, name, avatar, leagueId = '') {
  const { db } = await services();
  const ref = profileRef(db, uid), old = (await ref.get()).data() || {};
  const group = leagueId || old.leagueId || randomUUID();
  await db.runTransaction(async tx => {
    const groupRef = db.doc('leagues/' + group), membership = groupRef.collection('members').doc(uid);
    const [groupDoc, memberDoc] = await tx.getAll(groupRef, membership);
    if (!groupDoc.exists) tx.create(groupRef, { name: "Cousins' League", createdAt: Date.now() });
    tx.set(ref, { name, avatar, leagueId: group }, { merge: true });
    tx.set(membership, { name, avatar, ...(!memberDoc.exists ? { joinedAt: Date.now() } : {}) }, { merge: true });
  });
  status = 'ready';
  return group;
}
export function admitLeaguePlayers(room) {
  if (!configured || !room.leagueId || !room.matchAccounts?.length ||
      room.matchAccounts.some(p => p.isBot || !p.uid)) return;
  // League access follows the host-approved match roster, not an unaccepted join.
  void Promise.all(room.matchAccounts.map(p => connectProfile(p.uid, p.name, p.avatarIndex, room.leagueId)))
    .catch(() => { status = 'retrying'; });
}
export function recordProfileResult(room) {
  if (!configured) return;
  const result = verifiedResult(room);
  if (!result || pending.has(result.id) || room.cloudRecordedMatch === result.id) return;
  room.cloudRecordedMatch = result.id;
  pending.set(result.id, result);
  void flushResult(result);
}
async function flushResult(result) {
  try {
    const { db } = await services();
    await writeVerifiedResult(db, result);
    pending.delete(result.id); status = 'ready';
  } catch {
    status = 'retrying';
    const timer = setTimeout(() => { if (pending.has(result.id)) void flushResult(result); }, 15000);
    timer.unref?.();
  }
}
export async function writeVerifiedResult(db, result) {
  await db.runTransaction(async tx => {
      const match = db.doc('matches/' + result.id);
      const exists = await tx.get(match);
      if (exists.exists) return;
      const refs = result.players.map(p => profileRef(db, p.uid));
      const members = result.players.map(p => db.doc('leagues/' + result.leagueId + '/members/' + p.uid));
      const nights = result.players.map(p => db.doc('leagues/' + result.leagueId + '/nights/' + leagueNight(result.finishedAt) + '/members/' + p.uid));
      const docs = await tx.getAll(...refs, ...members, ...nights);
      result.players.forEach((p, i) => {
        const personal = docs[i].data() || {}, member = docs[i + refs.length].data() || {};
        tx.set(refs[i], { leagueId: result.leagueId, [result.mode]: addResult(personal[result.mode], p) }, { merge: true });
        tx.set(members[i], { name: p.name, avatar: p.avatar, [result.mode]: addResult(member[result.mode], p) }, { merge: true });
        const night = docs[i + refs.length * 2].data() || {};
        tx.set(nights[i], { name: p.name, avatar: p.avatar, [result.mode]: addResult(night[result.mode], p) }, { merge: true });
      });
      tx.create(match, result);
  });
}
function reply(response, code, value) {
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export async function profileApi(request, response, rooms) {
  try {
    if (!['GET', 'PUT'].includes(request.method)) return reply(response, 405, { error: 'Method not allowed.' });
    const bearer = request.headers.authorization || '';
    const uid = await verifyPlayer(bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
    const now = Date.now(), recent = (limits.get(uid) || []).filter(t => now - t < 60000);
    if (recent.length >= 60) return reply(response, 429, { error: 'Please wait a moment.' });
    recent.push(now); limits.set(uid, recent);
    if (limits.size > 2000) for (const [id, times] of limits) if (!times.some(t => now - t < 60000)) limits.delete(id);
    const url = new URL(request.url, 'http://localhost'), { db } = await services();
    const mine = (await profileRef(db, uid).get()).data() || {};
    if (url.pathname === '/api/league' && request.method === 'GET') {
      if (!mine.leagueId) return reply(response, 200, { players: [], tonight: [], name: "Cousins' League" });
      const ownMember = await db.doc('leagues/' + mine.leagueId + '/members/' + uid).get();
      if (!ownMember.exists) return reply(response, 403, { error: 'Join a friends room to enter this league.' });
      const rows = await db.collection('leagues/' + mine.leagueId + '/members').limit(100).get();
      const tonight = await db.collection('leagues/' + mine.leagueId + '/nights/' + leagueNight(Date.now()) + '/members').limit(100).get();
      return reply(response, 200, { name: "Cousins' League", night: leagueNight(Date.now()), players: rows.docs.map(d => visible(d.data(), d.id)), tonight: tonight.docs.map(d => visible(d.data(), d.id)) });
    }
    if (url.pathname !== '/api/profile') return reply(response, 404, { error: 'Not found.' });
    if (request.method === 'PUT') {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 2048) return reply(response, 413, { error: 'Profile is too large.' }); }
      const data = JSON.parse(body);
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name || name.length > 22 || /[\u0000-\u001f\u007f]/.test(name) || !Number.isInteger(data.avatar) || data.avatar < 0 || data.avatar > 15) return reply(response, 400, { error: 'Choose a valid name and avatar.' });
      await connectProfile(uid, name, data.avatar, mine.leagueId);
      return reply(response, 200, { profile: visible((await profileRef(db, uid).get()).data(), uid) });
    }
    const target = url.searchParams.get('uid') || uid;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(target)) return reply(response, 400, { error: 'Invalid player.' });
    if (target !== uid) {
      const together = sharedMatchProfile(rooms, uid, target);
      const member = mine.leagueId && await db.doc('leagues/' + mine.leagueId + '/members/' + target).get();
      if (!together && !member?.exists) return reply(response, 403, { error: 'This profile is outside your league.' });
    }
    const row = (await profileRef(db, target).get()).data();
    if (!row) return reply(response, 404, { error: 'No verified record yet.' });
    reply(response, 200, { profile: visible(row, target) });
  } catch {
    reply(response, configured ? 401 : 503, { error: configured ? 'Could not load your record. Sign in again or retry.' : 'Profiles are not available on this server yet.' });
  }
}
