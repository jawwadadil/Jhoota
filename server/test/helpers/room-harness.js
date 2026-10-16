import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

// Exercise the canonical room functions, replacing only transport and time.
export function roomHarness() {
  let now = 1000, nextTimer = 0;
  const timers = new Map(), states = new Map(), messages = [];
  const context = vm.createContext({
    process: { env: {} }, PORT: 0, HOST: '127.0.0.1', randomUUID,
    os: { networkInterfaces: () => ({}) },
    cloud: { admitLeaguePlayers() {}, recordProfileResult() {} },
    liveCallConfigured: () => false,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  for (const file of ['trump.js', 'game-night.js', 'bluff-ai.js']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
    vm.runInContext(`Object.assign(globalThis, (() => { ${source.replace(/^export /gm, '')}\nreturn {${names.join(',')}}; })());`, context);
  }
  const source = readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const RANKS ='), source.indexOf('const httpServer =')) +
    source.slice(source.indexOf('function handle(')), context);
  const h = {
    states, messages, timers, get now() { return now; },
    open(id) {
      return { readyState: 1, send(data) { const message = JSON.parse(data); messages.push({ client: id, ...message }); if (message.state) states.set(id, message.state); }, close() { this.readyState = 3; h.disconnect(this); } };
    },
    send(socket, message) { context.handle(socket, message); },
    disconnect(socket) { socket.readyState = 3; const room = h.room(socket); if (room) context.disconnectPlayer(room, socket); },
    room(socket) { return vm.runInContext('rooms', context).get(socket.roomId); },
    broadcast(room) { context.broadcast(room); },
    state(room, viewer) { return JSON.parse(JSON.stringify(context.stateFor(room, viewer))); },
    advance(ms) {
      const target = now + ms;
      let steps = 0;
      while (steps++ < 10000) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = target;
    },
    join(id, roomId, reconnectToken) {
      const socket = h.open(id);
      h.send(socket, { type: 'join', roomId, name: id, avatarIndex: 4, appVersion: '0.95', appBuild: 113, reconnectToken });
      return socket;
    },
  };
  return h;
}

export function table(gameType = 'bluff') {
  const h = roomHarness(), host = h.open('Host');
  h.send(host, { type: 'create', name: 'Host', avatarIndex: 2, appVersion: '0.95', appBuild: 113, gameType });
  const room = h.room(host), guest = h.join('Guest', room.id);
  return { h, host, guest, room };
}
