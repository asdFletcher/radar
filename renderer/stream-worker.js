// Runs off the UI thread. Owns the WebSocket to the Rust backend.
//
// Binary frame layout (little-endian):
//   0..4   u32 generator_id
//   4..8   u32 seq
//   8..16  f64 timestamp_ms
//   16..20 u32 target_count
//   20..   target_count * 32-byte records

// Hosted: the page and the WebSocket come from the same server (wss on https).
// In Electron the page is a file:// URL, so use the local backend instead.
const loc = self.location;
const URL =
  loc.protocol === "http:" || loc.protocol === "https:"
    ? `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`
    : "ws://127.0.0.1:9001/ws";
const HEADER_BYTES = 20;
const RECORD_BYTES = 32;
const STATS_INTERVAL_MS = 500;

let ws = null;
let retryMs = 250;

// Per-generator stats: { lastSeq, dropped, received, windowCount }
const stats = new Map();

function statsFor(id) {
  let s = stats.get(id);
  if (!s) {
    s = { lastSeq: null, dropped: 0, received: 0, windowCount: 0 };
    stats.set(id, s);
  }
  return s;
}

function connect() {
  ws = new WebSocket(URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    retryMs = 250;
    stats.clear();
    self.postMessage({ type: "connection", connected: true });
  };

  ws.onclose = () => {
    self.postMessage({ type: "connection", connected: false });
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        self.postMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed control message
      }
      return;
    }

    const buf = event.data;
    if (buf.byteLength < HEADER_BYTES) return;

    const view = new DataView(buf);
    const generatorId = view.getUint32(0, true);
    const seq = view.getUint32(4, true);
    const count = view.getUint32(16, true);
    if (buf.byteLength < HEADER_BYTES + count * RECORD_BYTES) return;

    const s = statsFor(generatorId);
    if (s.lastSeq !== null && seq > s.lastSeq + 1) {
      s.dropped += seq - s.lastSeq - 1;
    }
    s.lastSeq = seq;
    s.received += 1;
    s.windowCount += 1;

    // Transfer ownership of the buffer to the UI thread (no copy).
    self.postMessage({ type: "frame", buf }, [buf]);
  };
}

// UI -> backend commands
self.onmessage = (event) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event.data));
    // A reset restarts seq numbering on the backend.
    if (event.data.type === "resetGenerator") {
      const s = stats.get(event.data.id);
      if (s) s.lastSeq = null;
    }
  }
};

let lastStatsAt = performance.now();
setInterval(() => {
  const now = performance.now();
  const seconds = (now - lastStatsAt) / 1000;
  lastStatsAt = now;

  const out = {};
  for (const [id, s] of stats) {
    out[id] = {
      hz: s.windowCount / seconds,
      dropped: s.dropped,
      received: s.received,
    };
    s.windowCount = 0;
  }
  self.postMessage({ type: "stats", generators: out });
}, STATS_INTERVAL_MS);

connect();
