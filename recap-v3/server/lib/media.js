// ffmpeg / ffprobe helpers. Uses the bundled binaries so nothing extra has to be installed.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic?.path || "ffprobe";

// Sample format used for every dubbed clip and the final dub track.
export const SAMPLE_RATE = 48000;
const BYTES_PER_SAMPLE = 2;

function run(bin, args, { cwd, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-10000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${bin.split(/[\\/]/).pop()} failed (${code}): ${err.slice(-1500)}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString("utf8"));
    });
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);

export async function probe(file) {
  const json = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const info = JSON.parse(json);
  return {
    duration: parseFloat(info.format?.duration) || 0,
    hasAudio: info.streams.some((s) => s.codec_type === "audio"),
    hasVideo: info.streams.some((s) => s.codec_type === "video"),
  };
}

// Small mono mp3 for upload to AssemblyAI.
export function extractSpeechAudio(input, out) {
  return ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", out]);
}

// Normalises any TTS output to 48k mono wav, with leading/trailing silence trimmed
// so the clip can be fitted tightly to the original line. Returns duration in seconds.
export async function normaliseClip(input, outWav) {
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB";
  await ffmpeg(["-i", input, "-af", `${trim},areverse,${trim},areverse`, "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", outWav]);
  const st = await fs.stat(outWav);
  return Math.max(0, (st.size - 44) / (SAMPLE_RATE * BYTES_PER_SAMPLE));
}

// atempo only accepts limited factors on older ffmpeg builds, so chain it.
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push("atempo=2"); s /= 2; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

// Decodes a clip to raw PCM samples, optionally time-stretched (pitch preserved).
export async function clipSamples(wav, speed = 1) {
  const args = ["-i", wav];
  if (Math.abs(speed - 1) > 0.01) args.push("-af", atempoChain(speed));
  args.push("-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1");
  const buf = await ffmpeg(args, { binary: true });
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

export function wavFromSamples(samples) {
  const dataLen = samples.length * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataLen, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(dataLen, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, dataLen)]);
}

// Raw 24 kHz s16le PCM (Gemini TTS output) -> wav buffer.
export function wavFromPcm24k(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Final mux: original video + (original audio at origVolume) + dub track.
// Runs inside the project folder so the subtitles filter gets a plain relative path
// (Windows drive letters break ffmpeg filter syntax).
export async function muxOutput({ cwd, input, dub, out, origVolume, hasAudio, burnSubs, srt, fontSize }) {
  const args = ["-i", input, "-i", dub];
  const filters = [];
  if (hasAudio && origVolume > 0) {
    filters.push(`[0:a]volume=${origVolume}[a0]`, `[a0][1:a]amix=inputs=2:duration=first:normalize=0[aout]`);
  } else {
    filters.push(`[1:a]anull[aout]`);
  }
  if (burnSubs) {
    const style = `FontName=Myanmar Text,FontSize=${fontSize || 18},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=30`;
    filters.push(`[0:v]subtitles=${srt}:charenc=UTF-8:force_style='${style}'[vout]`);
  }
  args.push("-filter_complex", filters.join(";"));
  args.push("-map", burnSubs ? "[vout]" : "0:v:0", "-map", "[aout]");
  if (burnSubs) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20");
  else args.push("-c:v", "copy");
  args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out);
  await ffmpeg(args, { cwd });
}
