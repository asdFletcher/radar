"use strict";

const { WebSocketServer, WebSocket } = require("ws");
const { Generator } = require("./generator");

const MAX_GENERATORS = 20;
// If a client has this many unsent bytes queued, skip frames for it. This keeps
// memory bounded and the live view current instead of replaying old data.
const MAX_BUFFERED_BYTES = 256 * 1024;

// `--generators N` sets the initial count (default 2).
const argIdx = process.argv.indexOf("--generators");
const initialCount = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 2;

// Local by default. For hosting, set BIND=0.0.0.0 and PORT.
const HOST = process.env.BIND || "127.0.0.1";
const PORT = Number(process.env.PORT) || 9001;

const wss = new WebSocketServer({ host: HOST, port: PORT });

function broadcastFrame(frame) {
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.bufferedAmount < MAX_BUFFERED_BYTES
    ) {
      client.send(frame, { binary: true });
    }
  }
}

// One generator per slot, created up front so each keeps its settings when
// switched off and on again. Slot i has id i + 1.
const generators = Array.from(
  { length: MAX_GENERATORS },
  (_, i) => new Generator(i + 1, broadcastFrame),
);
let active = 0;

function stateJson() {
  return JSON.stringify({
    type: "state",
    activeGenerators: active,
    generators: generators
      .slice(0, active)
      .map((g) => ({ id: g.id, ...g.config })),
  });
}

function publishState() {
  const json = stateJson();
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
}

function setActive(count) {
  active = Math.min(MAX_GENERATORS, Math.max(1, Math.round(count) || 1));
  generators.forEach((g, i) => (i < active ? g.start() : g.stop()));
  publishState();
}

function handleCommand(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return console.warn("bad command (not JSON):", text);
  }
  const gen = Number.isInteger(msg.id) ? generators[msg.id - 1] : undefined;

  switch (msg.type) {
    case "setGenerators":
      return setActive(Number(msg.count));
    case "updateGenerator":
      if (!gen) return;
      gen.update(msg.config);
      return publishState();
    case "resetGenerator":
      if (gen) gen.reset();
      return;
    default:
      console.warn("unknown command:", msg.type);
  }
}

wss.on("connection", (ws) => {
  ws.send(stateJson());
  ws.on("message", (data, isBinary) => {
    if (!isBinary) handleCommand(data.toString());
  });
  ws.on("error", (err) => console.warn("client error:", err.message));
});

wss.on("listening", () => {
  console.log(`mock radar backend listening on ws://${HOST}:${PORT}`);
  setActive(Number.isFinite(initialCount) ? initialCount : 2);
});

function shutdown() {
  generators.forEach((g) => g.stop());
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
