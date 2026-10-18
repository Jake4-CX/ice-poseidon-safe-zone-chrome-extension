# Safe Zone public map protocol

Reverse engineered from `https://iceposeidon.com/safezone/map` (Astro + React islands, MapLibre).
The relevant client code lives in the obfuscated `cx-client.*.js` chunk. `npm run site:pull`
downloads and deobfuscates the current build into `.site/clean/` for diffing after redeploys.

Verified against ~10 minutes of live traffic on 2026-10-17 (0 decode errors).

## Endpoints

All are public: no auth, no Origin check, `access-control-allow-origin: *`.

| What | URL | Notes |
| --- | --- | --- |
| Live socket | `wss://event-public.iceposeidon.com/public-map-ws` | Server pushes only; the public client never sends anything. permessage-deflate. |
| Snapshot | `GET https://event-public.iceposeidon.com/event/map-snapshot` | `{ frames: ({text} \| {binary: base64})[] }`. A replay of the socket's current baseline. CDN cached ~2s. The site paints from this until the socket's first message arrives. |
| Contestants | `GET https://event-public.iceposeidon.com/event/contestants` | `{ stats_visible, stale, contestants: RosterContestant[] }`. Includes `kick_slug`, `live` and `map_user_id` when populated (it was empty during capture). |
| Config | `GET https://event-public.iceposeidon.com/event/config` | Full game rules (damage, item stats, missile/nuke radii, zombie params) and event status flags. |

`api.iceposeidon.com` is a Hono RPC API (`client.public.x.y.$get()` maps to `GET /public/x/y`). Most
of it needs a logged-in (Kick OAuth) session: store, gambling, stock market, predictions,
polls, robot control. These GETs work anonymously (checked 2026-10-17):

- `GET /public/leaderboards?category=richest|stock_pnl|gambling_net`
- `GET /public/event/predictions` → `{ markets: [] }`
- `GET /public/polls/sigil` → `{ results: [{ sigil, percent }] }`

Contestant activity (shown in the site's player card, polled every 15s while it's open):

- `GET https://event-api.iceposeidon.com/public/event/contestants/:rosterId/damage-log?limit=30`
  → `{ visible, entries: [{id, at, category, text, hp_before, hp_after, icon}], next_before }`.
  CORS allows `https://iceposeidon.com`; CDN cached 30s. Scripted clients are asked to send an
  identifying User-Agent with contact details.

## Text frames (JSON)

`{ "type": ..., "data": ... }`. See `src/core/messages.ts` for the full types.

| type | payload | semantics |
| --- | --- | --- |
| `event` | `{ upstream: "live"\|"down", map: {enabled, anonymous, location_stale_after_ms, damage, blackout}, game: {clock, chest_items, minigames, zombie_speed_mps, ...} }` | Replaces the previous value |
| `contestants` | `{ roster: {stale, stats_visible, contestants[]} \| null, slots: {definition_sequence, slots: [{slot, user_id, username, avatar_url}]} \| null }` | **Slots map the numeric slot ids used by binary frames to users.** `definition_sequence` must match the binary frames' `definitionSequence`. |
| `map_objects` / `map_objects_patch` | objects: `safe_zone` (with optional `transition {from,to,started_at,ends_at,paused_at}`), `circle`, `text`, `image`, `claimable` (chests) | Patch = `{upsert[], remove[]}` by id. The zone moves through frequent patches. **There can be several `safe_zone` objects**; the safe area is their union. |
| `tracked_devices` | `[{id, name, image_url, icon_px, lat, lng, accuracy_m, heading_deg, recorded_at}]` | Non-contestant trackers drawn on the map (e.g. a camera crew). Hidden by the site during a blackout. |
| `game_items` / `game_items_patch` | `{ items: GameItem[], last_known: [{user_id, lat, lng, recorded_at}] }` | Items: gravestone, dropped_item, unsafe_zone, c4, claymore, bubble, tear_gas, crate, care_package_drop, fake_chest, fake_gravestone, ... |
| `explosions` | `[{id, kind, lat, lng, radius_m, at}]` | Transient. The site keeps them for 10s. |
| `heartbeat` | `{ server_time? }` | Clock sync |

Roster contestants (since 2026-10-18) also carry `sigil` and `inventory: [{item: {type, ...stats}, label, icon: {url, badge, alt}, slot_key, stealable}]`.
The site only shows them while `roster.stats_visible` is true.

Usernames are **Kick usernames** (users log in with Kick). `avatar_url` is
`https://data.cx-live.com/v1/kick/avatars?id=<kick user id>&size=64`, and that id equals
`user_id` from `https://kick.com/api/v2/channels/<slug>`. This lets us verify a guessed slug.

## Binary frames

Little-endian. A 36-byte header, then a **columnar** body (all values of field A, then all of field B, ...).

```text
off size field
0   u8   kind             1..8
1   u8   version          1
2   u16  flags            1 = full, 3 = full|clear (empty), 4 = sparse (delta)
4   u32  generation       sequencing epoch (1 so far)
8   u32  sequence         per kind; sparse requires sequence == last+1
12  f64  eventRevision
20  f64  sampledAt        unix ms
28  u16  partIndex        big updates are split into parts with the same sequence
30  u16  partCount
32  u16  recordCount      records in this part
34  u16  reserved = 0
```

Modes: **full** replaces that kind's whole set, **sparse** upserts records, **clear** empties it.
If a sparse frame arrives with a gap, the client must reconnect to get a fresh baseline (the site does the same).

Notation below: `P` = body start, `n` = recordCount, `[i]` = record index.

### Kind 1: contestant locations (`P = 36 + 20`, total `36 + 20 + 11n`)

```text
36  u32 definitionSequence   must equal contestants.slots.definition_sequence
40  f64 ageBaseMs
48  i32 originLat            1e-5 degrees
52  i32 originLng
P+2i      i16 dLat           lat = (originLat + dLat) / 1e5
P+2n+2i   i16 dLng
P+4n+2i   u16 slot
P+6n+2i   u16 age            recordedAt = ageBaseMs - age*100   (if marks&2)
P+8n+2i   u16 accuracy       metres * 10
P+10n+i   u8  marks          bit0 = mock GPS provider, bit1 = has age
```

Positions are therefore quantised to about 1.1 m. Ignore fixes older than the last seen one for that user.

### Kind 2: contestant status (`P = 36 + 12`, 28 bytes/record)

```text
36  u32 definitionSequence
40  f64 timeBase
P+2i      u16 slot
P+2n+i    u8  status   0 disabled, 1 paused, 2 inside, 3 outside, 4 unavailable, 5 eliminated
P+3n+i    u8  badges   bit0 kick_shield, bit1 faith_shield
P+4n+2i   u16 flags    1 alive, 2 poisoned, 4 drone, 8 outside_since, 16 next_damage_at, 32 self
P+6n+i    u8  hp
P+7n+i    u8  maxHp
P+8n+4i   i32 poisonStart   ×100ms + timeBase (if flag 2)
P+12n+4i  i32 poisonEnd
P+16n+4i  i32 droneLandsAt  (flag 4)
P+20n+4i  i32 outsideSince  (flag 8)
P+24n+4i  i32 nextDamageAt  (flag 16)
```

### Kind 4: projectiles (variable-length records starting at 36)

```text
+0  uuid id (16 bytes)
+16 u8  kind     0 missile, 1 nuke, 2 gods_fruit
+17 u8  variant  0 standard, 1 abz
+18 u8  launcherLen
+19 u8  flags    bit0 = trailing spawnedBy uuid
+20 i32 lat, +24 i32 lng, +28 i32 targetLat, +32 i32 targetLng   (1e-7 degrees)
+36 f32 targetRadiusM
+40 f64 landsAt (unix ms)
+48 u32 amount
+52 utf8 launcher name [launcherLen]
    uuid spawnedByUserId (if flags&1)
```

### Kind 7: zombie roster (`P = 36 + 16`, 37 bytes/record)

```text
36  u32 rosterSequence
40  u32 slotsSequence        must equal the slot definition sequence
44  f64 timeBase
P+16i     uuid id
P+16n+2i  u16 ownerSlot      0xFFFF = none
P+18n+4i  i32 expiresAt      ×100ms + timeBase (flags&2)
P+22n+4i  f32 speedMps       (flags&4)
P+26n+4i  f32 leechIntervalSeconds
P+30n+4i  f32 leechRadiusM
P+34n+2i  u16 leechAmount
P+36n+i   u8  flags          1 guard, 2 has expiry, 4 has speed
```

### Kind 8: zombie states (`P = 36 + 20`, `F = P + 9n`, total `F + 6L`)

```text
36  u32 rosterSequence  must equal kind 7's
40  f64 timeBase
48  i32 originLat, 52 i32 originLng   (1e-5)
P+2i      u16 index into the kind-7 roster
P+2n+2i   i16 dLat
P+4n+2i   i16 dLng
P+6n+2i   u16 targetSlot   0xFFFF = none
P+8n+i    u8  leechCount   L = sum of all leechCounts
F+2j      u16 leech slot
F+2L+4j   i32 nextHitAt    ×100ms + timeBase
```

### Kinds 3, 5, 6

3 = entity positions (needs an `entity_definitions` JSON stream that the public socket doesn't send),
5 = "motion"/nearby players, 6 = own health overlay. 5 and 6 are personal and only sent on
authenticated sockets. The public client ignores all three. Kind 6 also carries the contestant's
own `blackout {source: emp|smoke, until}`: an EMP blinds the *contestants'* map.

## Client-side-only restrictions

These are enforced in the site's JavaScript, not on the server:

- **Blackout** (`event.map.blackout`, from EMP or smoke): the site's `Ce()` gate hides
  contestants, health, zombies and items while a blackout is active. It is still unverified whether
  the server keeps streaming positions during a blackout; capture one to find out.
- **Anonymous** (`event.map.anonymous`): the site shows "Contestants are anonymous". What the
  server sends in this mode is unverified.

SafeZone+ mirrors both by default. The event developer confirmed the EMP is meant to stop
contestants seeing each other, not viewers, so Settings → Blackouts can keep players visible
during one. SafeZone+ then draws them itself, at their last received position if updates stop.

## Observed behaviour

- **Zone drift**: the zone usually has no `transition`. The server moves it by patching the
  `safe_zone` centre about every 1.6s. On 2026-10-17 it drifted a steady ~1.0 m/s (3.6 km/h)
  north-west with a constant 1200 m radius. SafeZone+ estimates velocity by least squares over
  the last 5 minutes (`src/core/zone.ts`).
- **Gravestones** (`game_items`, kind `gravestone`) carry
  `grave: { user_id, username, died_at, cause, source, killer_user_id, killer_username, robbed, revive_until }`.
  This is the only source of elimination times. Status frames only flip `alive`/`eliminated`.

## Site renderer internals (used by the extension)

Contestant sprites are drawn on a canvas by a renderer class (`am` in `publicMapScene`). Each
map layer component keeps `useRef({ renderer: { renderer, hoverCard }, state })`, so the
renderer can be reached by walking React fibers down from the map's context provider.
Useful members:

- `tracks: Map<userId, { current: [lng, lat], x, y, box: {left, top, right, bottom}, placedFrame }>`:
  the smoothed (interpolated) sprite positions and their exact screen boxes.
- `hitTest({x, y}) → userId | null`
- `attach(userId, element) → detach()`: pins a DOM element beside the sprite every frame. The
  element's origin is just right of the avatar ring at its vertical centre, and `--cx-ring` holds
  the ring diameter. **Only one element per player**: the site's hover card attaches the same
  way and silently replaces any other, leaving it frozen. SafeZone+ therefore doesn't use it.
  It positions its own overlay each frame from `box` plus `full/compact.layout` instead, where
  `(cx, cy)` is the ring centre and `ring` its diameter, scaled by `boxWidth / layout.width`.
- `hoverCard.fromMarker(userId | null)`: shows or hides the site's native player card.

## Things the site has but doesn't surface

- **Multi-stream viewer**: the map has a built-in viewer for up to 4 `player.kick.com` embeds,
  driven by `roster.contestants[].live/kick_slug`. The roster is currently empty, so it never shows.
- **Mock GPS flag** per location fix (`marks & 1`).
- **Zone transition** (`from → to` with timestamps), which allows "will this player be outside
  after the shrink?" predictions.
