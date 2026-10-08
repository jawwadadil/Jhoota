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
  "rulesRevision": 106,
  "serverProtocol": 7,
  "gameTypes": ["bluff", "trump"]
}
```

The Android server address is `wss://jhoota-online-server.onrender.com`.
Every phone should install Android build 106 of version 0.95 for shared bot/nearby rules, saved seats and game-night series. A Render loading page is not a passing
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
Session scores and best-of-three/five series are server-authoritative. Seat
recovery requires the phone's private saved token; a matching name cannot
take over someone else's hand. Rooms remain in memory on Render, so a server
restart ends active online rooms. Nearby rooms run on the host phone instead
and do not use Render or LiveKit. The phone bundle is generated from these
same room rules and tested in the private Android workspace.

## Later Setup

The custom domain is optional. Use the Render address first and configure a
subdomain only after the game works. LiveKit live calls are enabled when configured. Any LiveKit secret
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

## Rules Revision 101

- First-game toss is visible for three seconds; the caller sees five cards.
- Same teams: a previous winner calls next, rotating between teammates.
- Changed teams or a drawn game: fresh toss.
- Four seats: 52 cards, 13 each. Revision 103 replaces the former full-double decks:
- Six seats: 72 cards, 12 each (standard 52 plus a second copy of 2-6 per suit).
- Eight seats: 80 cards, 10 each (standard 52 plus a second copy of 2-8 per suit).
- A/K/Q/J/10/9 remain one per suit. Card copies have unique identities.
- Identical highest cards tie in favour of the first played copy.
- A completed hand has a three-second reveal with all final cards visible.
- No play is accepted during toss/reveal; after reveal the centre clears.
- Turn and trump-selection timeouts are server-controlled at 30 seconds.
- Trump timeout selects a legal card; Bluff timeout passes.
- New profiles record only completed games the player participated in.
- Older Trump APKs are blocked from starting the incompatible two-deck rules.

Deploy this server update before testing these rules online. Existing rooms
are lost on redeployment. Leave the existing LiveKit environment variables
unchanged, and confirm `rulesRevision: 103` in `/health` after deployment.

## Results Revision 102

Player hand totals and a hand-by-hand winner history are counted by the shared
online/offline Trump engine. Totals reset for each new game and preserve the
teams that actually played, even after the lobby teams are changed. Only public
winner information is included; no private hands or reserved cards are exposed.
Build 102 presents these counts in a persistent victory screen. Close and
Play Again are explicit actions; room messages do not dismiss the result.

## Balanced Rules Revision 103

Hand winners, scores and gold markers appear immediately on the last play.
Actual played cards remain visible for three seconds before collection; the
next 30-second turn starts only after collection. Final results wait for the
last reveal. Win targets are 7/13, 7/12 and 6/10 for 4/6/8 seats; even ties draw.

Leading trump stays unrestricted by default. The host can enable
`requireTrumpOpened` in the lobby; then a trump lead requires a previously
played trump, except when holding only trump. Following suit always applies.
Changes reset human readiness and cannot affect an ongoing game.

`extendTurn` adds 15 seconds for the current human once per game, including
trump selection. Reveals, expired turns and bot turns cannot be extended.
Chat and call activity do not reset deadlines. Rematches reset the extension.
Android build 103 is required for all human Trump clients. Server revision 103
must be deployed before online testing; an APK alone does not update Render.

