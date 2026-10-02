import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../call-client.js', import.meta.url), 'utf8');
test('call joins muted, toggles microphone and releases tracks on leave', async () => {
  const statuses = [], rooms = [], audio = [];
  class Room {
    constructor() { this.events = {}; this.remoteParticipants = new Map(); this.activeSpeakers = []; this.mic = [];
      this.localParticipant = { setMicrophoneEnabled: async value => this.mic.push(value) }; rooms.push(this); }
    on(event, fn) { this.events[event] = fn; }
    async connect() { this.open = true; }
    async startAudio() { this.audioStarted = true; }
    async disconnect() { this.open = false; this.events.disconnected?.(); }
  }
  const context = vm.createContext({ window: { CallBridge: { status: s => statuses.push(JSON.parse(s)) },
    LivekitClient: { Room, RoomEvent: { Disconnected: 'disconnected', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed' }, Track: { Kind: { Audio: 'audio' } } } },
    document: { getElementById: () => ({ appendChild: e => audio.push(e), replaceChildren: () => { audio.length = 0; } }) } });
  vm.runInContext(source, context);
  const call = context.window.JhootaCall;
  await call.connect('wss://test', 'test');
  assert.equal(statuses.at(-1).state, 'connected'); assert.equal(statuses.at(-1).muted, true);
  assert.deepEqual(rooms[0].mic, []);
  rooms[0].events.subscribed({ kind: 'audio', attach: () => ({}) }); assert.equal(audio.length, 1);
  await call.setMuted(false); await call.setMuted(true); assert.deepEqual(rooms[0].mic, [true, false]);
  await call.leave(); assert.equal(rooms[0].open, false); assert.equal(audio.length, 0); assert.equal(statuses.at(-1).state, 'idle');
});
test('missing audio SDK gives an actionable error without connecting', async () => {
  let status;
  const context = vm.createContext({ window: { CallBridge: { status: s => { status = JSON.parse(s); } } }, document: { getElementById: () => ({ replaceChildren() {} }) } });
  vm.runInContext(source, context); await context.window.JhootaCall.connect('wss://test', 'test');
  assert.equal(status.state, 'error'); assert.match(status.message, /library/);
});
