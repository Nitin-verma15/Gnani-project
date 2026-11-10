// Small helpers for the 16-bit mono PCM WAV files the browser records (see public/audio.js).
// Quiet laptop microphones can record speech so softly that speech-to-text hears silence,
// so recordings are brought up to a normal level before they are sent on.

const HEADER = 44;
const TARGET_PEAK = 0.9;
const MAX_GAIN = 40;
const NOISE_FLOOR = 0.0015; // below this it really is silence; boosting would only amplify hiss

/** Returns the PCM16 samples of a canonical 44-byte-header mono WAV, or null for anything else. */
function pcm16(buffer) {
  if (buffer.length < HEADER + 2) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  if (buffer.toString("ascii", 12, 16) !== "fmt " || buffer.toString("ascii", 36, 40) !== "data") return null;
  const format = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const bits = buffer.readUInt16LE(34);
  if (format !== 1 || channels !== 1 || bits !== 16) return null;
  const length = Math.min(buffer.readUInt32LE(40), buffer.length - HEADER) & ~1;
  return { start: HEADER, count: length / 2 };
}

/** Peak and RMS level of the recording, from 0 to 1. */
export function wavLevels(buffer) {
  const pcm = pcm16(buffer);
  if (!pcm) return null;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < pcm.count; i++) {
    const s = buffer.readInt16LE(pcm.start + i * 2) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sum += s * s;
  }
  return { peak, rms: pcm.count ? Math.sqrt(sum / pcm.count) : 0, seconds: pcm.count / buffer.readUInt32LE(24) };
}

/** A copy of the WAV raised so its loudest point is near full scale. Returns { buffer, gain }. */
export function normalizeWav(buffer) {
  const pcm = pcm16(buffer);
  const levels = pcm && wavLevels(buffer);
  if (!pcm || !levels || levels.peak < NOISE_FLOOR || levels.peak >= TARGET_PEAK / 1.5) return { buffer, gain: 1 };
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / levels.peak);
  const out = Buffer.from(buffer);
  for (let i = 0; i < pcm.count; i++) {
    const offset = pcm.start + i * 2;
    const v = Math.round(buffer.readInt16LE(offset) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), offset);
  }
  return { buffer: out, gain };
}
