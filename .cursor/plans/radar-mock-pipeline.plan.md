---
name: Node Radar Mock & Electron Pipeline
overview: Node.js (ws) WebSocket mock backend with 1-20 live-configurable moving-target generators (default 10 Hz), streamed as packed binary frames through an Electron renderer Web Worker into a 2D canvas radar scope with per-generator controls.
todos:
  - id: node-backend
    content: backend/protocol.js, generator.js, server.js (Node + ws), tested with a scripted ws client
    status: completed
  - id: electron-main-lifecycle
    content: main.js spawns/stops backend via Electron's Node runtime; electron-reload scoped to UI files
    status: completed
  - id: renderer-web-worker
    content: renderer/stream-worker.js binary WebSocket ingestion, seq/Hz stats, zero-copy transfer
    status: completed
  - id: radar-canvas-ui
    content: index.html + renderer/app.js per-generator controls, telemetry, canvas scope with trails
    status: completed
  - id: verify-in-electron
    content: Launch the app and verify the UI checklist below (never run in a window yet)
    status: pending
isProject: false
---

# Node Mock Backend & Electron WebSocket Pipeline

## Status (read this first)

- **History:** the backend was first planned and written in Rust/Tokio, but Rust was never installed and that code was never compiled. It was replaced with Node.js on request, and the Rust crate was deleted. Do not look for `backend/Cargo.toml`.
- **Verified:** the Node backend, with a scripted `ws` client. At default settings each generator sends 10 frames/s with 0 gaps, and frame length equals `20 + targets * 32`. Live `updateGenerator` changes work: target count, rate, motion pattern and drop %. Drop % produces `seq` gaps, and pause stops frames. `setGenerators` changes the active count and `state` messages reflect it.
- **NOT verified:** the Electron UI (`index.html`, `renderer/`, `main.js`). It passes Prettier and `node --check`, but has never been launched in a window. Start with the UI checklist below.
- **Not implemented (optional, for hosting):** idle auto-pause when the last client disconnects, an auth token, and a configurable `wss://` URL in the worker.

## Goal and context

- Mock a radar-style tracking backend: continuous data generators, trackable moving objects, position updates at 10 Hz by default, piped to an Electron UI.
- The real source is on-device hardware/firmware feeding a local backend, possibly Rust/Tokio later. The mock uses the same protocol shape so the real backend could replace it without UI changes.
- Pipeline: `Node backend -> binary WebSocket -> renderer Web Worker -> postMessage (transfer) -> UI thread (canvas)`.

## Key design decisions (and why)

- **Renderer connects directly to the backend over WebSocket; Electron Main is not in the data path.** Main only spawns and kills the backend. This avoids an extra hop and keeps Main's single thread free.
- **Packed binary frames, not JSON**, for the data plane. One `ArrayBuffer` per frame instead of thousands of JS objects means less CPU and less GC pressure. JSON is used only for the low-rate control plane.
- **A Web Worker owns the WebSocket** and transfers each `ArrayBuffer` to the UI thread with `postMessage(msg, [buf])`. This is zero-copy because the worker and the UI thread are in the same renderer process. Across OS processes, Electron's `MessagePortMain` cannot transfer buffers; it copies them.
- **The UI draws in `requestAnimationFrame`.** Message handlers only update state, so rendering is decoupled from the data rate.
- **Backpressure lives in the backend.** `broadcastFrame` skips a client whose `ws.bufferedAmount` exceeds 256 KB, so memory stays bounded and the view stays live. `seq` gaps show up as dropped frames in the UI.
- **The backend runs in a separate process**, started by `main.js` with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`. This uses Electron's bundled Node (no system Node needed) and keeps generator timers off Electron's Main thread.
- **Trails are built in the UI** from a fixed-size ring buffer per `generator:track` (40 points). For a real system, per-track history should live in the backend so the UI can resync after gaps or reloads. For the mock this is out of scope.
- **Disk recording** (lossless tee before any UI dropping) is not part of the mock, but would sit before the per-client drop point if added.

## Protocol

**Data plane** (backend -> worker, WebSocket binary, little-endian):

| Bytes  | Type | Field                                                                  |
| ------ | ---- | ---------------------------------------------------------------------- |
| 0..4   | u32  | `generator_id` (1..20)                                                 |
| 4..8   | u32  | `seq` (increments every tick, even when a frame is dropped on purpose) |
| 8..16  | f64  | `timestamp_ms` (Unix epoch)                                            |
| 16..20 | u32  | `target_count`                                                         |
| 20..   |      | `target_count` x 32-byte records                                       |

Target record (32 bytes): `track_id u32`, `x f32`, `y f32`, `z f32`, `vx f32`, `vy f32`, `vz f32`, `class_id u8` (tag index: 0 drone, 1 airplane, 2 helicopter, 3 bird), `strength u8` (signal strength 0-255), `flags u16`. Units are meters relative to the radar at the origin; +y is north.

**Control plane** (WebSocket text, JSON):

- Client -> server:
  - `{"type":"setGenerators","count":1..20}`
  - `{"type":"updateGenerator","id":1..20,"config":{...}}` (partial configs are accepted; missing fields keep their current value)
  - `{"type":"resetGenerator","id":1..20}`
- Server -> client, sent on connect and after every `setGenerators` or `updateGenerator`:
  - `{"type":"state","activeGenerators":N,"generators":[{"id":1,"paused":false,"targetCount":6,"rateHz":10,"motionPattern":"mixed","speedMultiplier":1,"noiseMeters":0,"dropRatePct":0}]}`
- Config ranges (clamped server-side in `sanitizeConfig`): `targetCount` >= 1 (no upper cap), `rateHz` 1-60, `speedMultiplier` 0.2-3.0, `noiseMeters` 0-20, `dropRatePct` 0-50. `motionPattern` is one of `mixed`, `orbit`, `patrol`, `randomWalk`.
- The worker adds messages to the UI that do not come from the backend: `{"type":"stats","generators":{"<id>":{"hz","dropped","received"}}}`, `{"type":"connection","connected":bool}` and `{"type":"frame","buf":ArrayBuffer}`.

## File map

- `backend/protocol.js`: `encodeFrame`, `DEFAULT_CONFIG`, `sanitizeConfig` (validates and clamps untrusted config).
- `backend/generator.js`: `Sim` (orbit / patrol / random-walk entities; `mixed` assigns by `id % 3`) and `Generator` (a `Sim` plus a self-correcting `setTimeout` loop). Pause skips emission. Drop % skips the send but still increments `seq`. Changing the motion pattern respawns targets but keeps track IDs.
- `backend/server.js`: WebSocket server, twenty pre-created `Generator` slots (so each keeps its settings when switched off and on), command handling, state broadcast, graceful shutdown.
  - CLI and env: `--generators N` (default 2), env `BIND` (default `127.0.0.1`), env `PORT` (default `9001`).
  - Run standalone with `npm run backend`.
- `main.js`: spawns the backend as described above and kills it on quit. `electron-reload` watches only `index.html` and `renderer/`.
- `renderer/stream-worker.js`: WebSocket client (reconnect with backoff, 250 ms up to 3 s), seq-gap and Hz stats every 500 ms, relays commands.
- `renderer/app.js`: frame parsing, trails, per-generator control cards (synced from the backend `state`, without overwriting a slider that has focus), canvas drawing.
- `index.html`: layout and styles.
- `package.json`: scripts `start`, `backend`, `format`. Dependencies: `electron`, `electron-reload`, `prettier` (dev) and `ws`.

## UI verification checklist (not yet done)

1. `npm start`: the window opens, the backend starts with the app and exits when the app quits (no orphan `node`/Electron process on port 9001).
2. The connection badge shows "connected". With 2 generators, each card shows about 10.0 Hz and 0 dropped.
3. Switching the count 1..20 starts and stops generators live, and removes cards and trails for stopped ones.
4. Every control takes effect live:
   - Targets: changing the count keeps existing track IDs.
   - Rate: measured Hz tracks the slider.
   - Motion pattern changes respawn targets.
   - Speed visibly changes motion.
   - Noise jitters positions.
   - Drop % raises the dropped counter.
   - Pause stops data and Resume continues without a position jump.
   - Reset re-seeds targets and restarts `seq`.
5. Killing the backend shows "disconnected" and the worker reconnects after a restart (`npm run backend`).

## Hosting on Railway (not built)

- Bind `0.0.0.0` and read `PORT` (already supported through `BIND` and `PORT`).
- The UI must use `wss://` and a configurable URL; the worker currently hardcodes `ws://127.0.0.1:9001`.
- Add an auth token check on connect. A public URL lets anyone reconfigure the generators.
- Consider idle auto-pause when no clients are connected, to save cost.
- Drop the `spawn` call in `main.js` (or put it behind a flag) when the backend is remote.
- The internet adds latency and jitter to a 10 Hz feed; consider buffering and interpolation in the UI.

## Target info and interaction (UI)

- Each target has a persistent fake tag chosen at spawn (`CLASSES` in `backend/generator.js`; the same names are in `CLASS_NAMES` in `renderer/app.js`, so keep the order in sync). Tags set the target's speed range, altitude range, and radar cross-section.
- Signal strength falls off with range and scales with the tag's size. Altitude drifts slowly within the tag's range.
- On-screen ID is `G<generator>-T<track>`, for example `G2-T017`. Track numbers are only unique within a generator.
- Hover a dot (within `HIT_R` px) for a popup: ID and tag, range, azimuth (degrees from north, clockwise), elevation, velocity (speed plus radial component, positive means moving away), and strength. These are computed in the UI from the radar-relative position and velocity (`describe()` in `renderer/app.js`).
- Click a dot, or a row in the left list, to select it: ring, thicker trail and a live panel at the top-left of the scope. The selection stays until Esc (clicking empty space does not release it), or until another target is selected. It is also dropped if the target goes stale or its generator is reset.
- The hit test runs inside the draw loop, which already computes each target's screen position, so it costs no extra pass over the targets.
- With `LABEL_MAX_TRACKS` or fewer targets, every dot also gets its ID written next to it.
- Targets start unidentified (`class_id` 255, shown in italics as "unidentified") and get their real tag after 1-6 seconds of simulated time (`identifyAfter` in `backend/generator.js`). Identified drones and airplanes get an SVG icon on the scope (`ICON_SVG` in `renderer/app.js`); airplanes rotate to their heading. Icons are drawn on every identified target up to `ICON_MAX_TRACKS`, and above that only on highlighted ones. Helicopters and birds have no icon.

### Left panel: target list and per-target actions

- The list shows every target in three sections, top to bottom: **Unknown**, **Enemy**, **Friendly** (each with a count; empty sections are skipped). Targets with no mark count as unknown. Within a section they are sorted by generator then track number. Section headers are rows in the same virtualized list (`GROUPS` / `groupOf` in `renderer/app.js`). The filter box matches ID, tag, or mark.
- Hovering a row highlights that target's dot on the scope. Clicking a row selects it.
- The action bar acts on the selected target:
  - **Friendly / Enemy / Unknown / Clear** colors it green (`#22c55e`), red (`#ef4444`) or yellow (`#eab308`) on the scope and in the list. Generator colors are limited to cyan..magenta (`colorFor`) so they never look like a mark.
  - **Ignore** hides the target from the scope (no dot, trail, label, hover or hit test) but keeps it in the list, dimmed and struck through. "Show ignored" hides those rows too. Select an ignored row and press Unignore to bring it back.
  - **Ignore by type** (chips above the action bar: drone, airplane, helicopter, bird, unidentified) hides every target with that tag from the scope, for example all birds. They stay in the list, dimmed and struck through. A target ignored this way can't be un-ignored individually (its button reads "Ignored by type"); turn the chip off instead. The check is `isIgnored()`, which is re-evaluated every frame because a target's tag changes when it is identified. Chips are not saved to disk. **Ignore by designation** works the same way with friendly / unknown / enemy chips (`ignoredAffils`, via `ignoredByFilter()`); the button then reads "Ignored by filter". Marking a target into a hidden designation hides it.
  - **Trail** sets how many positions that target remembers: 40 (default) to 2,500 points. History from before the change is not recovered; the trail grows from then on. Long trails are thinned to at most `MAX_TRAIL_SAMPLES` points when drawn.
- **Affiliation defaults and right-click menu**: every target is unknown (yellow) until marked, so dots no longer use per-generator colors (`colorKeyOf` returns `mark.affil || "unknown"`). The Friendly/Enemy/Unknown buttons are always green/red/yellow (the current one filled); the Clear button is gone because Unknown is the default. Right-clicking a hovered dot opens `#ctxMenu` (Friendly/Enemy/Unknown) at the pointer. It stays fixed for the target it was opened on until Esc, a choice, or the pointer leaves it.
- **Minimap and zoom**: `view = {x, y, zoom}` in `renderer/app.js` (world point at the scope center, zoom 1..60; clamped inside the radar range, locked to center at 1). Ctrl+drag pans (grab style), ctrl+wheel zooms around the pointer, or on the tracked target / current center when the pointer isn't over the scope. The minimap (top right, `drawMinimap`) draws every target (ignored too, repainted ~10x/s) and the visible area as a rectangle; click or drag on it to move the view. "Reset view" button under it. Distances are always whole meters (`fmtDist`).
- **Range and units**
  - Radar range is 4 km: `WORLD_RADIUS_M` (`renderer/app.js`, rings every `RING_STEP_M` = 1 km) and `WORLD` (`backend/generator.js`) must match. Spawn areas are fractions of `WORLD`; the strength falloff scales with it. Speeds and altitudes are unchanged (real-world values), so motion looks slow at this scale; trails are short in pixels unless the per-target Trail is raised. The backend only reloads on an app restart.
  - Units toggle in the header (Metric / Imperial / **Both** default, saved in `localStorage`). `fmtDist` and `fmtSpeed` format every distance (popup, list rows, range rings) and speed (Velocity, Radial). Generator controls ("Noise m") stay metric because they are simulation inputs.
- Marks live in the `marks` map in `renderer/app.js`, keyed `gen:track`. They survive a target going stale (for example while its generator is paused) but are cleared when its generator is reset or switched off. They are not saved to disk.
- Grouping and ignore-by-type were also checked this way. Verified in a browser against a running backend (served over HTTP, since Chromium blocks Web Workers on `file://`; in Electron they work): list rendering, selection from the list, marking, ignoring, show/hide ignored, filtering, trail length, Esc, list-hover highlight, and the icons. Not verified: the "unidentified" state (it needs the updated backend), and behavior in the real Electron window.
