# Roadmap: large-group mode

Goal: camps, conferences and multi-church nights with hundreds of players, each on their own phone, while the big screen runs the game. Today a room is one screen, one leader remote and up to 50 optional table buzzers.

## Where we are (protocol 1)

- **Roles.** Every message carries `role`: `host` (the big screen, owns the state), `remote` (the leader: commands), `player` (table buzzers today, personal phones later: inputs only). The host checks the role before it acts. Commands come only from `remote`, inputs only from `player`, and players get a public view of the state (no pending name requests).
- **Channels.** `h` host→remotes, `t` host→players, `r` remotes→host, `p` players→host.
- **Transport.** Direct WebRTC (PeerJS) first, with a free public MQTT relay as the backup. The relay sits behind one adapter, `Charge.link.relay(topic, onMsg, onOpen) -> { up, pub, close }`, so a paid service can replace it without touching any game.
- **Limits.** The host sends the whole state on every change, which is fine for about 50 devices. The free signalling server and public brokers have no service guarantee and no privacy (anyone with the room code can read the traffic).

## What changes for large-group mode

1. **Relay adapter for a paid realtime service** (one of the options below). It handles connection, presence and rate limits for hundreds of phones. WebRTC stays only for the leader remote, if at all.
2. **Player channel fan-in.** Hundreds of phones must not each get full state on every change. The host publishes a small public state (current question, open/closed, top 10) on `t`. Each player gets only its own team's score and whether its buzz counted.
3. **Buzz arbitration on the server clock.** With many players, "who was first" has to come from the relay's server timestamp or from a single authoritative room object (Durable Object). Phone clocks can't be trusted for this.
4. **Join tokens.** The screen shows a QR code with a short signed token. The relay checks the token, so strangers who guess a 4-letter code can't join. Leader-remote tokens are separate from player tokens.
5. **Teams of players.** A player picks a team (or is assigned one). `core` gains `members[team]`, and buzzes count per team. Name approval stays as it is: names show nowhere until the leader approves them.
6. **Moderation.** Name approval and lockout already exist. Add kick/ban per device and a cap on submissions per minute.
7. **Account and billing.** A paid tier for large-group mode, with a usage cap per event so a big night can't run up a surprise bill.

## Cost tiers (list prices checked October 2026; confirm before choosing)

| Option | Free tier | Paid entry | Scale notes |
| --- | --- | --- | --- |
| **Ably** | 6M messages/month, 200 concurrent connections, 500 messages/s | Standard from $29/month: up to 10k connections, then $2.50 per million messages | Presence and history built in; server timestamps on every message |
| **Supabase Realtime** | 200 peak connections, 2M messages/month | Pro $25/month: 500 peak connections, 5M messages, then $10 per 1,000 peak connections and $2.50 per million messages | Up to 10k connections with the spend cap off; comes with Postgres if we need accounts later |
| **Cloudflare Durable Objects** (PartyKit / PartyServer) | Workers Free for development | Workers Paid $5/month: 1M requests included, then $0.15 per million; incoming WebSocket messages billed 20:1; hibernation avoids paying for idle time | One object per room = one authoritative clock and state. Cheapest at scale, but we write and run the server code |

Rough sizing: 300 players × 40 questions × about 4 messages each (state, buzz, result) is about 50k messages per event, plus state fan-out. Fan-out is the big number: 300 × the number of state pushes. Keeping the player state small and sending it only on change keeps one event well inside every free tier above. Steady weekly use by many groups is what moves us into a paid tier.

Sources:
- Ably: https://ably.com/pricing, https://ably.com/docs/platform/pricing
- Supabase: https://supabase.com/docs/guides/realtime/pricing, https://supabase.com/docs/guides/realtime/quotas
- Cloudflare: https://developers.cloudflare.com/durable-objects/platform/pricing/, PartyKit: https://docs.partykit.io/

## Not changing

- The big screen stays the source of truth for a normal youth-group night (2–50 tables).
- No student accounts. Phones stay optional for small groups.
- Games show references only, never verse text.
