# Charge! Games

Big-screen Bible games your youth group plays from their tables. The TV runs the game; the leader's phone is the remote. No app, no prep.

Live site: https://pastorontherun.github.io/charge-games/

| Path | What it is |
| --- | --- |
| `index.html` | Landing page |
| `sword-drills/` | Sword Drills, big-screen (host) |
| `sword-drills/controller/` | Leader remote (phone) |
| `sword-drills/table/` | Optional table buzzer (any phone or tablet, one per table) |
| `shared/charge-core.js`, `shared/charge-core.css` | Shared core every game uses |
| `shared/vendor/` | PeerJS (MIT, `LICENSE-peerjs.txt`) and qrcode-generator (MIT) |
| `assets/` | Favicon, touch icon, OG image, logo mark |
| `docs/ROADMAP.md` | Large-event mode: architecture, cost tiers, what changes |

Static site with no build step. Serve the folder with any static server, for example `python3 -m http.server`.

## Shared core (`shared/charge-core.js`)

Load `shared/vendor/peerjs.min.js`, `shared/vendor/qrcode.js` (screen only), then `shared/charge-core.js`. Everything sits on `window.Charge`.

### Connection

```js
// Screen (host): owns the room and the game state
const link = Charge.host({
  game: "sworddrills",                 // namespace part: rooms are chargegames-<game>-<code>
  code: savedCode,                     // optional; a new 4-letter code is made if missing
  getState: role => publicState(role), // "remote" gets everything, "player" gets public state only
  onCommand: (a, msg) => run(a, msg),  // from the leader remote only
  onInput: (kind, msg) => input(kind, msg), // from table/player devices only
  onCode: code => {},                  // the code changed (e.g. it was taken)
  onLink: status => {}                 // "on" (remote connected) | "wait" | "off"
});
link.broadcast();                      // push state after any change (debounced 30 ms)
link.remoteUrl("controller/");         // URL with ?room=CODE for the QR code
link.code(); link.setCode(c); link.status(); link.tables();

// Phone (remote or table device)
const R = Charge.remote({ game: "sworddrills", role: "remote" /* or "player" */,
  onState: (s, msg) => render(s), onStatus: (kind, text) => {}, onNotFound: () => {} });
R.join("ABCD"); R.leave(); R.room(); R.state(); R.ok(); R.via(); // "peer" | "mqtt" | "none"
R.send("core.correct", { q, team });   // remote: a command; player: R.send("buzz", { team }) becomes input kind "buzz"
```

### Core model (runs on the host)

`Charge.core(data, opts)` keeps teams, scores, names, buzz-in, lockout and undo inside the game's saved state (`data = Charge.core.fresh(n)`; `Charge.core.upgrade(data)` fills fields added later).

```js
const core = Charge.core(S.core, {
  word: "Table",
  question: slot => key | null,        // key of the question that can be answered now
  isOpen: q => bool,                   // used by undo to restore a buzz
  onCorrect: (team, slot, buzz) => pts,// game marks its question answered, returns points (0 = refuse)
  onUndo: entry => {},                 // game reverses its own part of an award
  onChange: () => save()
});
```

| Method | Does |
| --- | --- |
| `label(i)` | Approved name or "Table 3" |
| `setCount(n)` | 2–50 tables |
| `rename(i, name)` | Leader rename, applied at once, clears a pending request |
| `requestName(team, name, from)` | Table device asks for a name (pending, never shown publicly) |
| `approveName(id, edited?)` / `rejectName(id)` | Leader decision |
| `buzz(team, slot, src)` | Claim the open question. Players: first one wins. The remote can replace a mis-tap |
| `correct(q, team)` | Auto-award the open question's points to the buzzed table |
| `wrong(q, team)` | Clear the buzz and reopen; with lockout on, that table is out for this question |
| `setLockout(on)`, `lockedFor(q)` | Lockout setting and who is out |
| `undo()` | Reverse the last award or Wrong, restoring the buzzed state |
| `pub(role)` | Copy for broadcast; name requests are included for `remote` only |
| `command(a, m)` / `input(kind, m)` | Route core commands and device inputs |
| `reset()` | Scores, names and history back to zero |

Names pass through `Charge.cleanName`: tags (and script/style contents) and control characters removed, spaces collapsed, cut to `Charge.NAME_MAX` (20). Everything is HTML-escaped again when drawn.

### UI pieces

- `Charge.board(el, { mode: "strip" | "full" })`: `render(T, { buzz, locked, finished, hit })`, `show(team)`. Strip: 1 row up to 6 tables, 2 up to 12, 3 dense rows up to 30, then even pages that rotate every 7 s (40 tables = 2 x 20). Full: all 50 fit, ranked by score past 12.
- `Charge.picker(el, { onPick })`: big tiles up to 12; past 12, a search box (number or name, Enter picks a single match) and a dense 4-column grid.
- `Charge.buzzPanel(el, R)`: Correct / Wrong for the buzzed table.
- `Charge.coreSheet(el, R, { onLeave, onReset })`: table count (±1/±5), rename list, lockout, reset, leave.
- `Charge.qr(el, url)`, `Charge.label(T, i)`, `Charge.esc(s)`, `Charge.wake()` (keeps the phone awake where the browser allows it).

## Protocol (version 1)

Every message is JSON: `{ p: 1, t, role, from, id, at, ...body }`.

| `t` | Sender | Body |
| --- | --- | --- |
| `hello` | remote / player | (none); the host replies with state for that role |
| `state` | host | `{ game, code, rev, to: "remote" \| "player", s }` |
| `cmd` | remote | `{ a, ...args }`; the host accepts commands only from role `remote` |
| `input` | player | `{ kind: "name" \| "buzz", team, name? }`; accepted only from role `player` |
| `ping` / `pong` | any / host | keep-alive on the direct link |

Core commands: `core.teams {n | d}`, `core.rename {i, name}`, `core.approve {id, name?}`, `core.reject {id}`, `core.buzz {team, slot}`, `core.correct {q, team}`, `core.wrong {q, team}`, `core.clearbuzz`, `core.lockout {on}`, `core.undo`, `core.reset`. Games add their own, prefixed (`sd.spin`, `sd.wild`, `sd.mode {mode}`, `sd.per {n}`, `sd.final {on}`, `sd.view {v}`).

Duplicate `id`s are dropped, so a message can travel over both paths. A host reload starts a new `rev` sequence (clients reset when `from` changes).

### Transport

1. Direct: PeerJS (WebRTC data channel) to peer id `chargegames-<game>-<code>`.
2. Backup relay: public MQTT over WebSocket (EMQX and HiveMQ public brokers, QoS 0). Topics `chargegames/<game>/<code>/<ch>`: `h` host→remotes (full state), `t` host→tables/players (public state), `r` remotes→host, `p` players→host.

The relay is an adapter with one shape, so it can be swapped for a paid realtime service (see `docs/ROADMAP.md`):

```js
Charge.link.relay(subscribeTopic, onMessage, onOpen) -> { up(), pub(topic, obj), close() }
```

Public brokers are shared and unencrypted: anyone who knows a room code can read its messages. Games send no personal data; team names are the only free text, and they are filtered and approved first.

Debug logging: add `?cgdebug` to any page URL.

© 2026 Charge! Games
