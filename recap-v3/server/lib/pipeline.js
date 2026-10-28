// Project storage and the automatic pipeline:
// extract audio -> transcribe (AssemblyAI) -> translate (Gemini) -> voice (TTS) -> sync + render.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcribe } from "./assembly.js";
import { translateSegments } from "./gemini.js";
import { synthesize } from "./tts.js";
import { SAMPLE_RATE, clipSamples, extractSpeechAudio, muxOutput, probe, wavFromSamples } from "./media.js";

export const DATA_DIR = path.resolve(process.env.KRECAP_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data"));
export const STEPS = ["extract", "transcribe", "translate", "tts", "render"];

export const DEFAULT_SETTINGS = {
  language: "zh",
  speakers: true,
  geminiModel: "gemini-2.5-flash",
  geminiTtsModel: "gemini-2.5-flash-preview-tts",
  voice: "edge:my-MM-ThihaNeural",
  speakerVoices: {},
  rate: 0,
  maxSpeed: 1.6,
  origVolume: 0.15,
  burnSubs: false,
  fontSize: 18,
};

const projDir = (id) => path.join(DATA_DIR, "projects", id);
const projFile = (id) => path.join(projDir(id), "project.json");
const running = new Map();

export async function loadProject(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad id");
  return JSON.parse(await fs.readFile(projFile(id), "utf8"));
}

// Saves are queued per project so parallel workers never interleave writes.
const saveQueue = new Map();
export function saveProject(p) {
  p.updatedAt = Date.now();
  const write = async () => {
    const tmp = projFile(p.id) + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(p, null, 1));
    await fs.rename(tmp, projFile(p.id));
    return p;
  };
  const next = (saveQueue.get(p.id) || Promise.resolve()).then(write, write);
  saveQueue.set(p.id, next.catch(() => {}));
  return next;
}

export async function listProjects() {
  const root = path.join(DATA_DIR, "projects");
  await fs.mkdir(root, { recursive: true });
  const out = [];
  for (const id of await fs.readdir(root)) {
    try {
      const p = await loadProject(id);
      out.push({ id: p.id, name: p.name, status: p.status, step: p.step, createdAt: p.createdAt, segments: p.segments.length, hasOutput: !!p.output });
    } catch { /* skip broken folders */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createProject({ name, tmpFile, ext, settings }) {
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  const dir = projDir(id);
  await fs.mkdir(path.join(dir, "tts"), { recursive: true });
  const input = "input" + (ext || ".mp4");
  await fs.rename(tmpFile, path.join(dir, input)).catch(async () => {
    await fs.copyFile(tmpFile, path.join(dir, input));
    await fs.rm(tmpFile, { force: true });
  });
  const p = {
    id, name, input, createdAt: Date.now(),
    status: "idle", step: null, message: "", progress: 0, error: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    duration: 0, hasAudio: true, segments: [], output: null, renderId: 0,
  };
  return saveProject(p);
}

export async function deleteProject(id) {
  if (running.has(id)) throw new Error("အလုပ်လုပ်နေဆဲ ဖြစ်သည်");
  await loadProject(id);
  await fs.rm(projDir(id), { recursive: true, force: true });
}

export const isRunning = (id) => running.has(id);

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

export const voiceFor = (p, seg) => seg.voice || p.settings.speakerVoices?.[seg.speaker] || p.settings.voice;

export async function voiceSegment(p, seg, keys) {
  const file = `tts/seg_${seg.id}.wav`;
  const text = (seg.my || "").trim();
  if (!text) { seg.tts = null; seg.ttsDur = 0; seg.dirty = false; return; }
  seg.ttsDur = await synthesize({
    voice: voiceFor(p, seg), text, rate: p.settings.rate,
    outWav: path.join(projDir(p.id), file),
    geminiKey: keys.gemini, geminiTtsModel: p.settings.geminiTtsModel,
  });
  seg.tts = file;
  seg.ttsVersion = (seg.ttsVersion || 0) + 1;
  seg.dirty = false;
}

// How fast each clip must play to fit before the next line starts.
export function computeFit(p) {
  const segs = [...p.segments].sort((a, b) => a.start - b.start);
  const { maxSpeed } = p.settings;
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    const limit = next ? next.start : Math.max(p.duration, s.end);
    const available = Math.max(0.2, Math.max(s.end - s.start, limit - s.start - 0.05));
    const need = s.ttsDur ? s.ttsDur / available : 0;
    s.speed = Math.min(maxSpeed, Math.max(1, need));
    s.fits = !s.ttsDur || need <= maxSpeed + 0.001;
    s.available = +available.toFixed(2);
  });
}

function toSrtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
}

export function buildSrt(p, field = "my") {
  return [...p.segments]
    .sort((a, b) => a.start - b.start)
    .filter((s) => (s[field] || "").trim())
    .map((s, i) => {
      const end = s.ttsDur ? Math.max(s.end, s.start + s.ttsDur / (s.speed || 1)) : s.end;
      return `${i + 1}\n${toSrtTime(s.start)} --> ${toSrtTime(end)}\n${s[field].trim()}\n`;
    })
    .join("\n");
}

async function render(p, set) {
  const dir = projDir(p.id);
  computeFit(p);
  const total = Math.ceil((Math.max(p.duration, ...p.segments.map((s) => s.end)) + 2) * SAMPLE_RATE);
  const mix = new Float32Array(total);
  const voiced = p.segments.filter((s) => s.tts && (s.my || "").trim());
  let done = 0;
  await pool(voiced, 4, async (s) => {
    const samples = await clipSamples(path.join(dir, s.tts), s.speed);
    const off = Math.round(s.start * SAMPLE_RATE);
    for (let i = 0; i < samples.length && off + i < total; i++) mix[off + i] += samples[i];
    set({ progress: ++done / voiced.length * 0.6 });
  });
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) pcm[i] = Math.max(-32768, Math.min(32767, mix[i]));
  await fs.writeFile(path.join(dir, "dub.wav"), wavFromSamples(pcm));
  await fs.writeFile(path.join(dir, "subs.srt"), buildSrt(p));
  await fs.writeFile(path.join(dir, "original.srt"), buildSrt(p, "zh"));

  set({ message: "ဗီဒီယို ထုတ်နေသည်...", progress: 0.7 });
  const out = `output_${(p.renderId || 0) + 1}.mp4`;
  await muxOutput({
    cwd: dir, input: p.input, dub: "dub.wav", out,
    origVolume: p.settings.origVolume, hasAudio: p.hasAudio,
    burnSubs: p.settings.burnSubs, srt: "subs.srt", fontSize: p.settings.fontSize,
  });
  const old = p.output;
  p.renderId = (p.renderId || 0) + 1;
  p.output = out;
  if (old && old !== out) await fs.rm(path.join(dir, old), { force: true });
}

// Runs the pipeline from `from` to the end in the background.
export function runPipeline(id, from, keys) {
  if (running.has(id)) throw new Error("အလုပ်လုပ်နေဆဲ ဖြစ်သည်");
  const startAt = Math.max(0, STEPS.indexOf(from));
  const job = (async () => {
    let p = await loadProject(id);
    const dir = projDir(id);
    const set = async (patch) => { Object.assign(p, patch); await saveProject(p); };
    try {
      await set({ status: "running", error: null });
      for (const step of STEPS.slice(startAt)) {
        await set({ step, progress: 0 });
        if (step === "extract") {
          await set({ message: "ဗီဒီယိုမှ အသံ ထုတ်နေသည်..." });
          const info = await probe(path.join(dir, p.input));
          p.duration = info.duration;
          p.hasAudio = info.hasAudio;
          if (!info.hasAudio) throw new Error("ဗီဒီယိုထဲတွင် အသံမပါပါ");
          await extractSpeechAudio(path.join(dir, p.input), path.join(dir, "speech.mp3"));
        } else if (step === "transcribe") {
          const lines = await transcribe({
            key: keys.assembly, audioFile: path.join(dir, "speech.mp3"),
            language: p.settings.language, speakers: p.settings.speakers,
            onStatus: (message) => set({ message }),
          });
          if (!lines.length) throw new Error("စကားပြော မတွေ့ပါ");
          p.segments = lines.map((l, i) => ({ id: i + 1, ...l, my: "", tts: null, ttsDur: 0, dirty: true }));
        } else if (step === "translate") {
          await set({ message: "Gemini ဖြင့် မြန်မာဘာသာ ပြန်နေသည်..." });
          const todo = from === "translate" ? p.segments : p.segments.filter((s) => !s.my);
          const map = await translateSegments({
            key: keys.gemini, model: p.settings.geminiModel, segments: todo,
            onProgress: (progress) => set({ progress }),
          });
          for (const s of todo) if (map.has(s.id)) { s.my = map.get(s.id); s.dirty = true; }
        } else if (step === "tts") {
          await set({ message: "မြန်မာ အသံ ထုတ်နေသည်..." });
          const todo = p.segments.filter((s) => (s.dirty || !s.tts) && (s.my || "").trim());
          let done = 0;
          const isGemini = todo.some((s) => voiceFor(p, s).startsWith("gemini:"));
          await pool(todo, isGemini ? 2 : 4, async (s) => {
            await voiceSegment(p, s, keys);
            await set({ progress: ++done / todo.length });
          });
        } else if (step === "render") {
          await set({ message: "မူရင်းဗီဒီယိုနှင့် အသံ ညှိနေသည်..." });
          await render(p, set);
        }
      }
      await set({ status: "done", step: null, message: "ပြီးပါပြီ ✓", progress: 1 });
    } catch (e) {
      console.error(`[${id}]`, e);
      await set({ status: "error", error: String(e.message || e), message: "" });
    } finally {
      running.delete(id);
    }
  })();
  running.set(id, job);
  return job;
}
