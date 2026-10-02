import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { liveCallConfigured, liveCallCredentials } from '../live-call.js';

const env = { LIVEKIT_URL: 'wss://test.livekit.cloud', LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret-not-real' };
test('call configuration requires secure URL and all credentials', () => {
  assert.equal(liveCallConfigured({}), false);
  assert.equal(liveCallConfigured({ ...env, LIVEKIT_API_SECRET: '' }), false);
  assert.equal(liveCallConfigured({ ...env, LIVEKIT_URL: 'http://test' }), false);
  assert.equal(liveCallConfigured(env), true);
});
test('tokens are private, room scoped, short lived and audio only', () => {
  const p = { id: 'opaque-user', connected: true }, room = { players: [p] };
  const result = liveCallCredentials(room, p, env, 1000000);
  const [header, body, signature] = result.token.split('.');
  assert.equal(signature, createHmac('sha256', env.LIVEKIT_API_SECRET).update(`${header}.${body}`).digest('base64url'));
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(claims.sub, p.id); assert.equal(claims.exp, 1300);
  assert.equal(claims.video.room, room.callRoomId);
  assert.deepEqual(claims.video.canPublishSources, ['microphone']);
  assert.equal(claims.video.canPublishData, false);
  assert.equal(liveCallCredentials(room, p, env).token.split('.').length, 3);
  assert.equal(JSON.stringify(result).includes(env.LIVEKIT_API_SECRET), false);
  const other = { players: [p] }; liveCallCredentials(other, p, env);
  assert.notEqual(room.callRoomId, other.callRoomId);
});
test('bots, absent and disconnected players cannot obtain call credentials', () => {
  for (const p of [{ id: 'bot', isBot: true, connected: true }, { id: 'gone', connected: false }]) {
    assert.throws(() => liveCallCredentials({ players: [p] }, p, env));
  }
  assert.throws(() => liveCallCredentials({ players: [] }, { id: 'stranger', connected: true }, env));
});
