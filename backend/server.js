"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
const { Generator } = require("./generator");

const MAX_GENERATORS = 20;
// Hard cap on targets per connection (all of its active generators together),
// enforced here so a hosted instance can't be asked for 90,000 targets.
const MAX_TOTAL_TARGETS = 3000;
// Each connection runs its own simulation, so bound how many can be live.
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 25;
// If a client has this many unsent bytes queued, skip frames for it. This keeps
// memory bounded and the live view current instead of replaying old data.
const MAX_BUFFERED_BYTES = 256 * 1024;

// Secrets live in .env (git-ignored) locally and in Railway variables when hosted.
try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {
  // no .env file: use the real environment
}

// --- Map tiles: proxied from MapTiler so the API key never reaches the browser --
// The key is restricted to our site's origin in the MapTiler dashboard, so the
// proxy presents that origin.
const MAPTILER_KEY = process.env.MAPTILER_KEY || "";
const TILE_ORIGIN =
  process.env.TILE_ORIGIN || "https://echodyne-demo-production.up.railway.app";
const TILE_UPSTREAM = {
  streets: (z, x, y) => `maps/streets-v2-dark/256/${z}/${x}/${y}.png`,
  satellite: (z, x, y) => `tiles/satellite-v2/${z}/${x}/${y}.jpg`,
  hybrid: (z, x, y) => `maps/hybrid/256/${z}/${x}/${y}.jpg`,
};
// Only serve tiles near the radar (the Space Needle) so a stranger can't spend
// our MapTiler quota on the rest of the planet.
const TILE_AREA = { south: 47.3, north: 47.9, west: -122.7, east: -122.0 };
const TILE_MIN_ZOOM = 8;
const TILE_MAX_ZOOM = 19;
const TILE_CACHE_BYTES = 64 * 1024 * 1024;

const tileCache = new Map(); // key -> { body, type } (oldest first)
const tileInflight = new Map(); // key -> Promise of the same
let tileCacheBytes = 0;

function tileInArea(z, x, y) {
  const n = 2 ** z;
  const lon = (t) => (t / n) * 360 - 180;
  const lat = (t) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return (
    lon(x) < TILE_AREA.east &&
    lon(x + 1) > TILE_AREA.west &&
    lat(y + 1) < TILE_AREA.north &&
    lat(y) > TILE_AREA.south
  );
}

async function fetchTile(layer, z, x, y) {
  const key = `${layer}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key); // refresh: most recently used goes last
    tileCache.set(key, hit);
    return hit;
  }
  if (tileInflight.has(key)) return tileInflight.get(key);

  const job = (async () => {
    const url = `https://api.maptiler.com/${TILE_UPSTREAM[layer](z, x, y)}?key=${MAPTILER_KEY}`;
    const r = await fetch(url, {
      headers: { referer: `${TILE_ORIGIN}/`, origin: TILE_ORIGIN },
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const tile = {
      body: Buffer.from(await r.arrayBuffer()),
      type: r.headers.get("content-type") || "image/png",
    };
    tileCache.set(key, tile);
    tileCacheBytes += tile.body.length;
    for (const [k, v] of tileCache) {
      if (tileCacheBytes <= TILE_CACHE_BYTES) break;
      tileCache.delete(k);
      tileCacheBytes -= v.body.length;
    }
    return tile;
  })().finally(() => tileInflight.delete(key));
  tileInflight.set(key, job);
  return job;
}

async function serveTile(m, res) {
  const [layer, z, x, y] = [m[1], Number(m[2]), Number(m[3]), Number(m[4])];
  const fail = (code, text) => {
    res.writeHead(code, { "content-type": "text/plain" });
    res.end(text);
  };
  if (!MAPTILER_KEY) return fail(503, "map tiles not configured");
  if (
    z < TILE_MIN_ZOOM ||
    z > TILE_MAX_ZOOM ||
    x >= 2 ** z ||
    y >= 2 ** z ||
    !tileInArea(z, x, y)
  ) {
    return fail(404, "no tile");
  }
  try {
    const tile = await fetchTile(layer, z, x, y);
    res.writeHead(200, {
      "content-type": tile.type,
      "cache-control": "public, max-age=86400",
    });
    res.end(tile.body);
  } catch (err) {
    console.warn("tile error:", err.message);
    fail(502, "tile unavailable");
  }
}

// `--generators N` sets the initial count for each new connection (default 2).
const argIdx = process.argv.indexOf("--generators");
const initialCount = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 2;

// Local by default. For hosting, set BIND=0.0.0.0 (the Dockerfile does) and PORT.
const HOST = process.env.BIND || "127.0.0.1";
const PORT = Number(process.env.PORT) || 9001;

// --- Static files: the UI, so one process serves the whole web app -----------
const ROOT = path.join(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  const tile = pathname.match(
    /^\/tiles\/(streets|satellite|hybrid)\/(\d+)\/(\d+)\/(\d+)$/,
  );
  if (tile) return serveTile(tile, res);

  // Only index.html and renderer/*.js are public. Nothing else in the repo.
  let file = null;
  if (pathname === "/" || pathname === "/index.html") {
    file = path.join(ROOT, "index.html");
  } else if (/^\/renderer\/[\w.-]+\.js$/.test(pathname)) {
    file = path.join(ROOT, pathname);
  }
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)],
      "cache-control": "no-cache",
    });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

// --- One Session per connection: its own generators, config and targets -------
class Session {
  constructor(ws) {
    this.ws = ws;
    this.active = 0;
    // Slot i has id i + 1. Created up front so each keeps its settings when
    // switched off and on again.
    this.generators = Array.from(
      { length: MAX_GENERATORS },
      (_, i) => new Generator(i + 1, (frame) => this.sendFrame(frame)),
    );
  }

  sendFrame(frame) {
    const { ws } = this;
    if (
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < MAX_BUFFERED_BYTES
    ) {
      ws.send(frame, { binary: true });
    }
  }

  stateJson() {
    return JSON.stringify({
      type: "state",
      activeGenerators: this.active,
      maxTotalTargets: MAX_TOTAL_TARGETS,
      generators: this.generators
        .slice(0, this.active)
        .map((g) => ({ id: g.id, ...g.config })),
    });
  }

  publishState() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(this.stateJson());
  }

  // Keep the active generators' targets within MAX_TOTAL_TARGETS. The one the
  // user just changed gives up targets first, then the last ones.
  enforceLimit(preferred) {
    const active = this.generators.slice(0, this.active);
    let total = active.reduce((n, g) => n + g.config.targetCount, 0);
    const order = preferred
      ? [preferred, ...active.filter((g) => g !== preferred).reverse()]
      : [...active].reverse();
    for (const g of order) {
      const excess = total - MAX_TOTAL_TARGETS;
      if (excess <= 0) break;
      const cut = Math.min(excess, g.config.targetCount - 1);
      if (cut > 0) {
        g.update({ targetCount: g.config.targetCount - cut });
        total -= cut;
      }
    }
  }

  setActive(count) {
    this.active = Math.min(MAX_GENERATORS, Math.max(1, Math.round(count) || 1));
    this.generators.forEach((g, i) => (i < this.active ? g.start() : g.stop()));
    this.enforceLimit(null);
    this.publishState();
  }

  handleCommand(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const gen = Number.isInteger(msg.id)
      ? this.generators[msg.id - 1]
      : undefined;

    switch (msg.type) {
      case "setGenerators":
        return this.setActive(Number(msg.count));
      case "updateGenerator":
        if (!gen) return;
        gen.update(msg.config);
        this.enforceLimit(gen);
        return this.publishState();
      case "resetGenerator":
        if (gen) gen.reset();
        return;
    }
  }

  close() {
    this.generators.forEach((g) => g.stop());
  }
}

wss.on("connection", (ws) => {
  if (wss.clients.size > MAX_CLIENTS) {
    return ws.close(1013, "server busy"); // "try again later"
  }
  const session = new Session(ws);
  ws.on("message", (data, isBinary) => {
    if (!isBinary) session.handleCommand(data.toString());
  });
  // The simulation exists only while someone is watching it.
  ws.on("close", () => session.close());
  ws.on("error", (err) => console.warn("client error:", err.message));
  session.setActive(Number.isFinite(initialCount) ? initialCount : 2);
});

server.listen(PORT, HOST, () => {
  console.log(`mock radar listening on http://${HOST}:${PORT} (ws path /ws)`);
});

function shutdown() {
  wss.clients.forEach((ws) => ws.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
