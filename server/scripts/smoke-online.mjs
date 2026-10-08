import WebSocket from "ws";

const url = process.env.BLUFF_WS_URL || "ws://127.0.0.1:8080";
const timeoutMs = 8000;
const expectedServerBuild = "0.95";

class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.state = null;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} connect timeout`)), timeoutMs);
      this.ws = new WebSocket(url);
      this.ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        this.messages.push(message);
        if (message.type === "state") this.state = message.state;
      });
      this.ws.on("error", reject);
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`${this.name} timed out waiting for ${label}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  close() {
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }
}

function rankOf(card) {
  return card.slice(0, -1);
}

const testCommandsEnabled = process.env.ENABLE_TEST_COMMANDS === "1";
const host = new Client("Host");
const guest = new Client("Guest");

try {
  await runHttpReadinessScenario();
  await host.connect();
  host.send({ type: "create", name: "Smoke Host", avatarIndex: 2, appVersion: expectedServerBuild });
  await host.waitFor(() => host.messages.some((message) => message.type === "created"), "room creation");
  const created = host.messages.find((message) => message.type === "created");
  const roomId = created.roomId;
  await runRoomStatusScenario(roomId);
  await host.waitFor(() => host.state?.startBlockReason?.includes("Need at least 2"), "single-player start blocker");

  await guest.connect();
  guest.send({ type: "join", roomId, name: "Smoke Guest", avatarIndex: 6, appVersion: expectedServerBuild });
  await guest.waitFor(() => guest.messages.some((message) => message.type === "joined"), "room join");
  await host.waitFor(() => host.state?.playerCount === 2, "host seeing both players");
  const hostAvatar = host.state.players.find((player) => player.name === "Smoke Host")?.avatarIndex;
  const guestAvatar = host.state.players.find((player) => player.name === "Smoke Guest")?.avatarIndex;
  if (hostAvatar !== 2 || guestAvatar !== 6) {
    throw new Error(`Avatar profiles did not synchronize: host=${hostAvatar}, guest=${guestAvatar}`);
  }
  await host.waitFor(() => host.state?.startBlockReason?.includes("Waiting for ready")
    && host.state.startBlockReason.includes("Smoke Guest"), "unready player start blocker");

  await runVoiceRelayScenario(host, guest);
  await runFillBotsScenario();
  await runServerBuildMismatchScenario();

  if (testCommandsEnabled) {
    await runProBotImpossibleClaimScenario();
    await runPassThenBluffJudgesLastPlayerScenario();
    await runBluffAndWinnerScenario(host, guest);
    host.send({ type: "endRoom" });
    await host.waitFor(() => host.messages.some((message) => message.type === "roomEnded"), "room cleanup");
  } else {
    await runMissingRoomScenario();
    await runUniqueNameScenario();
    await runVersionMismatchScenario();
    await runOfflineStartBlockerScenario();
    await runOfflineBotReplacementScenario();
    await runNameFallbackReconnectScenario();
    await runRunningRoomJoinMessageScenario();
    await runRestartRoundScenario();
    await runBasicScenario(host, guest);
    const activeGuest = await runReconnectScenario(host, guest, roomId);
    await runHostTransferScenario(host, activeGuest);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: testCommandsEnabled ? "deep" : "basic",
    roomId,
    players: host.state.playerCount,
    centerCount: host.state.centerCount,
    latestEvent: host.state.latestEvent,
    winner: host.state.winner || "",
  }));
} finally {
  host.close();
  guest.close();
}

async function runHttpReadinessScenario() {
  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const health = await getJson(`${httpUrl}/health`);
  if (!health.ok || health.serverProtocol !== 7 || health.serverBuild !== expectedServerBuild || health.maxPlayers !== 8
      || health.avatarProfiles !== 16
      || !health.heartbeatMs || health.voiceClips !== true || health.maxVoiceDurationMs !== 6000) {
    throw new Error(`Health endpoint is not ready: ${JSON.stringify(health)}`);
  }
  const network = await getJson(`${httpUrl}/network`);
  if (!Array.isArray(network.urls) || network.urls.length === 0 || !network.note?.includes("wss://")) {
    throw new Error(`Network endpoint is not useful: ${JSON.stringify(network)}`);
  }
  const rooms = await getJson(`${httpUrl}/rooms`);
  if (!Array.isArray(rooms.rooms)) {
    throw new Error(`Rooms endpoint is not readable: ${JSON.stringify(rooms)}`);
  }
}

async function runRoomStatusScenario(roomId) {
  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const status = await getJson(`${httpUrl}/room/${roomId}`);
  if (!status.ok || status.room?.id !== roomId || status.room?.playerCount !== 1 || status.room?.serverBuild !== expectedServerBuild
      || status.room?.players?.[0]?.avatarIndex !== 2) {
    throw new Error(`Direct room status is not useful: ${JSON.stringify(status)}`);
  }
  const missing = await fetch(`${httpUrl}/room/000000`);
  if (missing.status !== 404) {
    throw new Error(`Missing direct room status should be 404, got ${missing.status}`);
  }
}

async function runVoiceRelayScenario(host, guest) {
  const audio = Buffer.from("jhoota-voice-smoke").toString("base64");
  const hostVoiceCount = host.messages.filter((message) => message.type === "voice").length;
  const guestVoiceCount = guest.messages.filter((message) => message.type === "voice").length;
  const hostAckCount = host.messages.filter((message) => message.type === "voiceSent").length;

  host.send({ type: "voice", data: audio, mime: "audio/mp4", durationMs: 1500 });
  await guest.waitFor(() => guest.messages.filter((message) => message.type === "voice").length > guestVoiceCount, "voice relay");
  await host.waitFor(() => host.messages.filter((message) => message.type === "voiceSent").length > hostAckCount, "voice sender acknowledgement");
  await host.waitFor(() => host.state?.chat?.some((item) => item.name === "Smoke Host" && item.value === "Voice clip (2s)"), "voice chat marker");

  const relayed = guest.messages.filter((message) => message.type === "voice").at(-1);
  if (relayed.data !== audio || relayed.name !== "Smoke Host" || relayed.mime !== "audio/mp4" || relayed.durationMs !== 1500) {
    throw new Error(`Voice relay changed the clip metadata: ${JSON.stringify(relayed)}`);
  }
  if (host.messages.filter((message) => message.type === "voice").length !== hostVoiceCount) {
    throw new Error("Voice clip echoed back to its sender.");
  }
  if (JSON.stringify(host.state).includes(audio) || JSON.stringify(guest.state).includes(audio)) {
    throw new Error("Voice audio was retained inside room state.");
  }
  if (host.state?.voiceClips !== true || host.state?.maxVoiceDurationMs !== 6000) {
    throw new Error("Room state did not advertise voice clip capability.");
  }

  const errorCount = guest.messages.filter((message) => message.type === "error").length;
  guest.send({ type: "voice", data: "not-base64!", durationMs: 1000 });
  await guest.waitFor(() => guest.messages.filter((message) => message.type === "error").length > errorCount, "invalid voice rejection");
  const rejection = guest.messages.filter((message) => message.type === "error").at(-1);
  if (!String(rejection.message || "").includes("invalid or too large")) {
    throw new Error(`Invalid voice rejection was unclear: ${JSON.stringify(rejection)}`);
  }
}

async function getJson(endpoint) {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}`);
  return response.json();
}

async function runBasicScenario(host, guest) {
  guest.send({ type: "setReady", ready: true });
  await host.waitFor(() => host.state?.canStart, "host auto-ready start available");
  host.send({ type: "start" });
  await host.waitFor(() => host.state?.started && host.state?.hand?.length > 0, "host dealt cards");
  await guest.waitFor(() => guest.state?.started && guest.state?.hand?.length > 0, "guest dealt cards");

  const current = host.state.currentPlayerId === host.state.playerId ? host : guest;
  const hand = current.state.hand;
  const minimum = current.state.minimumOpeningCards || 2;
  const cards = hand.slice(0, Math.min(minimum, hand.length));
  current.send({ type: "play", cards, rank: rankOf(cards[0]) });

  await host.waitFor(() => host.state?.centerCount > 0, "center pile after play");
  const challenger = host.state.currentPlayerId === host.state.playerId ? host : guest;
  challenger.send({ type: "pass" });
  await host.waitFor(() => host.state?.latestEvent?.includes("passed") || host.state?.winner, "pass result");
}

async function runMissingRoomScenario() {
  const missing = new Client("Missing Room");
  try {
    await missing.connect();
    missing.send({ type: "join", roomId: "000000", name: "Lost Friend", appVersion: expectedServerBuild });
    await missing.waitFor(() => missing.messages.some((message) => message.type === "error"), "missing room error");
    const error = missing.messages.find((message) => message.type === "error");
    const message = String(error.message || "").toLowerCase();
    if (error.code !== "ROOM_NOT_FOUND" || !message.includes("paste the latest invite") || !message.includes("create a new room")) {
      throw new Error(`Missing room error was not actionable: ${JSON.stringify(error)}`);
    }
  } finally {
    missing.close();
  }
}

async function runUniqueNameScenario() {
  const sameHost = new Client("Same Name Host");
  const sameGuest = new Client("Same Name Guest");
  try {
    await sameHost.connect();
    sameHost.send({ type: "create", name: "Player", appVersion: expectedServerBuild });
    await sameHost.waitFor(() => sameHost.messages.some((message) => message.type === "created"), "same-name room creation");
    const created = sameHost.messages.find((message) => message.type === "created");

    await sameGuest.connect();
    sameGuest.send({ type: "join", roomId: created.roomId, name: "Player", appVersion: expectedServerBuild });
    await sameGuest.waitFor(() => sameGuest.messages.some((message) => message.type === "joined"), "same-name room join");
    await sameHost.waitFor(() => sameHost.state?.players?.length === 2, "same-name both players visible");
    const names = sameHost.state.players.map((player) => player.name);
    if (new Set(names).size !== names.length || !names.includes("Player") || !names.includes("Player 2")) {
      throw new Error(`Duplicate names were not made unique: ${names.join(", ")}`);
    }
    sameHost.send({ type: "endRoom" });
    await sameHost.waitFor(() => sameHost.messages.some((message) => message.type === "roomEnded"), "same-name cleanup");
  } finally {
    sameHost.close();
    sameGuest.close();
  }
}

async function runFillBotsScenario() {
  const fillHost = new Client("Fill Host");
  try {
    await fillHost.connect();
    fillHost.send({ type: "create", name: "Fill Host", appVersion: expectedServerBuild });
    await fillHost.waitFor(() => fillHost.messages.some((message) => message.type === "created"), "fill room creation");

    fillHost.send({ type: "fillBots", target: 4, difficulty: "Pro" });
    await fillHost.waitFor(() => fillHost.state?.playerCount === 4
      && fillHost.state?.players?.filter((player) => player.isBot && player.difficulty === "Pro").length === 3,
      "fill bots to four seats");

    if (!fillHost.state.canStart) {
      throw new Error(`Fill bots did not unlock start: ${fillHost.state.startBlockReason}`);
    }

    fillHost.send({ type: "fillBots", target: 4, difficulty: "Low" });
    await fillHost.waitFor(() => fillHost.messages.some((message) => message.type === "error"
      && message.message.includes("already has 4")), "fill bots already full enough");

    fillHost.send({ type: "endRoom" });
    await fillHost.waitFor(() => fillHost.messages.some((message) => message.type === "roomEnded"), "fill cleanup");
  } finally {
    fillHost.close();
  }
}

async function runVersionMismatchScenario() {
  const mismatchHost = new Client("Mismatch Host");
  const mismatchGuest = new Client("Mismatch Guest");
  try {
    await mismatchHost.connect();
    mismatchHost.send({ type: "create", name: "Mismatch Host", appVersion: "old" });
    await mismatchHost.waitFor(() => mismatchHost.messages.some((message) => message.type === "created"), "mismatch room creation");
    const created = mismatchHost.messages.find((message) => message.type === "created");

    await mismatchGuest.connect();
    mismatchGuest.send({ type: "join", roomId: created.roomId, name: "Mismatch Guest", appVersion: "new" });
    await mismatchGuest.waitFor(() => mismatchGuest.messages.some((message) => message.type === "joined"), "mismatch room join");
    await mismatchHost.waitFor(() => mismatchHost.state?.versionMismatch, "mismatch warning");

    mismatchHost.send({ type: "setReady", ready: true });
    mismatchGuest.send({ type: "setReady", ready: true });
    await mismatchHost.waitFor(() => mismatchHost.state?.allReady && mismatchHost.state?.canStart === false, "mismatch blocks start button");
    if (!mismatchHost.state.startBlockReason?.includes("same APK version") || !mismatchHost.state.startBlockReason.includes("old / new")) {
      throw new Error(`Version mismatch blocker was unclear: ${mismatchHost.state.startBlockReason}`);
    }
    mismatchHost.send({ type: "start" });
    await mismatchHost.waitFor(() => mismatchHost.messages.some((message) => message.type === "error" && message.message.includes("same APK version")), "mismatch start refused");
    if (mismatchHost.state.started) {
      throw new Error("Version-mismatched room started.");
    }
    mismatchHost.send({ type: "endRoom" });
    await mismatchHost.waitFor(() => mismatchHost.messages.some((message) => message.type === "roomEnded"), "mismatch cleanup");
  } finally {
    mismatchHost.close();
    mismatchGuest.close();
  }
}

async function runServerBuildMismatchScenario() {
  const oldHost = new Client("Old Build Host");
  const oldGuest = new Client("Old Build Guest");
  try {
    await oldHost.connect();
    oldHost.send({ type: "create", name: "Old Build Host", appVersion: "0.92" });
    await oldHost.waitFor(() => oldHost.messages.some((message) => message.type === "created"), "old-build room creation");
    const created = oldHost.messages.find((message) => message.type === "created");

    await oldGuest.connect();
    oldGuest.send({ type: "join", roomId: created.roomId, name: "Old Build Guest", appVersion: "0.92" });
    await oldGuest.waitFor(() => oldGuest.messages.some((message) => message.type === "joined"), "old-build room join");
    oldHost.send({ type: "setReady", ready: true });
    oldGuest.send({ type: "setReady", ready: true });
    await oldHost.waitFor(() => oldHost.state?.allReady
      && oldHost.state?.canStart === false
      && oldHost.state?.serverVersionMismatch === true, "old-build start blocked");
    if (!oldHost.state.startBlockReason?.includes(`server needs APK v${expectedServerBuild}`)
      || !oldHost.state.startBlockReason.includes("0.92")) {
      throw new Error(`Server-build mismatch blocker was unclear: ${oldHost.state.startBlockReason}`);
    }
    oldHost.send({ type: "start" });
    await oldHost.waitFor(() => oldHost.messages.some((message) => message.type === "error"
      && message.message.includes(`latest APK v${expectedServerBuild}`)), "old-build start refused");
    if (oldHost.state.started) {
      throw new Error("Old matching APK versions started on a newer server.");
    }
    oldHost.send({ type: "endRoom" });
    await oldHost.waitFor(() => oldHost.messages.some((message) => message.type === "roomEnded"), "old-build cleanup");
  } finally {
    oldHost.close();
    oldGuest.close();
  }
}

async function runOfflineStartBlockerScenario() {
  const offlineHost = new Client("Offline Start Host");
  const offlineGuest = new Client("Offline Start Guest");
  try {
    await offlineHost.connect();
    offlineHost.send({ type: "create", name: "Offline Host", appVersion: expectedServerBuild });
    await offlineHost.waitFor(() => offlineHost.messages.some((message) => message.type === "created"), "offline-start room creation");
    const created = offlineHost.messages.find((message) => message.type === "created");

    await offlineGuest.connect();
    offlineGuest.send({ type: "join", roomId: created.roomId, name: "Offline Guest", appVersion: expectedServerBuild });
    await offlineGuest.waitFor(() => offlineGuest.messages.some((message) => message.type === "joined"), "offline-start room join");
    await offlineHost.waitFor(() => offlineHost.state?.playerCount === 2, "offline-start host sees guest");

    offlineGuest.close();
    await offlineHost.waitFor(() => offlineHost.state?.offlineHumanCount === 1
      && offlineHost.state?.startBlockReason?.includes("Offline Guest"), "offline-start blocker names guest");
    if (!offlineHost.state.startBlockReason.includes("Kick Offline") || !offlineHost.state.startBlockReason.includes("Bot Offline")) {
      throw new Error(`Offline start blocker did not give recovery actions: ${offlineHost.state.startBlockReason}`);
    }

    offlineHost.send({ type: "replaceOfflineWithBot" });
    await offlineHost.waitFor(() => offlineHost.state?.offlineHumanCount === 0
      && offlineHost.state?.players?.some((player) => player.name.includes("Offline Guest Bot") && player.isBot), "offline-start bot replacement");
    if (!offlineHost.state.canStart) {
      throw new Error(`Host could not start after replacing offline seat: ${offlineHost.state.startBlockReason}`);
    }

    offlineHost.send({ type: "endRoom" });
    await offlineHost.waitFor(() => offlineHost.messages.some((message) => message.type === "roomEnded"), "offline-start cleanup");
  } finally {
    offlineHost.close();
    offlineGuest.close();
  }
}

async function runOfflineBotReplacementScenario() {
  const replacementHost = new Client("Replacement Host");
  const replacementGuest = new Client("Replacement Guest");
  try {
    await replacementHost.connect();
    replacementHost.send({ type: "create", name: "Replacement Host", appVersion: expectedServerBuild });
    await replacementHost.waitFor(() => replacementHost.messages.some((message) => message.type === "created"), "replacement room creation");
    const created = replacementHost.messages.find((message) => message.type === "created");

    await replacementGuest.connect();
    replacementGuest.send({ type: "join", roomId: created.roomId, name: "Replacement Guest", appVersion: expectedServerBuild });
    await replacementGuest.waitFor(() => replacementGuest.messages.some((message) => message.type === "joined"), "replacement room join");
    await replacementHost.waitFor(() => replacementHost.state?.playerCount === 2, "replacement host sees guest");

    replacementGuest.send({ type: "setReady", ready: true });
    await replacementHost.waitFor(() => replacementHost.state?.canStart, "replacement can start");
    replacementHost.send({ type: "start" });
    await replacementHost.waitFor(() => replacementHost.state?.started, "replacement round started");

    replacementGuest.close();
    await replacementHost.waitFor(() => replacementHost.state?.offlineHumanCount === 1, "guest offline before bot replacement");
    if (!replacementHost.state.startBlockReason?.includes("Round is already running")) {
      throw new Error(`Running-round blocker changed unexpectedly: ${replacementHost.state.startBlockReason}`);
    }
    replacementHost.send({ type: "replaceOfflineWithBot" });
    await replacementHost.waitFor(() => replacementHost.state?.offlineHumanCount === 0
      && replacementHost.state?.players?.some((player) => player.name.includes("Replacement Guest Bot") && player.isBot), "offline seat replaced by bot");

    replacementHost.send({ type: "endRoom" });
    await replacementHost.waitFor(() => replacementHost.messages.some((message) => message.type === "roomEnded"), "replacement cleanup");
  } finally {
    replacementHost.close();
    replacementGuest.close();
  }
}

async function runNameFallbackReconnectScenario() {
  const fallbackHost = new Client("Fallback Host");
  const fallbackGuest = new Client("Fallback Guest");
  const fallbackReturn = new Client("Fallback Return");
  try {
    await fallbackHost.connect();
    fallbackHost.send({ type: "create", name: "Fallback Host", appVersion: expectedServerBuild });
    await fallbackHost.waitFor(() => fallbackHost.messages.some((message) => message.type === "created"), "fallback room creation");
    const created = fallbackHost.messages.find((message) => message.type === "created");

    await fallbackGuest.connect();
    fallbackGuest.send({ type: "join", roomId: created.roomId, name: "Lost Phone", appVersion: expectedServerBuild });
    await fallbackGuest.waitFor(() => fallbackGuest.messages.some((message) => message.type === "joined"), "fallback guest join");
    fallbackGuest.send({ type: "setReady", ready: true });
    await fallbackHost.waitFor(() => fallbackHost.state?.canStart, "fallback can start");
    fallbackHost.send({ type: "start" });
    await fallbackGuest.waitFor(() => fallbackGuest.state?.started && fallbackGuest.state?.hand?.length > 0, "fallback guest dealt");
    const originalHandCount = fallbackGuest.state.hand.length;

    fallbackGuest.close();
    await fallbackHost.waitFor(() => fallbackHost.state?.players?.some((player) => player.name === "Lost Phone" && !player.connected), "fallback guest offline");

    await fallbackReturn.connect();
    fallbackReturn.send({ type: "join", roomId: created.roomId, name: " lost   phone ", appVersion: expectedServerBuild });
    await fallbackReturn.waitFor(() => fallbackReturn.messages.some((message) => message.type === "error"), "same-name seat takeover refused");
    if (fallbackReturn.messages.some(message => message.type === "joined")) throw new Error("Name-only reconnect exposed a private hand.");
    const originalSeat = fallbackGuest.messages.find(message => message.type === "joined");
    fallbackReturn.send({ type: "join", roomId: created.roomId, name: "Lost Phone", reconnectToken: originalSeat.reconnectToken, appVersion: expectedServerBuild });
    await fallbackReturn.waitFor(() => fallbackReturn.messages.some((message) => message.type === "joined"), "saved-token rejoin");
    await fallbackHost.waitFor(() => fallbackHost.state?.players?.some((player) => player.name.toLowerCase() === "lost phone" && player.connected), "fallback restored seat visible");
    if (!fallbackReturn.state?.started || fallbackReturn.state.hand.length !== originalHandCount) {
      throw new Error("Same-name fallback reconnect did not restore the offline hand.");
    }
    if (fallbackHost.state.playerCount !== 2) {
      throw new Error(`Same-name fallback created an extra seat: ${fallbackHost.state.playerCount}`);
    }
    if (!fallbackHost.state.players.some((player) => player.name.toLowerCase() === "lost phone" && player.connected)) {
      throw new Error("Same-name fallback seat is not connected.");
    }

    fallbackHost.send({ type: "endRoom" });
    await fallbackHost.waitFor(() => fallbackHost.messages.some((message) => message.type === "roomEnded"), "fallback cleanup");
  } finally {
    fallbackHost.close();
    fallbackGuest.close();
    fallbackReturn.close();
  }
}

async function runRunningRoomJoinMessageScenario() {
  const runningHost = new Client("Running Host");
  const runningGuest = new Client("Running Guest");
  const lateGuest = new Client("Late Guest");
  try {
    await runningHost.connect();
    runningHost.send({ type: "create", name: "Running Host", appVersion: expectedServerBuild });
    await runningHost.waitFor(() => runningHost.messages.some((message) => message.type === "created"), "running room creation");
    const created = runningHost.messages.find((message) => message.type === "created");

    await runningGuest.connect();
    runningGuest.send({ type: "join", roomId: created.roomId, name: "Running Guest", appVersion: expectedServerBuild });
    await runningGuest.waitFor(() => runningGuest.messages.some((message) => message.type === "joined"), "running guest join");
    runningGuest.send({ type: "setReady", ready: true });
    await runningHost.waitFor(() => runningHost.state?.canStart, "running room can start");
    runningHost.send({ type: "start" });
    await runningHost.waitFor(() => runningHost.state?.started, "running room started");

    await lateGuest.connect();
    lateGuest.send({ type: "join", roomId: created.roomId, name: "Different Friend", appVersion: expectedServerBuild });
    await lateGuest.waitFor(() => lateGuest.messages.some((message) => message.type === "error"), "late guest refused");
    const error = lateGuest.messages.find((message) => message.type === "error")?.message || "";
    if (!error.includes("Rejoin Friends") || !error.includes("Bot Offline") || !error.includes("Restart Round")) {
      throw new Error(`Running-room join error is not actionable: ${error}`);
    }

    runningHost.send({ type: "endRoom" });
    await runningHost.waitFor(() => runningHost.messages.some((message) => message.type === "roomEnded"), "running cleanup");
  } finally {
    runningHost.close();
    runningGuest.close();
    lateGuest.close();
  }
}

async function runRestartRoundScenario() {
  const restartHost = new Client("Restart Host");
  const restartGuest = new Client("Restart Guest");
  try {
    await restartHost.connect();
    restartHost.send({ type: "create", name: "Restart Host", appVersion: expectedServerBuild });
    await restartHost.waitFor(() => restartHost.messages.some((message) => message.type === "created"), "restart room creation");
    const created = restartHost.messages.find((message) => message.type === "created");

    await restartGuest.connect();
    restartGuest.send({ type: "join", roomId: created.roomId, name: "Restart Guest", appVersion: expectedServerBuild });
    await restartGuest.waitFor(() => restartGuest.messages.some((message) => message.type === "joined"), "restart room join");
    restartGuest.send({ type: "setReady", ready: true });
    await restartHost.waitFor(() => restartHost.state?.canStart, "restart can start");
    restartHost.send({ type: "start" });
    await restartHost.waitFor(() => restartHost.state?.started && restartGuest.state?.started, "restart initial deal");

    const current = restartHost.state.currentPlayerId === restartHost.state.playerId ? restartHost : restartGuest;
    const cards = current.state.hand.slice(0, current.state.minimumOpeningCards || 2);
    current.send({ type: "play", cards, rank: rankOf(cards[0]) });
    await restartHost.waitFor(() => restartHost.state?.centerCount > 0, "restart has center pile");

    const firstRound = restartHost.state.roundNumber;
    restartHost.send({ type: "restartRound" });
    await restartHost.waitFor(() => restartHost.state?.roundNumber === firstRound + 1
      && restartHost.state?.centerCount === 0
      && restartHost.state?.log?.some((line) => line.includes("restarted")), "round restarted");

    restartHost.send({ type: "endRoom" });
    await restartHost.waitFor(() => restartHost.messages.some((message) => message.type === "roomEnded"), "restart cleanup");
  } finally {
    restartHost.close();
    restartGuest.close();
  }
}

async function readyAll(host, guest) {
  host.send({ type: "setReady", ready: true });
  guest.send({ type: "setReady", ready: true });
  await host.waitFor(() => host.state?.allReady, "all players ready");
}

async function runReconnectScenario(host, guest, roomId) {
  const joined = guest.messages.find((message) => message.type === "joined");
  if (!joined?.reconnectToken) throw new Error("Guest reconnect token missing.");
  guest.close();
  await host.waitFor(() => host.state?.players?.some((player) => player.name === "Smoke Guest" && !player.connected), "guest offline state");

  const rejoinedGuest = new Client("Guest Reconnect");
  await rejoinedGuest.connect();
  rejoinedGuest.send({ type: "join", roomId, name: "Smoke Guest", avatarIndex: 6, reconnectToken: joined.reconnectToken, appVersion: expectedServerBuild });
  await rejoinedGuest.waitFor(() => rejoinedGuest.messages.some((message) => message.type === "joined"), "guest reconnect join");
  await host.waitFor(() => host.state?.players?.some((player) => player.name === "Smoke Guest" && player.connected), "guest online after reconnect");
  return rejoinedGuest;
}

async function runHostTransferScenario(host, guest) {
  host.close();
  await guest.waitFor(() => guest.state?.hostId === guest.state?.playerId, "guest promoted to host");
  if (!guest.state.players.some((player) => player.name === "Smoke Host" && !player.connected)) {
    throw new Error("Disconnected host was not marked offline.");
  }
  guest.send({ type: "endRoom" });
  await guest.waitFor(() => guest.messages.some((message) => message.type === "roomEnded"), "guest cleanup after host transfer");
  guest.close();
}

async function runProBotImpossibleClaimScenario() {
  const botHost = new Client("Bot Host");
  const botGuest = new Client("Bot Guest");
  try {
    await botHost.connect();
    botHost.send({ type: "create", name: "Bot Host", appVersion: expectedServerBuild });
    await botHost.waitFor(() => botHost.messages.some((message) => message.type === "created"), "bot room creation");
    const created = botHost.messages.find((message) => message.type === "created");

    await botGuest.connect();
    botGuest.send({ type: "join", roomId: created.roomId, name: "Bot Guest", appVersion: expectedServerBuild });
    await botGuest.waitFor(() => botGuest.messages.some((message) => message.type === "joined"), "bot guest join");
    botHost.send({ type: "addBot", difficulty: "Pro" });
    await botHost.waitFor(() => botHost.state?.players?.some((player) => player.isBot && player.difficulty === "Pro"), "pro bot added");

    botHost.send({
      type: "testSetup",
      currentIndex: 1,
      hands: [
        ["5C", "6C"],
        ["2S", "3S"],
        ["AH", "AD", "AC", "AS"],
      ],
    });
    await botHost.waitFor(() => botHost.state?.started && botHost.state?.players?.length === 3, "pro bot setup");
    botGuest.send({ type: "play", cards: ["2S", "3S"], rank: "A" });
    await botHost.waitFor(() => botHost.state?.lastBluffResult?.includes("caught Bot Guest"), "pro bot caught impossible claim");
    const accused = botHost.state.players.find((player) => player.name === "Bot Guest");
    if (!accused || accused.cardCount !== 2) {
      throw new Error("Pro bot did not make the impossible-claim loser pick up the pile.");
    }
    const proBot = botHost.state.players.find((player) => player.isBot && player.difficulty === "Pro");
    if (!proBot || botHost.state.currentPlayerId !== proBot.id) {
      throw new Error("Pro bot did not get the next rank call after correct bluff.");
    }

    botHost.send({ type: "endRoom" });
    await botHost.waitFor(() => botHost.messages.some((message) => message.type === "roomEnded"), "bot cleanup");
  } finally {
    botHost.close();
    botGuest.close();
  }
}

async function runPassThenBluffJudgesLastPlayerScenario() {
  const passHost = new Client("Pass Bluff Host");
  const passer = new Client("Pass Bluff Passer");
  const challenger = new Client("Pass Bluff Challenger");
  try {
    await passHost.connect();
    passHost.send({ type: "create", name: "Pass Host", appVersion: expectedServerBuild });
    await passHost.waitFor(() => passHost.messages.some((message) => message.type === "created"), "pass-bluff room creation");
    const created = passHost.messages.find((message) => message.type === "created");

    await passer.connect();
    passer.send({ type: "join", roomId: created.roomId, name: "Passer", appVersion: expectedServerBuild });
    await passer.waitFor(() => passer.messages.some((message) => message.type === "joined"), "passer join");

    await challenger.connect();
    challenger.send({ type: "join", roomId: created.roomId, name: "Challenger", appVersion: expectedServerBuild });
    await challenger.waitFor(() => challenger.messages.some((message) => message.type === "joined"), "challenger join");
    await passHost.waitFor(() => passHost.state?.players?.length === 3, "three-player pass-bluff room");

    passHost.send({
      type: "testSetup",
      currentIndex: 0,
      hands: [
        ["2S", "3S", "9S"],
        ["4H", "5H"],
        ["AH", "AD"],
      ],
    });
    await passHost.waitFor(() => passHost.state?.started && hasCards(passHost.state?.hand, ["2S", "3S"]), "pass-bluff setup");
    passHost.send({ type: "play", cards: ["2S", "3S"], rank: "A" });
    await passer.waitFor(() => passer.state?.canBluff && passer.state?.currentPlayerId === passer.state?.playerId, "passer can act");

    challenger.send({ type: "bluff" });
    await challenger.waitFor(() => challenger.messages.some((message) => message.type === "error" && message.message.includes("not your turn")), "non-turn bluff refused");
    if (passHost.state.centerCount !== 2 || passHost.state.lastMovePlayerName !== "Pass Host") {
      throw new Error("Non-turn bluff changed the active claim.");
    }

    passer.send({ type: "pass" });
    await challenger.waitFor(() => challenger.state?.currentPlayerId === challenger.state?.playerId
      && challenger.state?.canBluff
      && challenger.state?.lastMovePlayerName === "Pass Host", "challenger can judge pre-pass player");
    challenger.send({ type: "bluff" });
    await passHost.waitFor(() => passHost.state?.lastBluffResult?.includes("caught Pass Host"), "pass-then-bluff caught original player");
    const accused = passHost.state.players.find((player) => player.name === "Pass Host");
    if (!accused || accused.cardCount !== 3) {
      throw new Error("Bluff after a pass did not make the original liar pick up the pile.");
    }
    if (challenger.state.currentPlayerId !== challenger.state.playerId) {
      throw new Error("Correct challenger after a pass did not get the next rank call.");
    }

    passHost.send({ type: "endRoom" });
    await passHost.waitFor(() => passHost.messages.some((message) => message.type === "roomEnded"), "pass-bluff cleanup");
  } finally {
    passHost.close();
    passer.close();
    challenger.close();
  }
}

async function runBluffAndWinnerScenario(host, guest) {
  host.send({
    type: "testSetup",
    currentIndex: 0,
    hands: [
      ["2S", "3S"],
      ["AH", "AD", "AC"],
    ],
  });
  await host.waitFor(() => host.state?.started && hasCards(host.state?.hand, ["2S", "3S"]), "test setup");

  host.send({ type: "play", cards: ["2S", "3S"], rank: "A" });
  await guest.waitFor(() => guest.state?.centerCount === 2 && guest.state?.canBluff, "bluffable lie");
  guest.send({ type: "bluff" });
  await host.waitFor(() => host.state?.lastBluffResult?.includes("caught"), "caught bluff result");
  if (host.state.players.find((player) => player.name === "Smoke Host")?.cardCount !== 2) {
    throw new Error("Caught player did not pick up the pile.");
  }
  if (guest.state.currentPlayerId !== guest.state.playerId) {
    throw new Error("Correct bluff caller did not get the next rank call.");
  }

  host.send({
    type: "testSetup",
    currentIndex: 0,
    hands: [
      ["KS"],
      ["2D", "3D", "4D"],
    ],
  });
  await host.waitFor(() => hasCards(host.state?.hand, ["KS"]), "single-card setup");
  host.send({ type: "play", cards: ["KS"], rank: "K" });
  await host.waitFor(() => host.messages.some((message) => message.type === "error" && message.message.includes("one card")), "single-card opening rejection");
  if (host.state.centerCount !== 0 || host.state.currentPlayerId !== host.state.playerId) {
    throw new Error("Single-card player was allowed to open a fresh claim.");
  }

  host.send({
    type: "testSetup",
    currentIndex: 0,
    hands: [
      ["AS", "AH"],
      ["2D", "3D", "4D"],
    ],
  });
  await host.waitFor(() => hasCards(host.state?.hand, ["AS", "AH"]), "winner setup");
  host.send({ type: "play", cards: ["AS", "AH"], rank: "A" });
  await guest.waitFor(() => guest.state?.pendingWinnerName === "Smoke Host", "pending winner");
  guest.send({ type: "bluff" });
  await host.waitFor(() => host.state?.winner === "Smoke Host", "honest final play winner");
  const hostPlayer = host.state.players.find((player) => player.name === "Smoke Host");
  if (!hostPlayer || hostPlayer.wins < 1) {
    throw new Error("Winner score was not incremented.");
  }
  if (host.state.scoreLeaderName !== "Smoke Host" || host.state.scoreLeaderWins < 1 || !host.state.scoreSummary.includes("Smoke Host:")) {
    throw new Error("Score leader summary was not sent after winner.");
  }

  host.send({
    type: "testSetup",
    currentIndex: 0,
    hands: [
      ["QS", "QH"],
      ["2D", "3D", "4D"],
    ],
  });
  await host.waitFor(() => hasCards(host.state?.hand, ["QS", "QH"]), "final-pass setup");
  host.send({ type: "play", cards: ["QS", "QH"], rank: "Q" });
  await guest.waitFor(() => guest.state?.pendingWinnerName === "Smoke Host", "final-pass pending winner");
  guest.send({ type: "pass" });
  await host.waitFor(() => host.state?.winner === "Smoke Host" && host.state?.winnerReason === "Final play was passed.", "final pass winner");

  host.send({ type: "start" });
  await host.waitFor(() => host.messages.some((message) => message.type === "error" && message.message.includes("ready up again")), "rematch start blocked until ready");
  host.send({ type: "setReady", ready: true });
  guest.send({ type: "setReady", ready: true });
  await host.waitFor(() => host.state?.canStart, "rematch can start after ready");
  host.send({ type: "start" });
  await host.waitFor(() => host.state?.started && !host.state?.winner && host.state?.roundNumber >= 4, "rematch started after ready");

  host.send({
    type: "testSetup",
    currentIndex: 1,
    hands: [
      ["AS", "AC"],
      ["2H", "2D", "4H"],
    ],
  });
  await guest.waitFor(() => hasCards(guest.state?.hand, ["2H", "2D", "4H"]), "wrong-call setup");
  guest.send({ type: "play", cards: ["2H", "2D"], rank: "2" });
  await host.waitFor(() => host.state?.canBluff && host.state?.centerCount === 2, "wrong-call bluffable honest move");
  host.send({ type: "bluff" });
  await guest.waitFor(() => guest.state?.lastBluffResult?.includes("was wrong"), "wrong bluff result");
  if (guest.state.currentPlayerId !== guest.state.playerId) {
    throw new Error("Honest accused did not get the next rank call after wrong bluff.");
  }

  host.send({
    type: "testSetup",
    currentIndex: 0,
    hands: [
      ["8S", "9S", "10S"],
      ["2C", "3C", "4C"],
    ],
  });
  await host.waitFor(() => hasCards(host.state?.hand, ["8S", "9S"]), "pass-clear setup");
  host.send({ type: "play", cards: ["8S", "9S"], rank: "8" });
  await guest.waitFor(() => guest.state?.centerCount === 2 && guest.state?.currentPlayerId === guest.state?.playerId, "pass-clear guest turn");
  guest.send({ type: "pass" });
  await host.waitFor(() => host.state?.currentPlayerId === host.state?.playerId && host.state?.centerCount === 2, "pass-clear host turn");
  host.send({ type: "pass" });
  await guest.waitFor(() => guest.state?.centerCount === 0 && guest.state?.activeRank == null
    && guest.state?.latestEvent?.includes("removed"), "everyone passed clears center");

  host.send({
    type: "testSetup",
    currentIndex: 1,
    hands: [
      ["5S", "5H"],
      ["6D", "7D"],
    ],
  });
  await guest.waitFor(() => guest.state?.currentPlayerId === guest.state?.playerId, "offline-skip setup");
  guest.close();
  await host.waitFor(() => host.state?.players?.some((player) => player.name === "Smoke Guest" && !player.connected), "current player offline");
  host.send({ type: "skipOfflineTurn" });
  await host.waitFor(() => host.state?.currentPlayerId === host.state?.playerId, "offline turn skipped to host");
}

function hasCards(hand, expected) {
  if (!Array.isArray(hand)) return false;
  return expected.every((card) => hand.includes(card));
}

