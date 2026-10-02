import { createHmac, randomUUID } from 'node:crypto';

export function liveCallConfigured(env = process.env) {
  try {
    const url = new URL(env.LIVEKIT_URL || '');
    return url.protocol === 'wss:' && Boolean(env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  } catch { return false; }
}

export function liveCallCredentials(room, player, env = process.env, now = Date.now()) {
  if (!liveCallConfigured(env)) throw new Error('Live calls are not configured on this server yet. Voice notes are still available.');
  if (!room.players.includes(player) || player.isBot || !player.connected) throw new Error('Join the game room before joining its call.');
  room.callRoomId ||= `jhoota-${randomUUID()}`;
  const seconds = Math.floor(now / 1000);
  // Standard HS256 JWT, signed only on the server; no API secret reaches a phone.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: env.LIVEKIT_API_KEY, sub: player.id, nbf: seconds - 5, exp: seconds + 300,
    video: { room: room.callRoomId, roomJoin: true, canSubscribe: true, canPublish: true,
      canPublishData: false, canPublishSources: ['microphone'] },
  })).toString('base64url');
  const signature = createHmac('sha256', env.LIVEKIT_API_SECRET).update(`${header}.${payload}`).digest('base64url');
  return { url: env.LIVEKIT_URL, token: `${header}.${payload}.${signature}` };
}
