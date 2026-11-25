"use strict";

// Live traffic around the radar, from two feeds:
//   - Radixwave (ADS-B aircraft), polled once per second
//   - AISStream.io (ships), one WebSocket
// Both are shared by every connected viewer (never one request per viewer) and
// only run while at least one viewer is connected. Targets go out in the same
// binary frames as the simulated ones, under their own generator ids.

const { WebSocket } = require("ws");
const { encodeFrame } = require("./protocol");

// Frame source ids. The UI treats everything at or above 100 as live data.
const ADSB_GEN = 101;
const AIS_GEN = 102;

// class_id values (same order as CLASS_NAMES in renderer/app.js).
const CLASS_AIRPLANE = 1;
const CLASS_HELICOPTER = 2;
const CLASS_BOAT = 4;

// The radar (Space Needle). Same projection as the map tiles in the UI.
const RADAR_LAT = 47.6205;
const RADAR_LON = -122.3493;
const EARTH_R = 6378137;
const K = Math.cos((RADAR_LAT * Math.PI) / 180);
const mercY = (lat) =>
  EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const ORIGIN_Y = mercY(RADAR_LAT);
function toLocal(lat, lon) {
  return {
    x: ((EARTH_R * (lon - RADAR_LON) * Math.PI) / 180) * K,
    y: (mercY(lat) - ORIGIN_Y) * K,
  };
}

// Keep targets within this many meters of the radar (the scope plus the area
// you can pan to).
const RANGE_M = 8000;
const KT = 0.514444; // knots -> m/s
const FT = 0.3048; // feet -> m

// Radixwave REST API. The key stays on this server (never sent to browsers).
const RADIXWAVE_API = "https://api.radixwave.com";

// Cloudflare in front of the API rejects clients with no user agent.
const UA =
  "echodyne-demo/1.0 (shared 1 request/second while a viewer is connected)";

// Targets seen so far by one feed. Each tick sends them all, moved along their
// velocity since their last report, so they don't flicker between updates.
class Store {
  constructor(gen, maxAgeS, reckonS) {
    this.gen = gen;
    this.maxAgeS = maxAgeS; // forget a target this long after its last report
    this.reckonS = reckonS; // extrapolate its motion for at most this long
    this.items = new Map(); // id -> { x, y, z, vx, vy, vz, cls, t }
    this.seq = 0;
  }

  set(id, item) {
    this.items.set(id, item);
  }

  frame(now) {
    const targets = [];
    for (const [id, e] of this.items) {
      const age = (now - e.t) / 1000;
      if (age > this.maxAgeS) {
        this.items.delete(id);
        continue;
      }
      const dt = Math.min(age, this.reckonS);
      const moving = age <= this.reckonS;
      targets.push({
        trackId: id,
        x: e.x + e.vx * dt,
        y: e.y + e.vy * dt,
        z: Math.max(0, e.z + e.vz * dt),
        vx: moving ? e.vx : 0,
        vy: moving ? e.vy : 0,
        vz: moving ? e.vz : 0,
        classId: e.cls,
        strength: 200,
        flags: 0,
      });
    }
    return encodeFrame(this.gen, this.seq++, now, targets);
  }
}

class LiveFeeds {
  constructor({ broadcast, broadcastJson, aisKey, radixwaveKey }) {
    this.broadcast = broadcast; // (frameBuffer) => void
    this.broadcastJson = broadcastJson; // (object) => void
    this.aisKey = aisKey || "";
    this.radixwaveKey = radixwaveKey || "";
    this.viewers = 0;

    this.adsb = new Store(ADSB_GEN, 15, 15);
    this.ais = new Store(AIS_GEN, 600, 120);
    this.labels = new Map(); // "gen:id" -> display name
    this.newLabels = [];

    this.timer = null;
    this.pollTimer = null;
    this.aisSocket = null;
    this.aisRetry = null;
    this.aisBackoffMs = 2000;
    this.adsbBackoffMs = 0;
    this.running = false;
  }

  setViewers(n) {
    this.viewers = n;
    if (n > 0 && !this.running) this.start();
    else if (n === 0 && this.running) this.stop();
  }

  // All names known so far, for a viewer who has just connected.
  labelsMessage() {
    if (!this.labels.size) return null;
    const items = [];
    for (const [key, label] of this.labels) {
      const [gen, id] = key.split(":").map(Number);
      items.push([gen, id, label]);
    }
    return { type: "labels", items };
  }

  setLabel(gen, id, label) {
    const key = `${gen}:${id}`;
    if (!label || this.labels.get(key) === label) return;
    this.labels.set(key, label);
    this.newLabels.push([gen, id, label]);
  }

  start() {
    this.running = true;
    this.timer = setInterval(() => this.tick(), 1000);
    if (this.radixwaveKey) this.pollAdsb();
    else console.log("live: RADIXWAVE_API_KEY not set, aircraft are off");
    if (this.aisKey) this.connectAis();
    else console.log("live: AISSTREAM_API_KEY not set, ships are off");
    console.log("live: feeds started");
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.aisRetry);
    this.timer = this.pollTimer = this.aisRetry = null;
    if (this.aisSocket) {
      this.aisSocket.removeAllListeners();
      this.aisSocket.on("error", () => {});
      this.aisSocket.close();
      this.aisSocket = null;
    }
    // Nobody is watching: forget everything so a returning viewer starts fresh.
    this.adsb.items.clear();
    this.ais.items.clear();
    console.log("live: feeds stopped (no viewers)");
  }

  tick() {
    const now = Date.now();
    if (this.adsb.items.size) this.broadcast(this.adsb.frame(now));
    if (this.ais.items.size) this.broadcast(this.ais.frame(now));
    if (this.newLabels.length) {
      this.broadcastJson({ type: "labels", items: this.newLabels });
      this.newLabels = [];
    }
  }

  // --- Radixwave: one request per second, never overlapping ----------------
  // The network publishes a new snapshot about once a second, so polling
  // faster would only return the same data. Free-plan note: each request that
  // returns aircraft costs one unit, and the plan has a monthly allowance.
  async pollAdsb() {
    if (!this.running) return;
    const started = Date.now();
    let waitMs = 1000;
    try {
      const dLat = RANGE_M / 111320;
      const dLon = dLat / K;
      const bbox = [
        RADAR_LAT - dLat,
        RADAR_LAT + dLat,
        RADAR_LON - dLon,
        RADAR_LON + dLon,
      ]
        .map((v) => v.toFixed(4))
        .join(","); // south,north,west,east
      const r = await fetch(
        `${RADIXWAVE_API}/v1/aircraft?bbox=${bbox}&limit=250`,
        {
          headers: {
            authorization: `Bearer ${this.radixwaveKey}`,
            "user-agent": UA,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (r.ok) {
        this.adsbBackoffMs = 0;
        this.ingestAdsb(await r.json(), Date.now());
      } else {
        const body = await r.json().catch(() => ({}));
        const code = body.error || `HTTP ${r.status}`;
        if (code === "monthly_quota_exceeded") {
          // Nothing more to get until the next billing period: check hourly.
          waitMs = 60 * 60 * 1000;
          console.warn(
            "live: Radixwave monthly allowance used up, aircraft paused",
          );
        } else if (r.status === 429) {
          const retry = Number(r.headers.get("retry-after"));
          this.adsbBackoffMs = Math.min(
            60000,
            Math.max(retry * 1000 || 0, (this.adsbBackoffMs || 1000) * 2),
          );
          waitMs = this.adsbBackoffMs;
          console.warn(`live: Radixwave rate limit, waiting ${waitMs} ms`);
        } else if (r.status === 401 || r.status === 403) {
          waitMs = 60000; // a configuration problem: don't hammer it
          console.warn(
            `live: Radixwave refused the key (${code}), retrying in 60 s`,
          );
        } else {
          throw new Error(code);
        }
      }
    } catch (err) {
      this.adsbBackoffMs = Math.min(30000, (this.adsbBackoffMs || 1000) * 2);
      waitMs = this.adsbBackoffMs;
      console.warn(`live: Radixwave error: ${err.message}`);
    }
    if (!this.running) return;
    const elapsed = Date.now() - started;
    this.pollTimer = setTimeout(
      () => this.pollAdsb(),
      Math.max(waitMs - elapsed, waitMs === 1000 ? 0 : waitMs),
    );
  }

  ingestAdsb(body, now) {
    for (const a of body?.aircraft ?? []) {
      if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      if (typeof a.hex !== "string" || a.hex.startsWith("~")) continue;
      const cat = a.category || "";
      if (cat.startsWith("C")) continue; // ground vehicles and obstacles
      const seen = Number.isFinite(a.seen_pos) ? a.seen_pos : 0;
      if (seen > 15) continue;
      const p = toLocal(a.lat, a.lon);
      if (Math.hypot(p.x, p.y) > RANGE_M) continue;
      const id = parseInt(a.hex, 16);
      if (!Number.isFinite(id)) continue;

      const gs = Number.isFinite(a.gs) ? a.gs * KT : 0;
      const track = ((Number.isFinite(a.track) ? a.track : 0) * Math.PI) / 180;
      const alt = typeof a.alt_baro === "number" ? a.alt_baro * FT : 0;
      const rate = Number.isFinite(a.baro_rate) ? (a.baro_rate * FT) / 60 : 0;
      this.adsb.set(id, {
        x: p.x,
        y: p.y,
        z: alt,
        vx: gs * Math.sin(track),
        vy: gs * Math.cos(track),
        vz: rate,
        cls: cat.startsWith("A7") ? CLASS_HELICOPTER : CLASS_AIRPLANE,
        t: now - seen * 1000,
      });
      this.setLabel(
        ADSB_GEN,
        id,
        (a.flight || "").trim() || a.hex.toUpperCase(),
      );
    }
  }

  // --- AISStream.io ----------------------------------------------------------
  connectAis() {
    if (!this.running || this.aisSocket) return;
    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    this.aisSocket = ws;

    ws.on("open", () => {
      const dLat = RANGE_M / 111320;
      const dLon = dLat / K;
      ws.send(
        JSON.stringify({
          APIKey: this.aisKey,
          BoundingBoxes: [
            [
              [RADAR_LAT - dLat, RADAR_LON - dLon],
              [RADAR_LAT + dLat, RADAR_LON + dLon],
            ],
          ],
          FilterMessageTypes: [
            "PositionReport",
            "StandardClassBPositionReport",
            "ExtendedClassBPositionReport",
          ],
        }),
      );
    });

    ws.on("message", (data) => {
      this.aisBackoffMs = 2000; // healthy
      try {
        this.ingestAis(JSON.parse(data.toString()), Date.now());
      } catch {
        // ignore a malformed message
      }
    });

    const retry = () => {
      if (this.aisSocket !== ws) return;
      this.aisSocket = null;
      if (!this.running) return;
      const wait = this.aisBackoffMs;
      this.aisBackoffMs = Math.min(60000, this.aisBackoffMs * 2);
      console.warn(`live: AISStream closed, reconnecting in ${wait} ms`);
      this.aisRetry = setTimeout(() => this.connectAis(), wait);
    };
    ws.on("close", retry);
    ws.on("error", (err) => {
      console.warn(`live: AISStream error: ${err.message}`);
      ws.close();
      retry();
    });
  }

  ingestAis(m, now) {
    if (m.error) {
      console.warn(`live: AISStream says: ${m.error}`);
      return;
    }
    const meta = m.MetaData || {};
    const body = m.Message?.[m.MessageType];
    if (!body) return;
    const lat = body.Latitude ?? meta.latitude;
    const lon = body.Longitude ?? meta.longitude;
    const mmsi = Number(meta.MMSI ?? body.UserID);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !mmsi) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const p = toLocal(lat, lon);
    if (Math.hypot(p.x, p.y) > RANGE_M) return;

    // 102.3 knots and 360 degrees mean "not available".
    const sog = Number.isFinite(body.Sog) && body.Sog < 102.3 ? body.Sog : 0;
    let cog = Number.isFinite(body.Cog) && body.Cog < 360 ? body.Cog : null;
    if (cog === null && body.TrueHeading < 360) cog = body.TrueHeading;
    const speed = cog === null ? 0 : sog * KT;
    const rad = ((cog ?? 0) * Math.PI) / 180;
    this.ais.set(mmsi, {
      x: p.x,
      y: p.y,
      z: 0,
      vx: speed * Math.sin(rad),
      vy: speed * Math.cos(rad),
      vz: 0,
      cls: CLASS_BOAT,
      t: now,
    });
    const name = (meta.ShipName || "").trim();
    this.setLabel(AIS_GEN, mmsi, name || String(mmsi));
  }
}

module.exports = { LiveFeeds, ADSB_GEN, AIS_GEN };
