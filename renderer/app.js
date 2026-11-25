const HEADER_BYTES = 20;
const RECORD_BYTES = 32;
const TRAIL_LEN = 40; // 4s at 10 Hz; trails longer than this are thinned when drawn
const DEFAULT_TRAIL_LEN = 1000; // default trail capacity in points
const WORLD_RADIUS_M = 4000; // scope range (match WORLD in backend/generator.js)
const RING_STEP_M = 1000;

// Map background: "off" | "streets" | "satellite" | "hybrid" (see drawMap).
let mapLayer = localStorage.getItem("mapLayer") || "satellite";

// --- Units --------------------------------------------------------------
// "both" (default) shows metric with imperial in parentheses.
const M_PER_MILE = 1609.344;
const MPH_PER_MS = 2.236936;
let units = localStorage.getItem("units") || "both"; // "metric" | "imperial" | "both"

const withUnits = (metric, imperial) =>
  units === "metric"
    ? metric
    : units === "imperial"
      ? imperial
      : `${metric} (${imperial})`;

// Distance in meters -> "1,250 m (0.777 mi)"
function fmtDist(m) {
  const mi = m / M_PER_MILE;
  return withUnits(
    `${Math.round(m).toLocaleString()} m`, // always whole meters
    `${mi.toFixed(Math.abs(mi) < 1 ? 3 : 2)} mi`,
  );
}

// Height in meters -> "85 m (279 ft)"
const FT_PER_M = 3.28084;
function fmtHeight(m) {
  return withUnits(
    `${Math.round(m).toLocaleString()} m`,
    `${Math.round(m * FT_PER_M).toLocaleString()} ft`,
  );
}

// Speed in m/s -> "10.9 m/s (24.4 mph)"; `signed` adds a + for positive values.
function fmtSpeed(ms, signed = false) {
  const sign = signed && ms >= 0 ? "+" : "";
  return withUnits(
    `${sign}${ms.toFixed(1)} m/s`,
    `${sign}${(ms * MPH_PER_MS).toFixed(1)} mph`,
  );
}
const STALE_MS = 2000;
const MAX_GENERATORS = 20;
// Target tags, indexed by the frame's `class_id`. Same order as the backend's CLASSES.
const CLASS_NAMES = ["drone", "airplane", "helicopter", "bird"];
const UNIDENTIFIED = 255; // class_id before a target has been identified
const ICON_MAX_TRACKS = 300; // draw drone/airplane icons on every identified target up to this many
const ROW_H = 26; // target list row height in px (matches .trow in index.html)
const HIT_R = 10; // px: how close the pointer must be to a dot to hover it
const LABEL_MAX_TRACKS = 60; // write IDs next to every dot up to this many targets
const DOT_R = 3;
const TRAIL_SAMPLES = 8; // points actually drawn per default-length trail
const MAX_TRAIL_SAMPLES = 200; // points drawn for a long trail (it is thinned to this)
const MAX_PATH_OPS = 50000; // flush a canvas path before it gets this big
const sample = new Float32Array(MAX_TRAIL_SAMPLES * 2); // scratch buffer for draw()

// Colors for marked targets. Generator colors below avoid these hues.
const AFFIL_COLOR = {
  friendly: "#22c55e",
  enemy: "#ef4444",
  unknown: "#eab308",
  neutral: "#94a3b8",
};

// Generator colors: golden-angle steps within cyan..magenta, so they never
// look like the friendly (green) / enemy (red) / unknown (yellow) marks.
const colorFor = (id) => `hsl(${180 + (((id - 1) * 137.508) % 150)} 80% 62%)`;

const worker = new Worker("renderer/stream-worker.js");

// --- Controls schema --------------------------------------------------
const CONTROLS = [
  { key: "targetCount", label: "Targets", type: "number", min: 1, step: 1 },
  { key: "rateHz", label: "Rate Hz", min: 1, max: 60, step: 1 },
  { key: "speedMultiplier", label: "Speed", min: 0.2, max: 3, step: 0.1 },
  { key: "noiseMeters", label: "Noise m", min: 0, max: 20, step: 0.5 },
  { key: "dropRatePct", label: "Drop %", min: 0, max: 50, step: 1 },
];
const PATTERNS = ["mixed", "orbit", "patrol", "randomWalk"];

// --- State ------------------------------------------------------------
let activeGenerators = 0;
let genConfigs = new Map(); // id -> config from backend
let genStats = {}; // id -> { hz, dropped, received }
const cards = new Map(); // id -> { el, inputs, telemetry, pauseBtn }

// "gen:track" -> { gen, id, key, mark, cap, pts: Float32Array(cap*2), head, len,
//                  seen, x, y, z, vx, vy, vz, cls, strength }
const tracks = new Map();
let listVersion = 0; // bumped whenever a target appears or disappears

// User marks per target, keyed like `tracks`. They survive a target going stale
// (for example while its generator is paused) but not a reset or removal.
// { affil?: "friendly" | "enemy" | "neutral" | "unknown", ignored?: boolean, trailLen?: number }
const marks = new Map();

function dropGeneratorTracks(gen) {
  for (const [k, t] of tracks) if (t.gen === gen) tracks.delete(k);
  for (const k of marks.keys()) if (k.startsWith(`${gen}:`)) marks.delete(k);
  listVersion++;
}

// Whole tags the user has chosen to ignore (class_id values), e.g. every bird.
// A target is ignored if it, or its tag, is ignored. Re-checked every frame
// because a target's tag can change when it gets identified.
const ignoredTags = new Set();
// Same idea for designations: "friendly" | "enemy" | "neutral" | "unknown".
const ignoredAffils = new Set();
const BIRD = CLASS_NAMES.indexOf("bird");
// Designation before the user marks a target: birds are neutral; in each
// generator, tracks 1-2 are enemies and 3-4 are friendlies; the rest unknown.
function defaultAffil(t) {
  if (t.cls === BIRD) return "neutral";
  if (t.id <= 2) return "enemy";
  if (t.id <= 4) return "friendly";
  return "unknown";
}
const affilOf = (t) => t.mark?.affil ?? defaultAffil(t);
const ignoredByFilter = (t) =>
  ignoredTags.has(t.cls) || ignoredAffils.has(affilOf(t));
const isIgnored = (t) => !!t.mark?.ignored || ignoredByFilter(t);

// Color key for batching and tinting: the target's designation.
const colorKeyOf = affilOf;
const colorOfKey = (k) =>
  typeof k === "number" ? colorFor(k) : AFFIL_COLOR[k];
const colorOf = (t) => colorOfKey(colorKeyOf(t));

function setMark(t, patch) {
  const m = Object.assign(marks.get(t.key) ?? {}, patch);
  marks.set(t.key, m);
  t.mark = m;
  if (patch.trailLen) resizeTrail(t, patch.trailLen);
  listVersion++; // marks change what the list shows
  listDirty = true;
}

// Change how many positions a target remembers, keeping the newest ones.
// History from before the change can't be recovered, so a longer trail grows
// from now on.
function resizeTrail(t, cap) {
  if (cap === t.cap) return;
  const keep = Math.min(t.len, cap);
  const pts = new Float32Array(cap * 2);
  const start = (t.head - keep + t.cap) % t.cap; // oldest point we keep
  for (let i = 0; i < keep; i++) {
    const s = ((start + i) % t.cap) * 2;
    pts[i * 2] = t.pts[s];
    pts[i * 2 + 1] = t.pts[s + 1];
  }
  t.pts = pts;
  t.cap = cap;
  t.len = keep;
  t.head = keep % cap;
}

// --- Worker messages --------------------------------------------------
worker.onmessage = ({ data }) => {
  switch (data.type) {
    case "frame":
      ingestFrame(data.buf);
      break;
    case "state":
      applyState(data);
      break;
    case "stats":
      genStats = data.generators;
      updateTelemetry();
      break;
    case "connection": {
      const el = document.getElementById("conn");
      el.textContent = data.connected ? "connected" : "disconnected";
      el.classList.toggle("on", data.connected);
      break;
    }
  }
};

// --- Hold Space to freeze ---------------------------------------------------
// While frozen, incoming frames are queued instead of applied, so the scope
// stands still for selecting targets. On release the queue is replayed in
// order: targets jump to their current positions and trails include every
// position passed through. If the queue outgrows the cap, the oldest frames
// are dropped (leaving a gap in the trails).
const FREEZE_MAX_BYTES = 256 * 1024 * 1024;
let frozen = false;
let frozenQueue = [];
let frozenBytes = 0;

const freezeBanner = Object.assign(document.createElement("div"), {
  textContent: "FROZEN — release Space to resume",
});
Object.assign(freezeBanner.style, {
  position: "fixed",
  top: "8px",
  left: "50%",
  transform: "translateX(-50%)",
  padding: "4px 12px",
  background: "rgba(56, 189, 248, 0.9)",
  color: "#0b0f14",
  font: "600 12px system-ui",
  borderRadius: "4px",
  zIndex: 50,
  pointerEvents: "none",
});
freezeBanner.hidden = true;
document.body.appendChild(freezeBanner);

function setFrozen(on) {
  if (on === frozen) return;
  frozen = on;
  freezeBanner.hidden = !on;
  if (on) return;
  const queue = frozenQueue;
  frozenQueue = [];
  frozenBytes = 0;
  for (const buf of queue) applyFrame(buf);
}

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (e.target.closest?.("input, select, textarea")) return;
  e.preventDefault(); // no button activation or page scroll
  setFrozen(true);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") setFrozen(false);
});
window.addEventListener("blur", () => setFrozen(false));

function ingestFrame(buf) {
  if (!frozen) return applyFrame(buf);
  frozenQueue.push(buf);
  frozenBytes += buf.byteLength;
  while (frozenBytes > FREEZE_MAX_BYTES && frozenQueue.length > 1) {
    frozenBytes -= frozenQueue.shift().byteLength;
  }
}

function applyFrame(buf) {
  const view = new DataView(buf);
  const gen = view.getUint32(0, true);
  const count = view.getUint32(16, true);
  const now = performance.now();

  for (let i = 0; i < count; i++) {
    const o = HEADER_BYTES + i * RECORD_BYTES;
    const id = view.getUint32(o, true);
    const x = view.getFloat32(o + 4, true);
    const y = view.getFloat32(o + 8, true);
    const z = view.getFloat32(o + 12, true);
    const vx = view.getFloat32(o + 16, true);
    const vy = view.getFloat32(o + 20, true);
    const vz = view.getFloat32(o + 24, true);

    const key = `${gen}:${id}`;
    let t = tracks.get(key);
    if (!t) {
      const mark = marks.get(key);
      const cap = mark?.trailLen ?? DEFAULT_TRAIL_LEN;
      t = {
        gen,
        id,
        key,
        mark,
        cap, // trail capacity in points (ring buffer size)
        pts: new Float32Array(cap * 2),
        head: 0,
        len: 0,
      };
      tracks.set(key, t);
      listVersion++;
    }
    const cls = view.getUint8(o + 28);
    // Identification can change a target's default designation (birds are
    // neutral), so the list has to regroup.
    if (cls !== t.cls) listVersion++;
    t.cls = cls;
    t.strength = view.getUint8(o + 29);
    t.z = z;
    t.vz = vz;
    t.pts[t.head * 2] = x;
    t.pts[t.head * 2 + 1] = y;
    t.head = (t.head + 1) % t.cap;
    t.len = Math.min(t.len + 1, t.cap);
    t.x = x;
    t.y = y;
    t.vx = vx;
    t.vy = vy;
    t.seen = now;
    checkZones(t);
  }
}

// --- Backend state -> UI ----------------------------------------------
function send(msg) {
  worker.postMessage(msg);
}

function applyState(state) {
  activeGenerators = state.activeGenerators;
  genConfigs = new Map(state.generators.map((g) => [g.id, g]));

  // count selector
  const select = document.getElementById("countSelect");
  if (!select.options.length) {
    for (let n = 1; n <= MAX_GENERATORS; n++) select.add(new Option(n, n));
    select.onchange = () =>
      send({ type: "setGenerators", count: Number(select.value) });
  }
  select.value = activeGenerators;

  // add/remove cards
  for (const [id, card] of cards) {
    if (!genConfigs.has(id)) {
      card.el.remove();
      cards.delete(id);
      dropGeneratorTracks(id);
    }
  }
  for (const cfg of state.generators) {
    if (!cards.has(cfg.id)) createCard(cfg.id);
    syncCard(cards.get(cfg.id), cfg);
    // The server caps the total across all generators (hosted limit).
    if (state.maxTotalTargets) {
      const input = cards.get(cfg.id).inputs.targetCount;
      input.max = state.maxTotalTargets;
      input.title = `Max ${state.maxTotalTargets.toLocaleString()} targets across all generators`;
    }
  }
  // keep cards ordered by id
  const container = document.getElementById("cards");
  [...cards.keys()]
    .sort((a, b) => a - b)
    .forEach((id) => container.appendChild(cards.get(id).el));
}

function collectConfig(card) {
  const cfg = {
    paused: card.paused,
    motionPattern: card.inputs.motionPattern.value,
  };
  for (const c of CONTROLS) cfg[c.key] = Number(card.inputs[c.key].value);
  return cfg;
}

function createCard(id) {
  const el = document.createElement("div");
  el.className = "card";
  el.style.borderLeftColor = colorFor(id);

  const title = document.createElement("h3");
  title.textContent = `Generator ${id}`;
  el.appendChild(title);

  const telemetry = document.createElement("div");
  telemetry.className = "telemetry";
  el.appendChild(telemetry);

  const card = { el, inputs: {}, telemetry, paused: false, outputs: {} };
  const push = () =>
    send({ type: "updateGenerator", id, config: collectConfig(card) });

  for (const c of CONTROLS) {
    const row = document.createElement("label");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = c.label;
    const input = document.createElement("input");
    input.type = c.type || "range";
    input.min = c.min;
    if (c.max !== undefined) input.max = c.max;
    input.step = c.step;
    const out = document.createElement("output");
    if (c.type === "number") {
      // Unbounded count: a typed number, applied on commit (Enter / blur / spinner)
      // so half-typed values like "" or "3" don't reconfigure the generator.
      input.onchange = () => {
        if (!(Number(input.value) >= c.min)) {
          input.value = genConfigs.get(id)?.[c.key] ?? c.min;
          return;
        }
        push();
      };
      row.append(name, input);
    } else {
      input.oninput = () => {
        out.textContent = input.value;
        push();
      };
      row.append(name, input, out);
    }
    el.appendChild(row);
    card.inputs[c.key] = input;
    card.outputs[c.key] = out;
  }

  const patternRow = document.createElement("label");
  patternRow.className = "row";
  const pName = document.createElement("span");
  pName.textContent = "Motion";
  const select = document.createElement("select");
  for (const p of PATTERNS) select.add(new Option(p, p));
  select.onchange = push;
  patternRow.append(pName, select);
  el.appendChild(patternRow);
  card.inputs.motionPattern = select;

  const btns = document.createElement("div");
  btns.className = "btns";
  const pauseBtn = document.createElement("button");
  pauseBtn.onclick = () => {
    card.paused = !card.paused;
    pauseBtn.textContent = card.paused ? "Resume" : "Pause";
    push();
  };
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.onclick = () => {
    dropGeneratorTracks(id);
    send({ type: "resetGenerator", id });
  };
  btns.append(pauseBtn, resetBtn);
  el.appendChild(btns);
  card.pauseBtn = pauseBtn;

  cards.set(id, card);
}

// Reflect backend config into controls without fighting the user's drag.
function syncCard(card, cfg) {
  for (const c of CONTROLS) {
    const input = card.inputs[c.key];
    if (document.activeElement !== input) {
      input.value = cfg[c.key];
      card.outputs[c.key].textContent = cfg[c.key];
    }
  }
  card.inputs.motionPattern.value = cfg.motionPattern;
  card.paused = cfg.paused;
  card.pauseBtn.textContent = cfg.paused ? "Resume" : "Pause";
}

function updateTelemetry() {
  for (const [id, card] of cards) {
    const s = genStats[id];
    card.telemetry.textContent = s
      ? `${s.hz.toFixed(1)} Hz · ${s.received} frames · ${s.dropped} dropped`
      : "no data";
  }
}

// --- Rendering --------------------------------------------------------
const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
let cssW = 0;
let cssH = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  cssW = r.width;
  cssH = r.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

// --- Pointer + target info -------------------------------------------
const tipEl = document.getElementById("tip");
const selectedEl = document.getElementById("selected");
const pointer = {
  x: 0,
  y: 0,
  clientX: 0,
  clientY: 0,
  inside: false,
  click: false,
};
let hoverKey = null; // "gen:track" under the pointer
let selectedKey = null; // tracked target

canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  pointer.x = e.clientX - r.left;
  pointer.y = e.clientY - r.top;
  pointer.clientX = e.clientX;
  pointer.clientY = e.clientY;
  pointer.inside = true;
});
canvas.addEventListener("mouseleave", () => {
  pointer.inside = false;
});
// Resolved inside draw(), where the hit test runs.
canvas.addEventListener("click", (e) => {
  if (justPanned) {
    justPanned = false; // the end of a pan isn't a click on a dot
    return;
  }
  pointer.click = true;
});

// --- View: pan and zoom -------------------------------------------------
// `view` is the world point (meters) at the center of the scope, plus a zoom
// factor where 1 shows the whole radar range.
// The home view (the default, and where "Reset view" returns to) is the whole
// radar range centered on the radar. You can pan beyond it by PAN_MARGIN_M.
const HOME_VIEW = { x: 0, y: 0, zoom: 1 };
const PAN_MARGIN_M = 3219; // 2 miles
const view = { ...HOME_VIEW };
const MAX_ZOOM = 60;
let panning = null; // { sx, sy, vx, vy } while ctrl+dragging
let justPanned = false;

const pxPerMeter = () =>
  ((Math.min(cssW, cssH) / 2 - 20) / WORLD_RADIUS_M) * view.zoom;

// Keep the visible area within the home area plus PAN_MARGIN_M on every side.
function clampView() {
  view.zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom));
  const lim = WORLD_RADIUS_M * (1 - 1 / view.zoom) + PAN_MARGIN_M;
  view.x = Math.max(-lim, Math.min(lim, view.x));
  view.y = Math.max(-lim, Math.min(lim, view.y));
}

function resetView() {
  Object.assign(view, HOME_VIEW);
  stopFollowing(); // untick Follow so the home view stays put
}

// Follow: while a target is selected, keep it at the center of the scope.
// Panning by hand, or resetting the view, turns it off.
const followEl = document.getElementById("followSel");
followEl.checked = localStorage.getItem("follow") !== "0"; // default on
followEl.addEventListener("change", () => {
  localStorage.setItem("follow", followEl.checked ? "1" : "0");
  followPaused = false;
});
let followPaused = false;
// Panning by hand turns Follow off (untick only; the saved default stays on).
function stopFollowing() {
  followEl.checked = false;
}

// Middle-mouse drag pans. By default the map follows the pointer (drag left,
// map moves left); "Invert pan" in the help panel moves it the other way.
let invertPan = localStorage.getItem("invertPan") === "1";
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 1) return;
  e.preventDefault(); // no browser autoscroll
  closeMenu();
  panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  const dx = e.clientX - panning.sx;
  const dy = e.clientY - panning.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    justPanned = true;
    stopFollowing();
  }
  const s = pxPerMeter();
  const k = invertPan ? 1 : -1;
  view.x = panning.vx + (k * dx) / s;
  view.y = panning.vy - (k * dy) / s; // screen y grows downward, world y upward
  clampView();
});
window.addEventListener("mouseup", () => {
  panning = null;
  // A pan ends in a click on some platforms (which the click handler ignores)
  // and in none on macOS. Clear the flag after that click would have fired, so
  // it can't swallow your next real click.
  setTimeout(() => {
    justPanned = false;
  }, 0);
});

// Mouse wheel over the scope zooms around the pointer (up = in, down = out).
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault(); // also stops trackpad pinch from zooming the page
    closeMenu();
    const delta = Math.max(-100, Math.min(100, e.deltaY));
    const before = pxPerMeter();
    const oldZoom = view.zoom;
    view.zoom = Math.max(
      1,
      Math.min(MAX_ZOOM, view.zoom * Math.exp(-delta * 0.0025)),
    );
    if (view.zoom === oldZoom) return;
    const after = pxPerMeter();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - cssW / 2;
    const my = e.clientY - r.top - cssH / 2;
    // Keep the world point under the pointer where it is.
    view.x += mx / before - mx / after;
    view.y -= my / before - my / after;
    clampView();
  },
  { passive: false },
);
// Stop ctrl+wheel / pinch elsewhere from zooming the whole page.
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false },
);
document.getElementById("resetView").addEventListener("click", resetView);
// The one place selection changes, so the list repaints its highlight.
function select(key) {
  selectedKey = key;
  followPaused = false;
  listDirty = true;
}

// --- Hotkeys -----------------------------------------------------------
// Every action has one key combo, editable in the help panel and saved in
// localStorage. A combo looks like "R", "Escape" or "Ctrl+Shift+K".
const markAction = (affil) => () => {
  const t = selectedTrack();
  if (t) setMark(t, { affil });
};
const zoomBy = (f) => {
  view.zoom *= f;
  clampView();
};
// Select the next / previous target in the order the list shows them (so it
// follows the list's filters and sections), wrapping around at the ends.
function cycleTarget(dir) {
  const items = listItems.filter((it) => !it.header);
  if (!items.length) return;
  const i = items.findIndex((t) => t.key === selectedKey);
  const next =
    i < 0
      ? dir > 0
        ? 0
        : items.length - 1
      : (i + dir + items.length) % items.length;
  select(items[next].key);
  scrollListTo = items[next].key; // keep its row in view
}
const HOTKEY_ACTIONS = [
  {
    id: "help",
    label: "Show / hide controls",
    def: "?",
    run: () => toggleHelp(),
  },
  {
    id: "deselect",
    label: "Deselect target, close menu",
    def: "Escape",
    run: () => {
      select(null);
      closeMenu();
    },
  },
  { id: "resetView", label: "Reset zoom and pan", def: "R", run: resetView },
  {
    id: "nextTarget",
    label: "Select next target",
    def: "Tab",
    run: () => cycleTarget(1),
  },
  {
    id: "prevTarget",
    label: "Select previous target",
    def: "Shift+Tab",
    run: () => cycleTarget(-1),
  },
  {
    id: "toggleFollow",
    label: "Follow selected target on / off",
    def: "T",
    run: () => {
      followEl.checked = !followEl.checked;
      followEl.dispatchEvent(new Event("change")); // saves it, resumes following
    },
  },
  { id: "zoomIn", label: "Zoom in", def: "+", run: () => zoomBy(1.25) },
  { id: "zoomOut", label: "Zoom out", def: "-", run: () => zoomBy(1 / 1.25) },
  {
    id: "markFriendly",
    label: "Mark selected: Friendly",
    def: "F",
    run: markAction("friendly"),
  },
  {
    id: "markEnemy",
    label: "Mark selected: Enemy",
    def: "E",
    run: markAction("enemy"),
  },
  {
    id: "markNeutral",
    label: "Mark selected: Neutral",
    def: "N",
    run: markAction("neutral"),
  },
  {
    id: "markUnknown",
    label: "Mark selected: Unknown",
    def: "U",
    run: markAction("unknown"),
  },
  {
    id: "toggleIgnore",
    label: "Ignore / unignore selected",
    def: "I",
    run: () => {
      const t = selectedTrack();
      if (t) setMark(t, { ignored: !t.mark?.ignored });
    },
  },
];

function loadHotkeys() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("hotkeys") || "{}") || {};
  } catch {}
  const map = {};
  for (const a of HOTKEY_ACTIONS) {
    map[a.id] = typeof saved[a.id] === "string" ? saved[a.id] : a.def; // "" = unbound
  }
  return map;
}
const hotkeys = loadHotkeys();
const saveHotkeys = () =>
  localStorage.setItem("hotkeys", JSON.stringify(hotkeys));

// Key event -> combo string (null for a bare modifier key).
function comboOf(e) {
  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  // Shift is part of the symbol for punctuation ("?" , "+"), so only list it
  // for letters and named keys.
  if (e.shiftKey && (key.length > 1 || /[A-Z]/.test(key))) parts.push("Shift");
  return [...parts, key].join("+");
}

// --- Help panel: hotkeys (editable) and mouse controls ---------------------
const helpOverlay = document.getElementById("helpOverlay");
const helpBody = document.getElementById("helpBody");
let capturing = null; // action id waiting for a key press

function toggleHelp() {
  helpOverlay.hidden = !helpOverlay.hidden;
  capturing = null;
  if (!helpOverlay.hidden) renderHelp();
}

function renderHelp() {
  helpBody.replaceChildren();
  const h = (text) => {
    const el = document.createElement("h4");
    el.textContent = text;
    helpBody.appendChild(el);
  };
  const row = (label, valueEl) => {
    const el = document.createElement("div");
    el.className = "hrow";
    const l = document.createElement("span");
    l.textContent = label;
    el.append(l, valueEl);
    helpBody.appendChild(el);
  };

  h("Hotkeys (click a key to change it)");
  for (const a of HOTKEY_ACTIONS) {
    const b = document.createElement("button");
    b.className = "keybtn";
    b.dataset.action = a.id;
    const waiting = capturing === a.id;
    b.textContent = waiting ? "Press a key…" : hotkeys[a.id] || "—";
    b.classList.toggle("waiting", waiting);
    b.title = "Click, then press the new key. Backspace unbinds, Esc cancels.";
    row(a.label, b);
  }
  // Fixed key (not rebindable), so shown as plain text rather than a button.
  row(
    "Freeze the scope",
    Object.assign(document.createElement("span"), {
      textContent: "Hold Space",
    }),
  );
  const reset = document.createElement("button");
  reset.id = "resetKeys";
  reset.textContent = "Reset hotkeys to defaults";
  helpBody.appendChild(reset);

  h("Mouse");
  const text = (s) =>
    Object.assign(document.createElement("span"), { textContent: s });
  row("Select a target", text("Click"));
  row("Mark a target", text("Right-click it"));
  row("Zoom in / out", text("Wheel up / down"));
  row("Pan", text("Middle-click drag"));
  row("Recenter", text("Click or drag the minimap"));

  h("Options");
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "invertPan";
  box.checked = invertPan;
  label.append(box, " Invert pan (map moves opposite the drag)");
  helpBody.appendChild(label);
  const clear = document.createElement("button");
  clear.id = "clearSettings";
  clear.textContent = "Clear all saved settings";
  clear.title = "Forget everything saved in this browser and reload";
  helpBody.appendChild(clear);
}

helpBody.addEventListener("click", (e) => {
  const keyBtn = e.target.closest(".keybtn");
  if (keyBtn) {
    capturing =
      capturing === keyBtn.dataset.action ? null : keyBtn.dataset.action;
    renderHelp();
  } else if (e.target.id === "clearSettings") {
    if (
      confirm(
        "Clear all saved settings (hotkeys, units, map, dimmer, follow, pan) and reload?",
      )
    ) {
      localStorage.clear();
      location.reload();
    }
  } else if (e.target.id === "resetKeys") {
    for (const a of HOTKEY_ACTIONS) hotkeys[a.id] = a.def;
    saveHotkeys();
    capturing = null;
    renderHelp();
  }
});
helpBody.addEventListener("change", (e) => {
  if (e.target.id !== "invertPan") return;
  invertPan = e.target.checked;
  localStorage.setItem("invertPan", invertPan ? "1" : "0");
});
document.getElementById("helpBtn").addEventListener("click", toggleHelp);
document.getElementById("helpClose").addEventListener("click", toggleHelp);
helpOverlay.addEventListener("mousedown", (e) => {
  if (e.target === helpOverlay) toggleHelp(); // click outside the panel
});

// Capture phase: while rebinding, this sees the key before anything else.
window.addEventListener(
  "keydown",
  (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      capturing = null;
    } else if (e.key === "Backspace" || e.key === "Delete") {
      hotkeys[capturing] = "";
      saveHotkeys();
      capturing = null;
    } else {
      const combo = comboOf(e);
      if (!combo) return; // wait for a real key
      // One action per combo: take it away from any other action.
      for (const id in hotkeys) if (hotkeys[id] === combo) hotkeys[id] = "";
      hotkeys[capturing] = combo;
      saveHotkeys();
      capturing = null;
    }
    renderHelp();
  },
  true,
);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !helpOverlay.hidden) {
    toggleHelp();
    return;
  }
  // Typing in a field isn't a hotkey.
  if (e.target.closest?.("input, select, textarea")) return;
  const combo = comboOf(e);
  if (!combo) return;
  const action = HOTKEY_ACTIONS.find((a) => hotkeys[a.id] === combo);
  if (!action) return;
  e.preventDefault();
  action.run();
});

// --- Right-click menu on a dot: mark friendly / enemy / unknown -------------
// It opens at the pointer and stays put (the target keeps moving, the menu
// doesn't) until Esc, a choice, or the pointer leaves it.
const menuEl = document.getElementById("ctxMenu");
let menuKey = null;

function closeMenu() {
  menuKey = null;
  menuEl.hidden = true;
}

function openMenu(key, clientX, clientY) {
  const t = tracks.get(key);
  if (!t) return;
  menuKey = key;
  menuEl.replaceChildren();
  const title = document.createElement("div");
  title.className = "mtitle";
  title.textContent = `${trackLabel(t)}  ${tagName(t)}`;
  menuEl.appendChild(title);
  for (const id of ["friendly", "enemy", "neutral", "unknown"]) {
    const b = document.createElement("button");
    b.className = `aff ${id}`;
    b.dataset.affil = id;
    b.textContent = id[0].toUpperCase() + id.slice(1);
    b.classList.toggle("active", id === affilOf(t));
    menuEl.appendChild(b);
  }
  menuEl.hidden = false;
  // Put the pointer just inside the menu's corner, and keep it on screen.
  const w = menuEl.offsetWidth;
  const h = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(0, Math.min(clientX - 8, innerWidth - w))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(clientY - 8, innerHeight - h))}px`;
}

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (hoverKey) openMenu(hoverKey, e.clientX, e.clientY);
  else closeMenu();
});
menuEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  const t = menuKey && tracks.get(menuKey);
  if (btn && t) setMark(t, { affil: btn.dataset.affil });
  closeMenu();
});
menuEl.addEventListener("contextmenu", (e) => e.preventDefault());
// Close as soon as the pointer is outside the menu.
document.addEventListener("mousemove", (e) => {
  if (!menuKey) return;
  const r = menuEl.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  ) {
    closeMenu();
  }
});

// Only touch the DOM when the text changed.
function setText(el, text) {
  if (el._text !== text) {
    el._text = text;
    el.textContent = text;
  }
}

// Unique on-screen ID: generator + per-generator track number, e.g. "G2-T017".
function trackLabel(t) {
  return `G${t.gen}-T${String(t.id).padStart(3, "0")}`;
}

function tagName(t) {
  return t.cls === UNIDENTIFIED
    ? "unidentified"
    : (CLASS_NAMES[t.cls] ?? "unidentified");
}

// --- Icons (SVG) for identified drones and airplanes -----------------------
// Top-down silhouettes with the nose pointing up (north), tinted per generator.
const ICON_SVG = {
  drone: (c) => `
    <path d="M7 7l10 10M17 7L7 17" stroke="${c}" stroke-width="1.8" fill="none"/>
    <rect x="9" y="9" width="6" height="6" rx="1.5" fill="${c}" stroke="#0b0f14" stroke-width=".8"/>
    <g fill="${c}" fill-opacity=".55" stroke="${c}" stroke-width=".8">
      <circle cx="5.5" cy="5.5" r="3.2"/><circle cx="18.5" cy="5.5" r="3.2"/>
      <circle cx="5.5" cy="18.5" r="3.2"/><circle cx="18.5" cy="18.5" r="3.2"/>
    </g>`,
  airplane: (c) => `
    <path d="M12 1.5l1.8 7.2L22 13v2.2l-8.2-2.2-.5 5.6 2.7 2v1.4L12 21l-3.8.9v-1.4l2.7-2-.5-5.6L2 15.2V13l8.2-4.3z"
      fill="${c}" stroke="#0b0f14" stroke-width=".8" stroke-linejoin="round"/>`,
  // Bird in flight, side view, facing right (flipped in drawIcon when it
  // heads left): body, raised wing, tail, round head and a yellow beak.
  bird: (c) => `
    <g fill="${c}" stroke="#0b0f14" stroke-width=".8" stroke-linejoin="round">
      <path d="M6.500 14.500L1.500 15.500 2.500 13.500 1 11.500 7 12.500z"/>
      <ellipse cx="11.500" cy="14" rx="6.500" ry="3.200"/>
      <circle cx="17.800" cy="11.800" r="2.600"/>
      <path d="M8 13.500C8.500 9 11 5 15 2.500 14.800 6.500 14.500 10 14.500 13.500z"/>
    </g>
    <path d="M20 10.800L23.500 12.200 20.200 13.400z" fill="#facc15" stroke="#0b0f14" stroke-width=".6" stroke-linejoin="round"/>
    <circle cx="18.500" cy="11.200" r=".6" fill="#0b0f14"/>`,
  // Helicopter from above: fuselage, tail boom and rotor, main rotor blades.
  helicopter: (c) => `
    <path d="M12 12v9.500M9.800 21.500h4.400" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="12" cy="10.500" rx="3" ry="4.800" fill="${c}" stroke="#0b0f14" stroke-width=".8"/>
    <path d="M3 3l18 15M21 3L3 18" stroke="${c}" stroke-width="1.400" stroke-linecap="round" opacity=".8"/>
    <circle cx="12" cy="10.500" r="1.500" fill="#0b0f14" stroke="${c}" stroke-width=".8"/>`,
  // Not identified yet: a question mark.
  unknown: (c) => `
    <circle cx="12" cy="12" r="10" fill="#0b0f14" fill-opacity=".7" stroke="${c}" stroke-width="1.6"/>
    <path d="M8.8 9.2a3.2 3.2 0 1 1 4.6 2.9c-.9.5-1.4 1-1.4 2" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round"/>
    <circle cx="12" cy="17.2" r="1.3" fill="${c}"/>`,
};
// Which icon a target gets: by tag, or "unknown" until it is identified.
// Helicopters (and anything else) get none.
const iconKindOf = (t) => {
  const kind = t.cls === UNIDENTIFIED ? "unknown" : CLASS_NAMES[t.cls];
  return ICON_SVG[kind] ? kind : undefined;
};
const iconCache = new Map(); // "kind:color" -> HTMLImageElement

function iconFor(t) {
  const kind = iconKindOf(t);
  if (!kind) return null;
  const color = colorOf(t);
  const k = `${kind}:${color}`;
  let img = iconCache.get(k);
  if (!img) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">${ICON_SVG[kind](color)}</svg>`;
    img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    iconCache.set(k, img);
  }
  return img.complete && img.naturalWidth ? { img, kind } : null;
}

// --- Our radar installation, drawn at the center of the map ----------------
// A dish on a mast over a base, with signal arcs, inside a dark disc so it
// reads on both the satellite map and the plain background.
const RADAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="22" fill="#0b0f14" fill-opacity=".85" stroke="#38bdf8" stroke-width="1.6"/>
  <path d="M10 37h28l-3-6H13z" fill="#1e3a4f" stroke="#38bdf8" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M24 31V22" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round"/>
  <g transform="rotate(-35 24 22)">
    <path d="M14 14q10 14 20 0z" fill="#38bdf8" fill-opacity=".35" stroke="#e0f2fe" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M24 20V11" stroke="#e0f2fe" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="24" cy="10" r="1.8" fill="#e0f2fe"/>
  </g>
  <path d="M33 8q5 3 6 9M36 5q7 4 8 13" stroke="#38bdf8" stroke-width="1.6" fill="none" stroke-linecap="round"/>
</svg>`;
const RADAR_MIN_PX = 14; // size at zoom 1 (whole range in view)
const RADAR_MAX_PX = 40; // never larger than this
const RADAR_PX_PER_ZOOM = 4; // growth per zoom step
const radarImg = new Image();
radarImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(RADAR_SVG)}`;

function drawRadar(g, x, y, size) {
  if (radarImg.complete && radarImg.naturalWidth) {
    g.drawImage(radarImg, x - size / 2, y - size / 2, size, size);
  }
}

// Radar-style measurements from the radar-relative position and velocity.
function describe(t) {
  const ground = Math.hypot(t.x, t.y);
  const range = Math.hypot(ground, t.z);
  const azimuth = ((Math.atan2(t.x, t.y) * 180) / Math.PI + 360) % 360; // from north, clockwise
  const speed = Math.hypot(t.vx, t.vy, t.vz);
  // Positive = moving away from the radar.
  const radial = range > 0 ? (t.x * t.vx + t.y * t.vy + t.z * t.vz) / range : 0;

  const row = (label, value) => `${label.padEnd(10)}${value}`;
  return [
    `${trackLabel(t)}  ${tagName(t)}  [${affilOf(t)}]`,
    row("Range", fmtDist(range)),
    row("Azimuth", `${azimuth.toFixed(1)}°`),
    row("Elevation", fmtHeight(t.z)),
    row("Velocity", fmtSpeed(speed)),
    row("Radial", fmtSpeed(radial, true)), // + = moving away
    row("Strength", `${t.strength} (${Math.round((t.strength / 255) * 100)}%)`),
  ].join("\n");
}

// --- Target list (left panel) ----------------------------------------------
// Only the rows in view exist in the DOM, positioned inside a tall spacer, so
// the list stays fast even with 100k targets. Row events use one handler on
// the container and work out the row from the pointer position.
const listEl = document.getElementById("targetList");
const listInner = document.getElementById("targetInner");
const filterEl = document.getElementById("targetFilter");
const showIgnoredEl = document.getElementById("showIgnored");
const countEl = document.getElementById("targetCount");
const onScreenEl = document.getElementById("onScreenOnly");

// List sections, top to bottom.
const GROUPS = [
  { id: "unknown", label: "Unknown", color: AFFIL_COLOR.unknown },
  { id: "enemy", label: "Enemy", color: AFFIL_COLOR.enemy },
  { id: "friendly", label: "Friendly", color: AFFIL_COLOR.friendly },
  { id: "neutral", label: "Neutral", color: AFFIL_COLOR.neutral },
];
const groupOf = (t) => {
  const i = GROUPS.findIndex((g) => g.id === affilOf(t));
  return i < 0 ? 0 : i;
};

// Rows in display order: a { header: true, ... } entry before each section's
// targets, which are sorted by generator then track number.
let listItems = [];
let listDirty = true; // repaint on the next frame
let listHoverKey = null; // row under the pointer: its dot is highlighted
let scrollListTo = null; // key to scroll into view after a click on a dot
let listBuilt = { version: -1, filter: "", showIgnored: true, at: 0 };
let listPaintedAt = 0;
const rowPool = [];

function makeRow() {
  const el = document.createElement("div");
  el.className = "trow";
  const sw = document.createElement("span");
  sw.className = "sw";
  const id = document.createElement("span");
  const tag = document.createElement("span");
  tag.className = "tag";
  const rng = document.createElement("span");
  rng.className = "rng";
  el.append(sw, id, tag, rng);
  listInner.appendChild(el);
  return { el, sw, id, tag, rng };
}

function itemAt(clientY) {
  const top = listEl.getBoundingClientRect().top;
  const i = Math.floor((clientY - top + listEl.scrollTop) / ROW_H);
  return listItems[i];
}

function updateList(now) {
  const filter = filterEl.value.trim().toLowerCase();
  const showIgnored = showIgnoredEl.checked;
  const onScreenOnly = onScreenEl.checked;
  // Visible world rectangle (same mapping as draw()).
  const hwM = cssW / 2 / pxPerMeter();
  const hhM = cssH / 2 / pxPerMeter();
  const viewSig = `${view.x}|${view.y}|${view.zoom}|${cssW}|${cssH}`;
  // The tag of a target can change (it gets identified), so with a filter
  // active, rebuild periodically as well. Targets move on and off screen, so
  // the on-screen filter rebuilds more often.
  const rebuild =
    listBuilt.version !== listVersion ||
    listBuilt.filter !== filter ||
    listBuilt.showIgnored !== showIgnored ||
    listBuilt.onScreenOnly !== onScreenOnly ||
    (onScreenOnly &&
      (listBuilt.viewSig !== viewSig || now - listBuilt.at > 250)) ||
    ((filter !== "" || ignoredTags.size > 0 || ignoredAffils.size > 0) &&
      now - listBuilt.at > 1000);

  if (!rebuild && !listDirty && now - listPaintedAt < 200) return;
  listDirty = false;
  listPaintedAt = now;

  if (rebuild) {
    let ignored = 0;
    const buckets = GROUPS.map(() => []);
    for (const t of tracks.values()) {
      if (isIgnored(t)) {
        ignored++;
        if (!showIgnored) continue;
      }
      if (
        filter &&
        !`${trackLabel(t)} ${tagName(t)} ${affilOf(t)}`
          .toLowerCase()
          .includes(filter)
      ) {
        continue;
      }
      if (
        onScreenOnly &&
        (Math.abs(t.x - view.x) > hwM || Math.abs(t.y - view.y) > hhM)
      ) {
        continue;
      }
      buckets[groupOf(t)].push(t);
    }
    // Sections top to bottom: unknown, enemy, friendly. Empty ones are skipped.
    listItems = [];
    GROUPS.forEach((group, g) => {
      const members = buckets[g];
      if (!members.length) return;
      members.sort((a, b) => a.gen - b.gen || a.id - b.id);
      listItems.push({ header: true, ...group, count: members.length });
      for (const t of members) listItems.push(t);
    });
    listBuilt = {
      version: listVersion,
      filter,
      showIgnored,
      onScreenOnly,
      viewSig,
      at: now,
    };
    listInner.style.height = `${listItems.length * ROW_H}px`;
    setText(
      countEl,
      `${tracks.size.toLocaleString()}${ignored ? ` · ${ignored.toLocaleString()} ignored` : ""}`,
    );
  }

  if (scrollListTo) {
    const i = listItems.findIndex((t) => t.key === scrollListTo);
    scrollListTo = null;
    if (i >= 0) {
      const top = i * ROW_H;
      if (
        top < listEl.scrollTop ||
        top + ROW_H > listEl.scrollTop + listEl.clientHeight
      ) {
        listEl.scrollTop = top - listEl.clientHeight / 2 + ROW_H / 2;
      }
    }
  }

  const first = Math.max(0, Math.floor(listEl.scrollTop / ROW_H) - 3);
  const last = Math.min(
    listItems.length,
    Math.ceil((listEl.scrollTop + listEl.clientHeight) / ROW_H) + 3,
  );
  const need = Math.max(0, last - first);
  while (rowPool.length < need) rowPool.push(makeRow());

  for (let i = 0; i < rowPool.length; i++) {
    const r = rowPool[i];
    if (i >= need) {
      r.el.style.display = "none"; // not `hidden`: .trow sets its own display
      continue;
    }
    const t = listItems[first + i];
    r.el.style.display = "";
    r.el.style.top = `${(first + i) * ROW_H}px`;
    r.el.classList.toggle("hdr", !!t.header);
    if (t.header) {
      // Section header: "UNKNOWN ......... 12"
      r.el.classList.remove("sel", "ign");
      r.sw.style.background = t.color;
      setText(r.id, t.label);
      setText(r.tag, "");
      r.tag.classList.remove("unid");
      setText(r.rng, String(t.count));
      continue;
    }
    r.el.classList.toggle("sel", t.key === selectedKey);
    r.el.classList.toggle("ign", isIgnored(t));
    r.sw.style.background = colorOf(t);
    setText(r.id, trackLabel(t));
    setText(r.tag, tagName(t));
    r.tag.classList.toggle("unid", t.cls === UNIDENTIFIED);
    setText(r.rng, fmtDist(Math.hypot(t.x, t.y, t.z)));
  }
}

listEl.addEventListener("scroll", () => (listDirty = true));
listEl.addEventListener("mousemove", (e) => {
  listHoverKey = itemAt(e.clientY)?.key ?? null;
});
listEl.addEventListener("mouseleave", () => (listHoverKey = null));
// Selecting from the list works like clicking the dot: it stays until Esc.
listEl.addEventListener("click", (e) => {
  const t = itemAt(e.clientY);
  if (t?.key) select(t.key); // section headers have no key
});
filterEl.addEventListener("input", () => {
  listEl.scrollTop = 0;
  listDirty = true;
});
showIgnoredEl.addEventListener("change", () => (listDirty = true));

// Units toggle (header): metric / imperial / both.
const unitSeg = document.getElementById("unitSeg");
const UNIT_CHOICES = [
  ["metric", "Metric"],
  ["imperial", "Imperial"],
  ["both", "Both"],
];
function paintUnitButtons() {
  [...unitSeg.children].forEach((b, i) =>
    b.classList.toggle("active", UNIT_CHOICES[i][0] === units),
  );
}
for (const [id, label] of UNIT_CHOICES) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = id === "both" ? "Metric with imperial in parentheses" : label;
  b.addEventListener("click", () => {
    units = id;
    localStorage.setItem("units", id);
    paintUnitButtons();
    listDirty = true; // list rows show distances
  });
  unitSeg.appendChild(b);
}
paintUnitButtons();

// One toggle chip per tag; an active chip hides every target with that tag
// from the scope (they stay in the list, dimmed).
const typeChipsEl = document.getElementById("ignoreTypes");
const TAG_CHIPS = [
  ...CLASS_NAMES.map((name, cls) => [cls, name]),
  [UNIDENTIFIED, "unidentified"],
];
for (const [cls, name] of TAG_CHIPS) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = name;
  chip.title = `Hide every ${name} target from the scope`;
  chip.addEventListener("click", () => {
    if (ignoredTags.has(cls)) ignoredTags.delete(cls);
    else ignoredTags.add(cls);
    chip.classList.toggle("active", ignoredTags.has(cls));
    listVersion++; // ignored targets may be hidden from the list too
    listDirty = true;
  });
  typeChipsEl.appendChild(chip);
}

// Same for designations (friendly / unknown / enemy), tinted like the marks.
const affilChipsEl = document.getElementById("ignoreAffils");
for (const id of ["friendly", "unknown", "enemy", "neutral"]) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = id;
  chip.style.color = AFFIL_COLOR[id];
  chip.title = `Hide every ${id} target from the scope`;
  chip.addEventListener("click", () => {
    if (ignoredAffils.has(id)) ignoredAffils.delete(id);
    else ignoredAffils.add(id);
    chip.classList.toggle("active", ignoredAffils.has(id));
    listVersion++;
    listDirty = true;
  });
  affilChipsEl.appendChild(chip);
}

// --- Actions for the selected target ------------------------------------------
const actionsEl = document.getElementById("actions");
const actionTitleEl = document.getElementById("actionTitle");
const ignoreBtn = document.getElementById("ignoreBtn");
const trailSel = document.getElementById("trailSel");
let actionsSig = null;

function selectedTrack() {
  return selectedKey ? tracks.get(selectedKey) : undefined;
}

actionsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  const t = selectedTrack();
  if (!btn || !t) return;
  if (btn.dataset.affil !== undefined) {
    setMark(t, { affil: btn.dataset.affil || undefined }); // "" = clear
  } else if (btn === ignoreBtn) {
    setMark(t, { ignored: !t.mark?.ignored });
  }
});
trailSel.addEventListener("change", () => {
  const t = selectedTrack();
  if (t) setMark(t, { trailLen: Number(trailSel.value) });
});

// Reflect the selected target's state in the controls (only when it changed).
function updateActions(t) {
  const typeIgnored = !!t && ignoredByFilter(t);
  const sig = t
    ? `${t.key}|${affilOf(t)}|${t.mark?.ignored}|${typeIgnored}|${t.cap}`
    : "";
  if (sig === actionsSig) return;
  actionsSig = sig;
  for (const el of actionsEl.querySelectorAll("button, select")) {
    el.disabled = !t;
  }
  setText(
    actionTitleEl,
    t ? `${trackLabel(t)}  ${tagName(t)}` : "Select a target to mark it",
  );
  for (const b of actionsEl.querySelectorAll("[data-affil]")) {
    b.classList.toggle(
      "active",
      !!t && !!b.dataset.affil && b.dataset.affil === affilOf(t),
    );
  }
  // If the whole tag is ignored, this target can't be un-ignored on its own:
  // turn the tag's chip off instead.
  const byType = typeIgnored && !t.mark?.ignored;
  ignoreBtn.textContent = byType
    ? "Ignored by filter"
    : t?.mark?.ignored
      ? "Unignore"
      : "Ignore";
  ignoreBtn.disabled = !t || byType;
  trailSel.value = String(t ? t.cap : DEFAULT_TRAIL_LEN);
}

// --- Map background (MapTiler tiles, fetched through our server) ----------------
// Tiles are 256 px images addressed by zoom/x/y in Web Mercator. The radar sits
// at the Space Needle; local meters (x east, y north) are converted to and from
// Mercator meters, scaled by cos(latitude) so they match real ground meters.
const RADAR_LAT = 47.6205;
const RADAR_LON = -122.3493;
const EARTH_R = 6378137;
const MERC = 2 * Math.PI * EARTH_R; // width of the world in Mercator meters
const MERC_K = Math.cos((RADAR_LAT * Math.PI) / 180);
const RADAR_MERC = {
  x: (EARTH_R * RADAR_LON * Math.PI) / 180,
  y: EARTH_R * Math.log(Math.tan(Math.PI / 4 + (RADAR_LAT * Math.PI) / 360)),
};
const TILE_MIN_Z = 8;
const TILE_MAX_Z = 19;
const MAX_TILES_ON_SCREEN = 120;
const MAX_TILE_REQUESTS = 10; // in flight at once
const MAX_CACHED_TILES = 600;
// Hosted: same server. Electron (file://): the local backend.
const TILE_BASE = location.protocol.startsWith("http")
  ? ""
  : "http://127.0.0.1:9001";

const tileCache = new Map(); // "layer/z/x/y" -> { img, ok }, least recently used first
let tileRequests = 0;

// Map selector (header): off / streets / satellite / hybrid.
const mapSeg = document.getElementById("mapSeg");
const MAP_CHOICES = [
  ["satellite", "Satellite", "Satellite imagery"],
  ["streets", "Streets", "Street map"],
  ["hybrid", "Hybrid", "Satellite imagery with street labels"],
  ["off", "None", "No map"],
];
function paintMapButtons() {
  [...mapSeg.children].forEach((b, i) =>
    b.classList.toggle("active", MAP_CHOICES[i][0] === mapLayer),
  );
}
for (const [id, label, title] of MAP_CHOICES) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", () => {
    mapLayer = id;
    localStorage.setItem("mapLayer", id);
    paintMapButtons();
  });
  mapSeg.appendChild(b);
}
paintMapButtons();

// Map dimmer: how much the map is darkened (0-90%), so targets stand out.
const mapDimEl = document.getElementById("mapDim");
let mapDim = Number(localStorage.getItem("mapDim") ?? 50) / 100;
mapDimEl.value = String(Math.round(mapDim * 100));
mapDimEl.addEventListener("input", () => {
  mapDim = Number(mapDimEl.value) / 100;
  localStorage.setItem("mapDim", mapDimEl.value);
});

function getTile(layer, z, x, y, request) {
  const key = `${layer}/${z}/${x}/${y}`;
  let t = tileCache.get(key);
  if (t) {
    tileCache.delete(key); // move to the end: recently used
    tileCache.set(key, t);
    return t;
  }
  if (!request || tileRequests >= MAX_TILE_REQUESTS) return null;

  t = { img: new Image(), ok: false };
  tileRequests++;
  t.img.onload = () => {
    t.ok = true;
    tileRequests--;
  };
  t.img.onerror = () => {
    tileRequests--;
    // Keep the failure for a while so we don't hammer the server, then retry.
    setTimeout(() => {
      if (tileCache.get(key) === t) tileCache.delete(key);
    }, 10000);
  };
  t.img.src = `${TILE_BASE}/tiles/${key}`;
  tileCache.set(key, t);
  for (const k of tileCache.keys()) {
    if (tileCache.size <= MAX_CACHED_TILES) break;
    tileCache.delete(k);
  }
  return t;
}

// Draws the map onto canvas context `g` (w x h css px). (centerX, centerY) is
// the local-meter point at the middle of the canvas; toX/toY convert local
// meters to canvas pixels. Used for both the scope and the minimap.
function drawMap(g, w, h, centerX, centerY, scale, toX, toY, attribution) {
  // Before the canvas has a size the scale is not positive: nothing to draw.
  if (mapLayer === "off" || !(scale > 0) || w < 2 || h < 2) return;
  const dpr = window.devicePixelRatio || 1;

  // Visible area in local meters, then in Mercator meters.
  const hw = w / 2 / scale;
  const hh = h / 2 / scale;
  const mxMin = RADAR_MERC.x + (centerX - hw) / MERC_K;
  const mxMax = RADAR_MERC.x + (centerX + hw) / MERC_K;
  const myMin = RADAR_MERC.y + (centerY - hh) / MERC_K;
  const myMax = RADAR_MERC.y + (centerY + hh) / MERC_K;

  // Tile zoom where one tile is about 256 device pixels; fewer tiles if too many.
  let z = Math.round(Math.log2((MERC * MERC_K * scale * dpr) / 256));
  if (!Number.isFinite(z) || !Number.isFinite(centerX + centerY)) return;
  z = Math.max(TILE_MIN_Z, Math.min(TILE_MAX_Z, z));
  let size, x0, x1, y0, y1;
  // Bounded: at most one pass per zoom level, so it can never spin forever.
  for (let pass = 0; pass <= TILE_MAX_Z; pass++) {
    size = MERC / 2 ** z;
    const n = 2 ** z;
    x0 = Math.max(0, Math.floor((mxMin + MERC / 2) / size));
    x1 = Math.min(n - 1, Math.floor((mxMax + MERC / 2) / size));
    y0 = Math.max(0, Math.floor((MERC / 2 - myMax) / size));
    y1 = Math.min(n - 1, Math.floor((MERC / 2 - myMin) / size));
    if (
      (x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES_ON_SCREEN ||
      z <= TILE_MIN_Z
    ) {
      break;
    }
    z--;
  }

  // Closest to the center first, so those load first.
  const cxT = (centerX / MERC_K + RADAR_MERC.x + MERC / 2) / size;
  const cyT = (MERC / 2 - (centerY / MERC_K + RADAR_MERC.y)) / size;
  const wanted = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      wanted.push([tx, ty, (tx + 0.5 - cxT) ** 2 + (ty + 0.5 - cyT) ** 2]);
    }
  }
  wanted.sort((a, b) => a[2] - b[2]);

  for (const [tx, ty] of wanted) {
    // Screen rectangle of this tile at its exact (fractional) position. Not
    // snapping it keeps the imagery's scale and sub-pixel phase steady while
    // panning; snapping made tile widths flip by a pixel and the picture
    // shimmer. Growing each tile by half a pixel on every side makes neighbors
    // overlap on identical imagery, so there are no antialiasing seams.
    const left = toX((-MERC / 2 + tx * size - RADAR_MERC.x) * MERC_K);
    const right = toX((-MERC / 2 + (tx + 1) * size - RADAR_MERC.x) * MERC_K);
    const top = toY((MERC / 2 - ty * size - RADAR_MERC.y) * MERC_K);
    const bottom = toY((MERC / 2 - (ty + 1) * size - RADAR_MERC.y) * MERC_K);
    const dx = left - 0.5;
    const dy = top - 0.5;
    const dw = right - left + 1;
    const dh = bottom - top + 1;

    const t = getTile(mapLayer, z, tx, ty, true);
    if (t?.ok) {
      g.drawImage(t.img, dx, dy, dw, dh);
      continue;
    }
    // Not loaded yet: show the part of a coarser tile we already have.
    for (let d = 1; d <= 3 && z - d >= TILE_MIN_Z; d++) {
      const p = getTile(mapLayer, z - d, tx >> d, ty >> d, false);
      if (!p?.ok) continue;
      const part = 256 / 2 ** d;
      g.drawImage(
        p.img,
        (tx & (2 ** d - 1)) * part,
        (ty & (2 ** d - 1)) * part,
        part,
        part,
        dx,
        dy,
        dw,
        dh,
      );
      break;
    }
  }

  // Dim the map so the targets stand out (user-adjustable).
  if (mapDim > 0) {
    g.fillStyle = `rgba(11, 15, 20, ${mapDim})`;
    g.fillRect(0, 0, w, h);
  }
  if (attribution) {
    g.fillStyle = "rgba(255, 255, 255, 0.7)";
    g.font = "10px system-ui";
    g.fillText("© MapTiler © OpenStreetMap contributors", 8, h - 8);
  }
}

function draw() {
  requestAnimationFrame(draw);
  // The canvas has no size until the first layout: nothing to draw yet.
  if (cssW < 2 || cssH < 2) return;
  const now = performance.now();

  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, cssW, cssH);

  const cx = cssW / 2;
  const cy = cssH / 2;
  const followed = followEl.checked && !followPaused ? selectedTrack() : null;
  if (followed) {
    view.x = followed.x;
    view.y = followed.y;
  }
  clampView();
  const scale = pxPerMeter();
  const toX = (x) => cx + (x - view.x) * scale;
  const toY = (y) => cy - (y - view.y) * scale; // +y is north (up)
  const ox = toX(0); // the radar
  const oy = toY(0);
  drawMap(ctx, cssW, cssH, view.x, view.y, scale, toX, toY, true);
  drawZones(ctx, toX, toY, scale);

  // Trail: sample a few points evenly (always including oldest and newest)
  // and draw a smooth curve through them instead of all 40. Returns the
  // number of path operations added.
  const addTrail = (path, t) => {
    // Default trails use a few points; longer ones are thinned to a budget.
    const budget =
      t.cap > TRAIL_LEN
        ? Math.min(
            MAX_TRAIL_SAMPLES,
            Math.max(TRAIL_SAMPLES, Math.ceil(t.len / 3)),
          )
        : TRAIL_SAMPLES;
    const n = Math.min(t.len, budget);
    if (n < 2) return 0;
    const start = (t.head - t.len + t.cap) % t.cap;
    for (let j = 0; j < n; j++) {
      const i = Math.round((j * (t.len - 1)) / (n - 1));
      const idx = ((start + i) % t.cap) * 2;
      sample[j * 2] = toX(t.pts[idx]);
      sample[j * 2 + 1] = toY(t.pts[idx + 1]);
    }
    // Quadratic curves with the sampled points as control points and the
    // midpoints between them as anchors: smooth, no overshoot.
    path.moveTo(sample[0], sample[1]);
    for (let j = 1; j < n - 1; j++) {
      path.quadraticCurveTo(
        sample[j * 2],
        sample[j * 2 + 1],
        (sample[j * 2] + sample[j * 2 + 2]) / 2,
        (sample[j * 2 + 1] + sample[j * 2 + 3]) / 2,
      );
    }
    path.lineTo(sample[n * 2 - 2], sample[n * 2 - 1]);
    return n + 1;
  };

  // Closest dot to the pointer (within HIT_R), found during the draw loop.
  let bestD = HIT_R * HIT_R;
  let bestKey = null;
  let bestT = null;
  let bestX = 0;
  let bestY = 0;
  // With few targets, write an ID next to every dot.
  const labelAll = tracks.size <= LABEL_MAX_TRACKS;
  const labels = []; // flat: t, px, py, t, px, py, ...
  // With a manageable number of targets, draw an icon on each identified
  // drone/airplane. Above that, only highlighted targets get one.
  const iconsAll = tracks.size <= ICON_MAX_TRACKS;
  const icons = []; // flat: t, px, py, ...

  // Small helper used for both the batch icons and the highlighted ones.
  const drawIcon = (t, px, py, size) => {
    const icon = iconFor(t);
    if (!icon) return;
    ctx.save();
    ctx.translate(px, py);
    // Airplanes point along their heading (clockwise from north); the nose of
    // the SVG points up.
    // The bird is a side view: never rotated, just mirrored to face left.
    if (icon.kind === "bird") {
      if (t.vx < 0) ctx.scale(-1, 1);
    } else if (icon.kind !== "drone" && icon.kind !== "unknown")
      ctx.rotate(Math.atan2(t.vx, t.vy));
    // Only the "?" is drawn smaller than the other icons.
    const s = icon.kind === "unknown" ? size * 0.7 : size;
    ctx.drawImage(icon.img, -s / 2, -s / 2, s, s);
    ctx.restore();
  };

  // range rings
  // Brighter over a map, so the rings stay visible.
  const overMap = mapLayer !== "off";
  ctx.strokeStyle = overMap ? "rgba(255, 255, 255, 0.35)" : "#1c2530";
  ctx.fillStyle = overMap ? "#e2e8f0" : "#4b5b6e";
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui";
  for (let r = RING_STEP_M; r <= WORLD_RADIUS_M; r += RING_STEP_M) {
    ctx.beginPath();
    ctx.arc(ox, oy, r * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(fmtDist(r), ox + 4, oy - r * scale - 2);
  }
  ctx.beginPath();
  ctx.moveTo(ox - WORLD_RADIUS_M * scale, oy);
  ctx.lineTo(ox + WORLD_RADIUS_M * scale, oy);
  ctx.moveTo(ox, oy - WORLD_RADIUS_M * scale);
  ctx.lineTo(ox, oy + WORLD_RADIUS_M * scale);
  ctx.stroke();

  // Small when zoomed out, growing with zoom up to a maximum size.
  drawRadar(
    ctx,
    ox,
    oy,
    Math.min(RADAR_MAX_PX, RADAR_MIN_PX + (view.zoom - 1) * RADAR_PX_PER_ZOOM),
  );

  // Batch drawing by color (a generator's, or a mark's) instead of one
  // stroke/fill per target. Each batch is flushed once it holds MAX_PATH_OPS
  // operations, because Chromium's canvas fails ("Failed to serialize op")
  // when one path gets too large.
  const batches = new Map();
  const flush = (colorKey, g) => {
    const color = colorOfKey(colorKey);
    if (g.lineOps) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.stroke(g.lines);
      ctx.globalAlpha = 1;
    }
    if (g.dotOps) {
      ctx.fillStyle = color;
      ctx.fill(g.dots);
    }
    g.lines = new Path2D();
    g.dots = new Path2D();
    g.lineOps = 0;
    g.dotOps = 0;
  };

  for (const [key, t] of tracks) {
    if (!frozen && now - t.seen > STALE_MS) {
      tracks.delete(key);
      listVersion++;
      continue;
    }
    if (isIgnored(t)) continue; // hidden from the scope, still in the list

    const colorKey = colorKeyOf(t);
    let g = batches.get(colorKey);
    if (!g) {
      g = {
        lines: new Path2D(),
        dots: new Path2D(),
        lineOps: 0,
        dotOps: 0,
      };
      batches.set(colorKey, g);
    }

    const px = toX(t.x);
    const py = toY(t.y);

    g.lineOps += addTrail(g.lines, t);

    // Hit test against the pointer while we already have the screen position.
    if (pointer.inside) {
      const dx = px - pointer.x;
      const dy = py - pointer.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestKey = key;
        bestT = t;
        bestX = px;
        bestY = py;
      }
    }
    if (labelAll) labels.push(t, px, py);
    if (iconsAll && iconKindOf(t)) icons.push(t, px, py);

    // velocity vector (1s lookahead)
    g.lines.moveTo(px, py);
    g.lines.lineTo(toX(t.x + t.vx), toY(t.y + t.vy));
    g.lineOps += 2;

    g.dots.moveTo(px + DOT_R, py);
    g.dots.arc(px, py, DOT_R, 0, Math.PI * 2);
    g.dotOps++;

    if (g.lineOps + g.dotOps >= MAX_PATH_OPS) flush(colorKey, g);
  }

  for (const [colorKey, g] of batches) flush(colorKey, g);

  // --- Icons, IDs, hover, selection --------------------------------------
  for (let i = 0; i < icons.length; i += 3) {
    drawIcon(icons[i], icons[i + 1], icons[i + 2], 18);
  }

  ctx.font = "10px system-ui";
  ctx.fillStyle = "#8fa0b3";
  for (let i = 0; i < labels.length; i += 3) {
    // Highlighted targets draw their own (brighter) label; skip the plain one.
    const k = labels[i].key;
    if (k === selectedKey || k === listHoverKey) continue;
    ctx.fillText(trackLabel(labels[i]), labels[i + 1] + 6, labels[i + 2] - 6);
  }

  if (pointer.click) {
    pointer.click = false;
    // Clicking a dot selects it. It stays selected (even if you click empty
    // space) until Esc, or until you select another target.
    if (bestKey) {
      select(bestKey);
      scrollListTo = bestKey;
    }
  }

  const selected = selectedTrack() ?? null;
  if (!selected && selectedKey) select(null); // the target went away
  updateActions(selected);

  // Highlight a target: bigger icon, ring and ID. `strong` is for the one that
  // stays selected, which also gets a heavier trail.
  const highlight = (t, ringColor, strong) => {
    if (isIgnored(t)) return; // not on the scope
    const hx = toX(t.x);
    const hy = toY(t.y);
    if (strong) {
      const trail = new Path2D();
      addTrail(trail, t);
      ctx.strokeStyle = colorOf(t);
      ctx.lineWidth = 2;
      ctx.stroke(trail);
    }
    drawIcon(t, hx, hy, 30);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = strong ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(hx, hy, DOT_R + (strong ? 7 : 6), 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#fff";
    ctx.font = "11px system-ui";
    ctx.fillText(trackLabel(t), hx + 14, hy - 10);
  };

  // Hovering a row in the list lights up its dot, even if it is far away.
  const listHover = listHoverKey ? tracks.get(listHoverKey) : null;
  if (listHover && listHover !== selected) highlight(listHover, "#fff", false);
  if (selected) highlight(selected, colorOf(selected), true);

  if (bestT) {
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.arc(bestX, bestY, DOT_R + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  hoverKey = bestKey;
  canvas.style.cursor = panning ? "grabbing" : hoverKey ? "pointer" : "default";

  // Hover popup follows the pointer; flips to stay inside the window.
  if (bestT && !menuKey) {
    setText(tipEl, describe(bestT));
    tipEl.hidden = false;
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    const left = pointer.clientX + 16;
    const top = pointer.clientY + 16;
    tipEl.style.left = `${left + w > innerWidth ? pointer.clientX - w - 16 : left}px`;
    tipEl.style.top = `${top + h > innerHeight ? pointer.clientY - h - 16 : top}px`;
  } else {
    tipEl.hidden = true;
  }

  // Tracked-target panel stays up (and live) until released with Esc.
  if (selected) {
    setText(
      selectedEl,
      `TRACKING${isIgnored(selected) ? " (ignored: hidden from the scope)" : ""}\n${describe(selected)}\n\nEsc to release`,
    );
    selectedEl.hidden = false;
  } else {
    selectedEl.hidden = true;
  }

  drawMinimap(now, cx, cy, scale);
  updateList(now);
}

// --- Minimap ---------------------------------------------------------------
// Shows every target (ignored ones too) over the whole radar range, with the
// scope's visible area as a rectangle. Click or drag on it to move the view.
const mini = document.getElementById("minimap");
const mctx = mini.getContext("2d");
const zoomLabel = document.getElementById("zoomLabel");
let miniSize = 0;
let miniAt = 0;
let miniSig = "";
const MINI_COLORS = ["neutral", "unknown", "enemy", "friendly"]; // draw friendly last

function sizeMinimap() {
  const dpr = window.devicePixelRatio || 1;
  const r = mini.getBoundingClientRect();
  miniSize = r.width;
  mini.width = Math.round(r.width * dpr);
  mini.height = Math.round(r.height * dpr);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  miniSig = ""; // force a repaint
}
new ResizeObserver(sizeMinimap).observe(mini);

const MINI_PAD = 4;
// The minimap covers the home area plus the pannable margin.
const miniScale = () =>
  (miniSize / 2 - MINI_PAD) / (WORLD_RADIUS_M + PAN_MARGIN_M);

function drawMinimap(now, cx, cy, scale) {
  setText(zoomLabel, `${view.zoom.toFixed(1)}×`);
  // Targets move at 10 Hz and there can be 100k of them: repaint ~10x/s, or
  // right away when the view changes.
  const sig = `${view.x}|${view.y}|${view.zoom}|${cssW}|${cssH}|${selectedKey}|${mapLayer}|${mapDim}`;
  if (sig === miniSig && now - miniAt < 100) return;
  miniSig = sig;
  miniAt = now;

  const s = miniScale();
  const c = miniSize / 2;
  mctx.fillStyle = "#0b0f14";
  mctx.fillRect(0, 0, miniSize, miniSize);
  // The same map, zoomed out to the whole radar range.
  drawMap(
    mctx,
    miniSize,
    miniSize,
    0,
    0,
    s,
    (x) => c + x * s,
    (y) => c - y * s,
    false,
  );
  mctx.strokeStyle =
    mapLayer === "off" ? "#1c2530" : "rgba(255, 255, 255, 0.35)";
  mctx.beginPath();
  mctx.arc(c, c, WORLD_RADIUS_M * s, 0, Math.PI * 2);
  mctx.stroke();

  // One pass per color so fillStyle changes only three times.
  for (const colorKey of MINI_COLORS) {
    mctx.fillStyle = AFFIL_COLOR[colorKey];
    for (const t of tracks.values()) {
      if (colorKeyOf(t) !== colorKey) continue;
      mctx.fillRect(c + t.x * s - 1, c - t.y * s - 1, 2, 2);
    }
  }
  drawRadar(mctx, c, c, 14);

  const sel = selectedTrack();
  if (sel) {
    mctx.strokeStyle = "#fff";
    mctx.beginPath();
    mctx.arc(c + sel.x * s, c - sel.y * s, 4, 0, Math.PI * 2);
    mctx.stroke();
  }

  // The scope's visible area, in world meters.
  const hw = cssW / 2 / scale;
  const hh = cssH / 2 / scale;
  mctx.strokeStyle = "#fff";
  mctx.lineWidth = 1.5;
  mctx.strokeRect(
    c + (view.x - hw) * s,
    c - (view.y + hh) * s,
    2 * hw * s,
    2 * hh * s,
  );
  mctx.lineWidth = 1;
}

// Click/drag on the minimap puts that spot at the center of the scope.
let miniDrag = false;
function miniMove(e) {
  const r = mini.getBoundingClientRect();
  const s = miniScale();
  stopFollowing();
  view.x = (e.clientX - r.left - miniSize / 2) / s;
  view.y = -(e.clientY - r.top - miniSize / 2) / s;
  clampView();
}
mini.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  closeMenu();
  miniDrag = true;
  miniMove(e);
});
window.addEventListener("mousemove", (e) => {
  if (miniDrag) miniMove(e);
});
window.addEventListener("mouseup", () => {
  miniDrag = false;
});
// --- Zones of interest ------------------------------------------------------
// Circular or rectangular areas in local meters (x east, y north of the
// radar). When an enemy or unknown target enters one, a notification pops up.
// Zones are saved in localStorage. Moving or reshaping one needs edit mode.
const ZONE_COLOR = "#f59e0b";
const METERS_PER_MILE = 1609.344;

// lat/lon -> local meters, using the same projection as the map tiles.
function localFromLatLon(lat, lon) {
  const my = EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return {
    x: ((EARTH_R * (lon - RADAR_LON) * Math.PI) / 180) * MERC_K,
    y: (my - RADAR_MERC.y) * MERC_K,
  };
}

const newZoneId = () =>
  `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function defaultZones() {
  // The radar sits at the Space Needle. The second zone covers the I-5 Ship
  // Canal Bridge (running north-south) and 0.15 mile either side of it.
  const mid = localFromLatLon(47.6495, -122.3222);
  const south = localFromLatLon(47.6455, -122.3222).y + 450;
  const north = localFromLatLon(47.6535, -122.3222).y + 350;
  const half = 0.15 * METERS_PER_MILE;
  return [
    {
      id: newZoneId(),
      name: "Space Needle",
      shape: "circle",
      x: 0,
      y: 0,
      r: 500,
      visible: true,
    },
    {
      id: newZoneId(),
      name: "I-5 Ship Canal Bridge",
      shape: "rect",
      minX: mid.x - half,
      maxX: mid.x + half,
      minY: south,
      maxY: north,
      visible: true,
    },
  ];
}

function loadZones() {
  try {
    const raw = localStorage.getItem("zones");
    if (raw !== null) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    }
  } catch {}
  return defaultZones();
}
let zones = loadZones();
let showZones = localStorage.getItem("showZones") !== "0";
const saveZones = () => localStorage.setItem("zones", JSON.stringify(zones));

const inZone = (z, x, y) =>
  z.shape === "circle"
    ? (x - z.x) ** 2 + (y - z.y) ** 2 <= z.r ** 2
    : x >= z.minX && x <= z.maxX && y >= z.minY && y <= z.maxY;

// --- Notifications ---
const toastsEl = document.getElementById("toasts");
function toast(text, color, key) {
  const el = document.createElement("div");
  el.className = "toast";
  el.style.borderLeftColor = color;
  const msg = document.createElement("span");
  msg.className = "tmsg";
  msg.textContent = text;
  msg.title = "Click to select this target";
  // Clicking the text selects the target; the alert stays until dismissed.
  msg.addEventListener("click", () => {
    if (tracks.has(key)) select(key);
  });
  const close = document.createElement("button");
  close.className = "tclose";
  close.textContent = "×";
  close.title = "Dismiss";
  close.addEventListener("click", () => el.remove());
  el.append(msg, close);
  toastsEl.appendChild(el);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Zone alert", { body: text });
  }
}

// Called for every target update. Alerts once when an enemy or unknown target
// enters a zone (again if it leaves and comes back).
function checkZones(t) {
  if (!zones.length) return;
  const threat = !isIgnored(t) && ["enemy", "unknown"].includes(affilOf(t));
  for (const z of zones) {
    const inside = threat && inZone(z, t.x, t.y);
    if (!inside) {
      if (t.alerted?.delete(z.id) && !t.alerted.size) t.alerted = undefined;
      continue;
    }
    if (t.alerted?.has(z.id)) continue;
    (t.alerted ??= new Set()).add(z.id);
    const aff = affilOf(t);
    toast(
      `${aff.toUpperCase()} ${trackLabel(t)} (${tagName(t)}) entered ${z.name}`,
      aff === "enemy" ? AFFIL_COLOR.enemy : AFFIL_COLOR.unknown,
      t.key,
    );
  }
}

// --- Interaction: create and edit ---
let zoneShape = "circle"; // shape for new zones
let creating = false; // waiting for / dragging out a new zone
let editingId = null; // zone being edited
let zoneDrag = null; // { kind: "create" | "move" | "resize", ... }
let draft = null; // zone being dragged out (not saved yet)
let zoneClickGuard = false; // swallow the click that ends a zone drag

function worldAt(e) {
  const r = canvas.getBoundingClientRect();
  const s = pxPerMeter();
  return {
    x: view.x + (e.clientX - r.left - cssW / 2) / s,
    y: view.y - (e.clientY - r.top - cssH / 2) / s,
  };
}

// Edit handles in world meters: the circle's east edge, or a rectangle's corners.
function zoneHandles(z) {
  if (z.shape === "circle") return [{ id: "r", x: z.x + z.r, y: z.y }];
  return [
    { id: "minX,minY", x: z.minX, y: z.minY },
    { id: "maxX,minY", x: z.maxX, y: z.minY },
    { id: "minX,maxY", x: z.minX, y: z.maxY },
    { id: "maxX,maxY", x: z.maxX, y: z.maxY },
  ];
}

function setCreating(on) {
  creating = on;
  if (on) editingId = null;
  zoneDrag = null;
  draft = null;
  canvas.style.cursor = on ? "crosshair" : "";
  renderZonePanel();
}
function setEditing(id) {
  editingId = id;
  if (id) creating = false;
  zoneDrag = null;
  draft = null;
  canvas.style.cursor = "";
  renderZonePanel();
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const w = worldAt(e);
  if (creating) {
    zoneDrag = { kind: "create", sx: w.x, sy: w.y };
    draft =
      zoneShape === "circle"
        ? { shape: "circle", x: w.x, y: w.y, r: 0 }
        : { shape: "rect", minX: w.x, maxX: w.x, minY: w.y, maxY: w.y };
    zoneClickGuard = true;
    closeMenu();
    return;
  }
  const z = zones.find((q) => q.id === editingId);
  if (!z) return;
  const s = pxPerMeter();
  const handle = zoneHandles(z).find(
    (h) => Math.hypot(h.x - w.x, h.y - w.y) * s <= 10,
  );
  if (handle) {
    zoneDrag = { kind: "resize", z, handle: handle.id };
    zoneClickGuard = true;
  } else if (inZone(z, w.x, w.y)) {
    zoneDrag = { kind: "move", z, lx: w.x, ly: w.y };
    zoneClickGuard = true;
  }
});

window.addEventListener("mousemove", (e) => {
  if (!zoneDrag) {
    if (editingId && e.target === canvas) {
      const z = zones.find((q) => q.id === editingId);
      const w = worldAt(e);
      canvas.style.cursor =
        z &&
        (inZone(z, w.x, w.y) ||
          zoneHandles(z).some(
            (h) => Math.hypot(h.x - w.x, h.y - w.y) * pxPerMeter() <= 10,
          ))
          ? "move"
          : "";
    }
    return;
  }
  const w = worldAt(e);
  const d = zoneDrag;
  if (d.kind === "create") {
    if (zoneShape === "circle") {
      draft.r = Math.hypot(w.x - d.sx, w.y - d.sy);
    } else {
      draft.minX = Math.min(d.sx, w.x);
      draft.maxX = Math.max(d.sx, w.x);
      draft.minY = Math.min(d.sy, w.y);
      draft.maxY = Math.max(d.sy, w.y);
    }
  } else if (d.kind === "move") {
    const dx = w.x - d.lx;
    const dy = w.y - d.ly;
    d.lx = w.x;
    d.ly = w.y;
    const z = d.z;
    if (z.shape === "circle") {
      z.x += dx;
      z.y += dy;
    } else {
      z.minX += dx;
      z.maxX += dx;
      z.minY += dy;
      z.maxY += dy;
    }
  } else if (d.kind === "resize") {
    const z = d.z;
    if (z.shape === "circle") {
      z.r = Math.max(10, Math.hypot(w.x - z.x, w.y - z.y));
    } else {
      const [hx, hy] = d.handle.split(",");
      z[hx] = w.x;
      z[hy] = w.y;
      // Dragging past the opposite side flips which edge is which.
      if (z.minX > z.maxX)
        [z.minX, z.maxX, d.handle] = [
          z.maxX,
          z.minX,
          d.handle.replace(/^(min|max)X/, (m) =>
            m === "minX" ? "maxX" : "minX",
          ),
        ];
      if (z.minY > z.maxY)
        [z.minY, z.maxY, d.handle] = [
          z.maxY,
          z.minY,
          d.handle.replace(/(min|max)Y$/, (m) =>
            m === "minY" ? "maxY" : "minY",
          ),
        ];
    }
  }
});

window.addEventListener("mouseup", () => {
  const d = zoneDrag;
  if (!d) return;
  zoneDrag = null;
  if (d.kind === "create") {
    const big =
      draft.shape === "circle"
        ? draft.r >= 10
        : draft.maxX - draft.minX >= 10 && draft.maxY - draft.minY >= 10;
    if (big) {
      zones.push({
        ...draft,
        id: newZoneId(),
        name: `Zone ${zones.length + 1}`,
        visible: true,
      });
      saveZones();
    }
    draft = null;
    setCreating(false); // one zone per click of "New zone"
  } else {
    saveZones();
  }
});

// The click that ends a zone drag (or any click while creating) must not
// select or deselect targets underneath.
window.addEventListener(
  "click",
  (e) => {
    if (e.target === canvas && (creating || zoneClickGuard)) {
      e.stopPropagation();
    }
    zoneClickGuard = false;
  },
  true,
);

window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || (!creating && !editingId)) return;
    e.stopPropagation(); // don't also deselect the target
    if (creating) setCreating(false);
    else setEditing(null);
  },
  true,
);

// --- Panel ---
const zonePanel = document.getElementById("zonePanel");
function renderZonePanel() {
  zonePanel.replaceChildren();
  const head = document.createElement("div");
  head.className = "zhead";
  const showLbl = document.createElement("label");
  showLbl.title = "Show or hide zones on the scope (alerts stay on)";
  const showBox = Object.assign(document.createElement("input"), {
    type: "checkbox",
    checked: showZones,
  });
  showBox.dataset.act = "showAll";
  showLbl.append(showBox, " Zones");
  const add = document.createElement("button");
  add.dataset.act = "create";
  add.textContent = creating ? "Cancel" : "+ New zone";
  head.append(showLbl, add);
  zonePanel.appendChild(head);

  if (creating) {
    const shapes = document.createElement("div");
    shapes.className = "seg zshape";
    for (const [id, label] of [
      ["circle", "Circle"],
      ["rect", "Rectangle"],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.act = "shape";
      b.dataset.shape = id;
      b.classList.toggle("active", zoneShape === id);
      shapes.appendChild(b);
    }
    const hint = document.createElement("div");
    hint.className = "zhint";
    hint.textContent =
      zoneShape === "circle"
        ? "Click the center, drag out the radius, release."
        : "Click one corner, drag to the opposite corner, release.";
    zonePanel.append(shapes, hint);
  }

  for (const z of zones) {
    const row = document.createElement("div");
    row.className = "zrow";
    row.dataset.id = z.id;
    const vis = Object.assign(document.createElement("input"), {
      type: "checkbox",
      checked: z.visible !== false,
      title: "Show this zone",
    });
    vis.dataset.act = "vis";
    const name = document.createElement("span");
    name.className = "zname";
    name.dataset.act = "rename";
    name.title = "Double-click to rename";
    name.textContent = z.name;
    const edit = document.createElement("button");
    edit.dataset.act = "edit";
    edit.textContent = editingId === z.id ? "Done" : "Edit";
    edit.classList.toggle("active", editingId === z.id);
    const del = document.createElement("button");
    del.dataset.act = "delete";
    del.textContent = "Delete";
    row.append(vis, name, edit, del);
    zonePanel.appendChild(row);
  }
  if (!zones.length) {
    const none = document.createElement("div");
    none.className = "zhint";
    none.textContent = "No zones yet.";
    zonePanel.appendChild(none);
  }
}

zonePanel.addEventListener("click", (e) => {
  const act = e.target.dataset?.act;
  const id = e.target.closest(".zrow")?.dataset.id;
  if (act === "create") {
    setCreating(!creating);
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission(); // for desktop alerts too
    }
  } else if (act === "shape") {
    zoneShape = e.target.dataset.shape;
    renderZonePanel();
  } else if (act === "edit") {
    setEditing(editingId === id ? null : id);
  } else if (act === "delete") {
    const z = zones.find((q) => q.id === id);
    if (z && confirm(`Delete zone "${z.name}"?`)) {
      zones = zones.filter((q) => q.id !== id);
      if (editingId === id) editingId = null;
      saveZones();
      renderZonePanel();
    }
  }
});
zonePanel.addEventListener("change", (e) => {
  const act = e.target.dataset?.act;
  if (act === "showAll") {
    showZones = e.target.checked;
    localStorage.setItem("showZones", showZones ? "1" : "0");
  } else if (act === "vis") {
    const z = zones.find((q) => q.id === e.target.closest(".zrow").dataset.id);
    if (z) {
      z.visible = e.target.checked;
      saveZones();
    }
  }
});
zonePanel.addEventListener("dblclick", (e) => {
  if (e.target.dataset?.act !== "rename") return;
  const z = zones.find((q) => q.id === e.target.closest(".zrow").dataset.id);
  const name = z && prompt("Zone name", z.name);
  if (name?.trim()) {
    z.name = name.trim();
    saveZones();
    renderZonePanel();
  }
});
renderZonePanel();

// --- Drawing (called from draw(), under the targets) ---
function drawZones(g, toX, toY, scale) {
  if (!showZones && !draft) return;
  g.save();
  g.font = "11px system-ui";
  const one = (z, editing, isDraft) => {
    g.beginPath();
    if (z.shape === "circle") {
      g.arc(toX(z.x), toY(z.y), z.r * scale, 0, Math.PI * 2);
    } else {
      g.rect(
        toX(z.minX),
        toY(z.maxY),
        (z.maxX - z.minX) * scale,
        (z.maxY - z.minY) * scale,
      );
    }
    g.fillStyle = "rgba(245, 158, 11, 0.12)";
    g.fill();
    g.strokeStyle = ZONE_COLOR;
    g.lineWidth = editing ? 2.5 : 1.5;
    g.setLineDash(isDraft || editing ? [] : [8, 5]);
    g.stroke();
    g.setLineDash([]);
    if (z.name) {
      const lx =
        z.shape === "circle" ? toX(z.x) : (toX(z.minX) + toX(z.maxX)) / 2;
      const ly =
        z.shape === "circle" ? toY(z.y) - z.r * scale - 6 : toY(z.maxY) - 6;
      g.textAlign = "center";
      g.fillStyle = ZONE_COLOR;
      g.fillText(z.name, lx, ly);
    }
    if (editing) {
      g.fillStyle = "#fff";
      g.strokeStyle = "#0b0f14";
      g.lineWidth = 1;
      for (const h of zoneHandles(z)) {
        g.beginPath();
        g.rect(toX(h.x) - 5, toY(h.y) - 5, 10, 10);
        g.fill();
        g.stroke();
      }
    }
  };
  if (showZones) {
    for (const z of zones) {
      if (z.visible !== false || z.id === editingId)
        one(z, z.id === editingId, false);
    }
  }
  if (draft) one(draft, false, true);
  g.restore();
}

requestAnimationFrame(draw);
