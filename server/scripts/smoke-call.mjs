import assert from 'node:assert/strict';
import WebSocket from 'ws';
const url = process.env.BLUFF_WS_URL || 'ws://127.0.0.1:8080';
const http = url.replace(/^ws/, 'http');
const clients = [];
async function client() {
  const socket = new WebSocket(url); const messages = []; clients.push(socket);
  socket.on('message', raw => messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, messages, send: data => socket.send(JSON.stringify(data)) };
}
async function wait(client, type, from = 0) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const message = client.messages.slice(from).find(m => m.type === type);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw Error('Timed out waiting for ' + type);
}
try {
  const page = await fetch(http + '/call'); assert.equal(page.status, 200);
  assert.match(await page.text(), /livekit-client@2\.17\.2/);
  assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);
  const a = await client(); a.send({ type: 'liveCallToken' });
  assert.match((await wait(a, 'error')).message, /Join a room/);
  a.send({ type: 'create', name: 'Call Test A', gameType: 'bluff', appVersion: '0.95' });
  const state = (await wait(a, 'state')).state; assert.equal(state.liveCalls, true);
  a.send({ type: 'liveCallToken' }); const credentials = await wait(a, 'liveCallToken');
  const claims = JSON.parse(Buffer.from(credentials.token.split('.')[1], 'base64url'));
  assert.equal(claims.sub, state.playerId); assert.equal(credentials.roomId, state.roomId);
  const b = await client(); b.send({ type: 'create', name: 'Call Test B', gameType: 'trump', appVersion: '0.95' });
  await wait(b, 'state'); b.send({ type: 'liveCallToken' }); const other = await wait(b, 'liveCallToken');
  assert.notEqual(JSON.parse(Buffer.from(other.token.split('.')[1], 'base64url')).video.room, claims.video.room);
  const before = a.messages.length; a.send({ type: 'liveCallToken' });
  assert.match((await wait(a, 'liveCallError', before)).message, /Wait a moment/);
  console.log('Call page, membership, identity, room isolation and retry limit passed.');
} finally { for (const socket of clients) socket.close(); }
