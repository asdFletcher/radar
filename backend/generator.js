"use strict";

const { encodeFrame, DEFAULT_CONFIG, sanitizeConfig } = require("./protocol");

// Half-width of the simulated world in meters (radar at the origin).
const WORLD = 4000;
const TWO_PI = Math.PI * 2;
const rand = (min, max) => min + Math.random() * (max - min);

// ---------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------

// Fake target tags. The array index is sent as `class_id`; the UI has the same
// list of names (renderer/app.js, CLASS_NAMES). Keep the two in the same order.
// speed and climb are in m/s (climb = max vertical speed), alt in meters.
const CLASSES = [
  {
    name: "drone",
    speed: [3, 12],
    climb: 3,
    alt: [20, 150],
    rcs: 0.55,
    weight: 40,
  },
  {
    name: "airplane",
    speed: [45, 80],
    climb: 5,
    alt: [300, 1000],
    rcs: 1,
    weight: 20,
  },
  {
    name: "helicopter",
    speed: [15, 40],
    climb: 4,
    alt: [80, 400],
    rcs: 0.8,
    weight: 15,
  },
  {
    name: "bird",
    speed: [3, 10],
    climb: 1.5,
    alt: [10, 80],
    rcs: 0.3,
    weight: 25,
  },
  // Ships only come from the live AIS feed (backend/live.js), never simulated.
  {
    name: "boat",
    speed: [2, 10],
    climb: 0,
    alt: [0, 0],
    rcs: 1,
    weight: 0,
  },
];

// Chance that a target can never be identified (it stays "?" on the UI).
const UNIDENTIFIED_CHANCE = 0.15;

// Sent as `class_id` until a target has been "identified".
const UNIDENTIFIED = 255;

function pickClass() {
  let r = Math.random() * CLASSES.reduce((sum, c) => sum + c.weight, 0);
  for (let i = 0; i < CLASSES.length; i++) {
    r -= CLASSES[i].weight;
    if (r < 0) return i;
  }
  return 0;
}

// `cls` is kept when a target is respawned (e.g. motion pattern change).
// `unidentifiable` is also kept; when omitted it is chosen at random.
function spawn(
  id,
  pattern,
  cls = pickClass(),
  unidentifiable = Math.random() < UNIDENTIFIED_CHANCE,
) {
  const resolved =
    pattern === "mixed" ? ["orbit", "patrol", "randomWalk"][id % 3] : pattern;

  const c = CLASSES[cls];
  const e = { id, cls, x: 0, y: 0, vx: 0, vy: 0 };
  e.altMin = c.alt[0];
  e.altMax = c.alt[1];
  e.z = rand(e.altMin, e.altMax);
  e.vz = rand(-1, 1) * c.climb; // climbs/descends slowly
  e.rcs = c.rcs;
  // A new track is unidentified until it has been observed for a few seconds.
  // Some are never identified (the radar's classification fails).
  e.age = 0;
  e.unidentifiable = unidentifiable;
  e.identifyAfter = unidentifiable ? Infinity : rand(1, 6);
  const speed = rand(c.speed[0], c.speed[1]);

  if (resolved === "orbit") {
    const r = rand(0.16 * WORLD, 0.7 * WORLD);
    e.kind = "orbit";
    e.cx = rand(-0.2 * WORLD, 0.2 * WORLD);
    e.cy = rand(-0.2 * WORLD, 0.2 * WORLD);
    e.r = r;
    e.theta = rand(0, TWO_PI);
    e.omega = (Math.random() < 0.5 ? 1 : -1) * (speed / r); // rad/s
    e.x = e.cx + r * Math.cos(e.theta);
    e.y = e.cy + r * Math.sin(e.theta);
  } else if (resolved === "patrol") {
    e.kind = "patrol";
    const edge = 0.9 * WORLD;
    e.a = [rand(-edge, edge), rand(-edge, edge)];
    e.b = [rand(-edge, edge), rand(-edge, edge)];
    e.t = Math.random(); // 0..1 along a->b
    e.dir = 1;
    e.speed = speed;
    e.x = e.a[0] + (e.b[0] - e.a[0]) * e.t;
    e.y = e.a[1] + (e.b[1] - e.a[1]) * e.t;
  } else {
    e.kind = "walk";
    e.heading = rand(0, TWO_PI);
    e.speed = speed;
    e.x = rand(-0.8 * WORLD, 0.8 * WORLD);
    e.y = rand(-0.8 * WORLD, 0.8 * WORLD);
  }
  return e;
}

function stepEntity(e, dt, speedMul) {
  e.age += dt;
  if (e.kind === "orbit") {
    e.theta += e.omega * speedMul * dt;
    e.x = e.cx + e.r * Math.cos(e.theta);
    e.y = e.cy + e.r * Math.sin(e.theta);
    const v = e.r * e.omega * speedMul;
    e.vx = -v * Math.sin(e.theta);
    e.vy = v * Math.cos(e.theta);
  } else if (e.kind === "patrol") {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    const len = Math.max(1, Math.hypot(dx, dy));
    const v = e.speed * speedMul;
    e.t += (e.dir * v * dt) / len;
    if (e.t >= 1) {
      e.t = 1;
      e.dir = -1;
    } else if (e.t <= 0) {
      e.t = 0;
      e.dir = 1;
    }
    e.x = e.a[0] + dx * e.t;
    e.y = e.a[1] + dy * e.t;
    e.vx = ((e.dir * dx) / len) * v;
    e.vy = ((e.dir * dy) / len) * v;
  } else {
    e.heading += rand(-1, 1) * 1.5 * dt;
    const v = e.speed * speedMul;
    e.vx = v * Math.cos(e.heading);
    e.vy = v * Math.sin(e.heading);
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    // Turn around at the edge of the world.
    if (Math.abs(e.x) > WORLD || Math.abs(e.y) > WORLD) {
      e.x = Math.max(-WORLD, Math.min(WORLD, e.x));
      e.y = Math.max(-WORLD, Math.min(WORLD, e.y));
      e.heading += Math.PI;
    }
  }

  // Altitude drifts within the class's range.
  e.z += e.vz * speedMul * dt;
  if (e.z < e.altMin || e.z > e.altMax) {
    e.z = Math.max(e.altMin, Math.min(e.altMax, e.z));
    e.vz = -e.vz;
  }
}

class Sim {
  constructor(config) {
    this.pattern = config.motionPattern;
    this.nextId = 1;
    this.entities = [];
    // The first targets of a generator cover every class once, in random
    // order, and the one after them never gets identified.
    // Classes with weight 0 (boats) are live-only and never simulated.
    this.startClasses = CLASSES.map((_, i) => i)
      .filter((i) => CLASSES[i].weight > 0)
      .sort(() => Math.random() - 0.5);
    this.resize(config.targetCount);
  }

  resize(n) {
    this.entities.length = Math.min(this.entities.length, n);
    while (this.entities.length < n) {
      const i = this.nextId - 1;
      const n = this.startClasses.length;
      const cls = i < n ? this.startClasses[i] : undefined;
      const unid = i === n ? true : i < n ? false : undefined;
      this.entities.push(spawn(this.nextId++, this.pattern, cls, unid));
    }
  }

  // Apply a live config change. Track IDs are preserved.
  reconfigure(config) {
    if (config.motionPattern !== this.pattern) {
      this.pattern = config.motionPattern;
      this.entities = this.entities.map((e) =>
        spawn(e.id, this.pattern, e.cls, e.unidentifiable),
      );
    }
    this.resize(config.targetCount);
  }

  step(dt, speedMul) {
    for (const e of this.entities) stepEntity(e, dt, speedMul);
  }

  snapshot(noiseMeters) {
    return this.entities.map((e) => {
      // Fake signal strength 0-255: bigger targets are stronger, and the
      // return falls off with range.
      const range = Math.hypot(e.x, e.y, e.z);
      const strength =
        (e.rcs * 255) / (1 + (range / (0.6 * WORLD)) ** 2) + rand(-5, 5);

      return {
        trackId: e.id,
        x: e.x + (noiseMeters > 0 ? rand(-noiseMeters, noiseMeters) : 0),
        y: e.y + (noiseMeters > 0 ? rand(-noiseMeters, noiseMeters) : 0),
        z: e.z,
        vx: e.vx,
        vy: e.vy,
        vz: e.vz,
        classId: e.age >= e.identifyAfter ? e.cls : UNIDENTIFIED,
        strength: Math.round(Math.max(10, Math.min(255, strength))),
        flags: 1,
      };
    });
  }
}

// ---------------------------------------------------------------------
// Generator: a Sim plus a self-correcting timer
// ---------------------------------------------------------------------

class Generator {
  /** @param onFrame (Buffer) => void */
  constructor(id, onFrame, config = DEFAULT_CONFIG) {
    this.id = id;
    this.onFrame = onFrame;
    this.config = sanitizeConfig(config);
    this.sim = null;
    this.seq = 0;
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.running) return;
    this.sim = new Sim(this.config);
    this.seq = 0;
    this.last = performance.now();
    this.next = this.last;
    this._schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  reset() {
    this.sim = new Sim(this.config);
    this.seq = 0;
  }

  update(patch) {
    const prev = this.config;
    this.config = sanitizeConfig(patch, prev);
    if (this.sim) this.sim.reconfigure(this.config);
    if (this.config.rateHz !== prev.rateHz) {
      this.next = performance.now() + 1000 / this.config.rateHz;
      if (this.running) {
        clearTimeout(this.timer);
        this._schedule();
      }
    }
  }

  _schedule() {
    const delay = Math.max(0, this.next - performance.now());
    this.timer = setTimeout(() => this._tick(), delay);
  }

  _tick() {
    const now = performance.now();
    const period = 1000 / this.config.rateHz;
    // Next tick keeps a steady cadence; skip ahead if we fell behind.
    this.next = Math.max(this.next + period, now);

    const dt = (now - this.last) / 1000;
    this.last = now; // updated while paused too, so resume has no big jump

    const cfg = this.config;
    if (!cfg.paused) {
      try {
        this.sim.step(dt, cfg.speedMultiplier);

        // seq increments even for deliberately dropped frames, so receivers
        // see genuine gaps.
        this.seq = (this.seq + 1) >>> 0;

        const dropped =
          cfg.dropRatePct > 0 && Math.random() * 100 < cfg.dropRatePct;
        if (!dropped) {
          const targets = this.sim.snapshot(cfg.noiseMeters);
          this.onFrame(encodeFrame(this.id, this.seq, Date.now(), targets));
        }
      } catch (err) {
        // The target count has no cap, so a huge value can exhaust memory.
        // Pause this generator rather than taking the whole backend down.
        console.error(`generator ${this.id} failed, pausing:`, err.message);
        this.config = { ...cfg, paused: true };
      }
    }

    this._schedule();
  }
}

module.exports = { Generator };
