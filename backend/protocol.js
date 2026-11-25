"use strict";

const HEADER_BYTES = 20;
const RECORD_BYTES = 32;

/**
 * Frame layout (little-endian):
 *   0..4   u32 generator_id
 *   4..8   u32 seq
 *   8..16  f64 timestamp_ms
 *   16..20 u32 target_count
 *   20..   target_count * 32-byte records
 *
 * Record: track_id u32, x f32, y f32, z f32, vx f32, vy f32, vz f32,
 *         class_id u8 (tag index; 255 = not yet identified), strength u8 (signal strength 0-255), flags u16
 */
function encodeFrame(generatorId, seq, timestampMs, targets) {
  const buf = Buffer.alloc(HEADER_BYTES + targets.length * RECORD_BYTES);
  buf.writeUInt32LE(generatorId, 0);
  buf.writeUInt32LE(seq, 4);
  buf.writeDoubleLE(timestampMs, 8);
  buf.writeUInt32LE(targets.length, 16);

  let o = HEADER_BYTES;
  for (const t of targets) {
    buf.writeUInt32LE(t.trackId, o);
    buf.writeFloatLE(t.x, o + 4);
    buf.writeFloatLE(t.y, o + 8);
    buf.writeFloatLE(t.z, o + 12);
    buf.writeFloatLE(t.vx, o + 16);
    buf.writeFloatLE(t.vy, o + 20);
    buf.writeFloatLE(t.vz, o + 24);
    buf.writeUInt8(t.classId, o + 28);
    buf.writeUInt8(t.strength, o + 29);
    buf.writeUInt16LE(t.flags, o + 30);
    o += RECORD_BYTES;
  }
  return buf;
}

const PATTERNS = ["mixed", "orbit", "patrol", "randomWalk"];

const DEFAULT_CONFIG = Object.freeze({
  paused: false,
  targetCount: 8,
  rateHz: 10,
  motionPattern: "mixed",
  speedMultiplier: 1,
  noiseMeters: 0,
  dropRatePct: 0,
});

const RANGES = {
  targetCount: [1, Infinity], // no upper cap; practical limit is memory/CPU
  rateHz: [1, 60],
  speedMultiplier: [0.2, 3],
  noiseMeters: [0, 20],
  dropRatePct: [0, 50],
};

/** Merge untrusted `input` onto `base`, keeping only valid, in-range values. */
function sanitizeConfig(input, base = DEFAULT_CONFIG) {
  const out = { ...base };
  if (!input || typeof input !== "object") return out;

  if (typeof input.paused === "boolean") out.paused = input.paused;
  if (PATTERNS.includes(input.motionPattern)) {
    out.motionPattern = input.motionPattern;
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = input[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = Math.min(max, Math.max(min, v));
    }
  }
  out.targetCount = Math.round(out.targetCount);
  out.rateHz = Math.round(out.rateHz);
  return out;
}

module.exports = {
  HEADER_BYTES,
  RECORD_BYTES,
  DEFAULT_CONFIG,
  encodeFrame,
  sanitizeConfig,
};
