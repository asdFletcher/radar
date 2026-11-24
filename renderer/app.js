const HEADER_BYTES = 20;
const RECORD_BYTES = 32;
const TRAIL_LEN = 40; // 4s at 10 Hz
const WORLD_RADIUS_M = 4000; // scope range (match WORLD in backend/generator.js)
const RING_STEP_M = 1000;

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
// { affil?: "friendly" | "enemy" | "unknown", ignored?: boolean, trailLen?: number }
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
// Same idea for designations: "friendly" | "enemy" | "unknown".
const ignoredAffils = new Set();
const affilOf = (t) => t.mark?.affil ?? "unknown";
const ignoredByFilter = (t) =>
  ignoredTags.has(t.cls) || ignoredAffils.has(affilOf(t));
const isIgnored = (t) => !!t.mark?.ignored || ignoredByFilter(t);

// Color key for batching and tinting: every target is "unknown" (yellow)
// until the user marks it friendly or enemy.
const colorKeyOf = (t) => t.mark?.affil || "unknown";
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

function ingestFrame(buf) {
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
      const cap = mark?.trailLen ?? TRAIL_LEN;
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
    t.cls = view.getUint8(o + 28);
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
  if (e.ctrlKey || justPanned) {
    justPanned = false; // the end of a pan isn't a click on a dot
    return;
  }
  pointer.click = true;
});

// --- View: pan and zoom -------------------------------------------------
// `view` is the world point (meters) at the center of the scope, plus a zoom
// factor where 1 shows the whole radar range.
const view = { x: 0, y: 0, zoom: 1 };
const MAX_ZOOM = 60;
let panning = null; // { sx, sy, vx, vy } while ctrl+dragging
let justPanned = false;

const pxPerMeter = () =>
  ((Math.min(cssW, cssH) / 2 - 20) / WORLD_RADIUS_M) * view.zoom;

// Keep the view inside the radar range (at zoom 1 it is locked to the center).
function clampView() {
  view.zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom));
  const lim = WORLD_RADIUS_M * (1 - 1 / view.zoom);
  view.x = Math.max(-lim, Math.min(lim, view.x));
  view.y = Math.max(-lim, Math.min(lim, view.y));
}

function resetView() {
  view.x = view.y = 0;
  view.zoom = 1;
}

// Ctrl + drag grabs the map: it follows the pointer.
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !e.ctrlKey) return;
  e.preventDefault();
  closeMenu();
  panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  const dx = e.clientX - panning.sx;
  const dy = e.clientY - panning.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) justPanned = true;
  const s = pxPerMeter();
  view.x = panning.vx - dx / s;
  view.y = panning.vy + dy / s; // screen y grows downward, world y upward
  clampView();
});
window.addEventListener("mouseup", () => {
  panning = null;
});

// Ctrl + wheel zooms (wheel up = in). Over the scope it zooms around the
// pointer; elsewhere it zooms in on the tracked target, or the center.
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
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
    if (e.target === canvas) {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - cssW / 2;
      const my = e.clientY - r.top - cssH / 2;
      // Keep the world point under the pointer where it is.
      view.x += mx / before - mx / after;
      view.y -= my / before - my / after;
    } else {
      const t = selectedTrack();
      if (t) {
        view.x = t.x;
        view.y = t.y;
      }
      // No tracked target: keep the current center.
    }
    clampView();
  },
  { passive: false },
);
document.getElementById("resetView").addEventListener("click", resetView);
// The one place selection changes, so the list repaints its highlight.
function select(key) {
  selectedKey = key;
  listDirty = true;
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    select(null);
    closeMenu();
  }
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
  for (const id of ["friendly", "enemy", "unknown"]) {
    const b = document.createElement("button");
    b.className = `aff ${id}`;
    b.dataset.affil = id;
    b.textContent = id[0].toUpperCase() + id.slice(1);
    b.classList.toggle("active", id === (t.mark?.affil ?? "unknown"));
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
  if (e.ctrlKey) return; // on macOS ctrl+click is a context click: it's a pan
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
};
const ICON_KIND = ["drone", "airplane"]; // by class_id; other tags get no icon
const iconCache = new Map(); // "kind:color" -> HTMLImageElement

function iconFor(t) {
  const kind = ICON_KIND[t.cls]; // undefined for unidentified / other tags
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

// Radar-style measurements from the radar-relative position and velocity.
function describe(t) {
  const ground = Math.hypot(t.x, t.y);
  const range = Math.hypot(ground, t.z);
  const azimuth = ((Math.atan2(t.x, t.y) * 180) / Math.PI + 360) % 360; // from north, clockwise
  const elevation = (Math.atan2(t.z, ground) * 180) / Math.PI;
  const speed = Math.hypot(t.vx, t.vy, t.vz);
  // Positive = moving away from the radar.
  const radial = range > 0 ? (t.x * t.vx + t.y * t.vy + t.z * t.vz) / range : 0;

  const row = (label, value) => `${label.padEnd(10)}${value}`;
  return [
    `${trackLabel(t)}  ${tagName(t)}  [${t.mark?.affil ?? "unknown"}]`,
    row("Range", fmtDist(range)),
    row("Azimuth", `${azimuth.toFixed(1)}°`),
    row("Elevation", `${elevation.toFixed(1)}°`),
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

// List sections, top to bottom. Targets with no mark count as unknown.
const GROUPS = [
  { id: "unknown", label: "Unknown", color: AFFIL_COLOR.unknown },
  { id: "enemy", label: "Enemy", color: AFFIL_COLOR.enemy },
  { id: "friendly", label: "Friendly", color: AFFIL_COLOR.friendly },
];
const groupOf = (t) =>
  t.mark?.affil === "enemy" ? 1 : t.mark?.affil === "friendly" ? 2 : 0;

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
  // The tag of a target can change (it gets identified), so with a filter
  // active, rebuild periodically as well.
  const rebuild =
    listBuilt.version !== listVersion ||
    listBuilt.filter !== filter ||
    listBuilt.showIgnored !== showIgnored ||
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
        !`${trackLabel(t)} ${tagName(t)} ${t.mark?.affil ?? "unknown"}`
          .toLowerCase()
          .includes(filter)
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
    listBuilt = { version: listVersion, filter, showIgnored, at: now };
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
for (const id of ["friendly", "unknown", "enemy"]) {
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
    ? `${t.key}|${t.mark?.affil}|${t.mark?.ignored}|${typeIgnored}|${t.cap}`
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
      !!t &&
        !!b.dataset.affil &&
        b.dataset.affil === (t.mark?.affil ?? "unknown"),
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
  trailSel.value = String(t ? t.cap : TRAIL_LEN);
}

function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();

  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, cssW, cssH);

  const cx = cssW / 2;
  const cy = cssH / 2;
  clampView();
  const scale = pxPerMeter();
  const toX = (x) => cx + (x - view.x) * scale;
  const toY = (y) => cy - (y - view.y) * scale; // +y is north (up)
  const ox = toX(0); // the radar
  const oy = toY(0);

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
    if (icon.kind === "airplane") ctx.rotate(Math.atan2(t.vx, t.vy));
    ctx.drawImage(icon.img, -size / 2, -size / 2, size, size);
    ctx.restore();
  };

  // range rings
  ctx.strokeStyle = "#1c2530";
  ctx.fillStyle = "#4b5b6e";
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
    if (now - t.seen > STALE_MS) {
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
    if (iconsAll && ICON_KIND[t.cls]) icons.push(t, px, py);

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
const MINI_COLORS = ["unknown", "enemy", "friendly"]; // draw friendly last

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
const miniScale = () => (miniSize / 2 - MINI_PAD) / WORLD_RADIUS_M;

function drawMinimap(now, cx, cy, scale) {
  setText(zoomLabel, `${view.zoom.toFixed(1)}×`);
  // Targets move at 10 Hz and there can be 100k of them: repaint ~10x/s, or
  // right away when the view changes.
  const sig = `${view.x}|${view.y}|${view.zoom}|${cssW}|${cssH}|${selectedKey}`;
  if (sig === miniSig && now - miniAt < 100) return;
  miniSig = sig;
  miniAt = now;

  const s = miniScale();
  const c = miniSize / 2;
  mctx.fillStyle = "#0b0f14";
  mctx.fillRect(0, 0, miniSize, miniSize);
  mctx.strokeStyle = "#1c2530";
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
requestAnimationFrame(draw);
