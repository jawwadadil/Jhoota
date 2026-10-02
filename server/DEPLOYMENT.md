# Jhoota Server 0.95

This folder runs online Bluff and team Trump. It does not contain the Android
app, family photos, signing keys, or LiveKit credentials.

## Render Web Service

Connect the GitHub repository containing this `server` folder.

| Field | Value |
| --- | --- |
| Service type | Web Service |
| Runtime | Node |
| Root directory | `server` |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |

Do not enable `ENABLE_TEST_COMMANDS` on the live service. No LiveKit API key
or secret is required for card play or the existing voice-note relay.
Render supplies the listening port. Keep one server instance: rooms are held
in memory and are lost when the service restarts or redeploys.

## Verify Before Inviting Friends

Open `https://jhoota-online-server.onrender.com/health`. The JSON must show:

```json
{
  "ok": true,
  "serverBuild": "0.95",
  "serverProtocol": 7,
  "gameTypes": ["bluff", "trump"]
}
```

The Android server address is `wss://jhoota-online-server.onrender.com`.
Every phone must install version 0.95. A Render loading page is not a passing
health check. Wait for successful JSON and inspect Render's deployment logs
if loading does not finish.

Create a room, share its six-digit code, and have everyone ready up. The host
starts the game. Bluff accepts 2-8 seats. Trump requires equal teams with
4, 6, or 8 seats. Players choose Team A/B; the host can shuffle before the
first game and between games. Team changes reset readiness.

## Tests

```sh
npm ci
npm test
```

Tests include existing Bluff regressions, Trump rules, full multiplayer games
with 4/6/8 players, rematches, chosen teams, shuffled teams, and bot balancing.

## Later Setup

The custom domain is optional. Use the Render address first and configure a
subdomain only after the game works. LiveKit live calls are a separate feature
that is not implemented in this server release. Any future LiveKit secret
must stay in Render's environment settings, never in the APK or repository.
# Live Calls

Save these values as private Render environment variables, not source files:

- `LIVEKIT_URL`: your LiveKit project's secure WebSocket URL.
- `LIVEKIT_API_KEY`: the project's server API key.
- `LIVEKIT_API_SECRET`: the matching secret.

The `/health` response shows `liveCalls: true` only when all three are set.
Calls use LiveKit directly for audio; Render only issues short-lived,
microphone-only tokens to connected game-room members. No camera or recording
feature is enabled. The pinned official LiveKit browser client runs inside the
Android app's audio WebView. Calls end when leaving the game or backgrounding
the app. Voice notes remain independent and the live microphone is muted before
recording a note. Actual two-phone audio must be tested after configuration.

Offline Trump's rules and bot runner are also packaged into the Android APK.
It makes no network requests. Server-only CI skips the local APK mirror check,
but still runs complete offline-engine games for all seat counts and bot levels.

