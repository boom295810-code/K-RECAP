// K RECAP server: serves the editor page and the dubbing API on http://localhost:5002
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR, DEFAULT_SETTINGS, STEPS, computeFit, createProject, deleteProject, isRunning,
  listProjects, loadProject, runPipeline, saveProject, voiceSegment,
} from "./lib/pipeline.js";
import { translateOne } from "./lib/gemini.js";
import { EDGE_VOICES, GEMINI_VOICES } from "./lib/tts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5002;
const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), "k-recap-uploads"), limits: { fileSize: 4 * 1024 ** 3 } });

// Optional password for hosted use (Render etc.): the browser shows its own login box.
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64 = ""] = (req.get("authorization") || "").split(" ");
    const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    if (pass === process.env.APP_PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="K RECAP"').status(401).send("Password required");
  });
}
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "..", "client")));
app.use("/files", express.static(path.join(DATA_DIR, "projects"), { dotfiles: "deny" }));

// API keys live in each user's browser and are sent with every request.
const keysOf = (req) => ({
  assembly: req.get("x-assembly-key") || process.env.ASSEMBLYAI_API_KEY || "",
  gemini: req.get("x-gemini-key") || process.env.GEMINI_API_KEY || "",
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(400).json({ error: String(e.message || e) });
});

const assertIdle = (id) => { if (isRunning(id)) throw new Error("အလုပ်လုပ်နေဆဲ ဖြစ်သည်၊ ခဏစောင့်ပါ"); };

app.get("/api/meta", (req, res) => res.json({ steps: STEPS, defaults: DEFAULT_SETTINGS, edgeVoices: EDGE_VOICES, geminiVoices: GEMINI_VOICES }));

app.get("/api/projects", wrap(async (req, res) => res.json(await listProjects())));

app.post("/api/projects", upload.single("video"), wrap(async (req, res) => {
  if (!req.file) throw new Error("ဗီဒီယိုဖိုင် ရွေးပါ");
  const settings = req.body.settings ? JSON.parse(req.body.settings) : {};
  const p = await createProject({
    name: req.file.originalname,
    tmpFile: req.file.path,
    ext: path.extname(req.file.originalname).toLowerCase() || ".mp4",
    settings,
  });
  if (req.body.auto !== "false") runPipeline(p.id, "extract", keysOf(req));
  res.json(p);
}));

app.get("/api/projects/:id", wrap(async (req, res) => {
  const p = await loadProject(req.params.id);
  res.json({ ...p, running: isRunning(p.id) });
}));

// Save edits from the editor. Segments whose text, voice or timing changed are marked dirty.
app.put("/api/projects/:id", wrap(async (req, res) => {
  assertIdle(req.params.id);
  const p = await loadProject(req.params.id);
  if (req.body.settings) {
    const before = JSON.stringify([p.settings.voice, p.settings.speakerVoices, p.settings.rate]);
    p.settings = { ...p.settings, ...req.body.settings };
    if (before !== JSON.stringify([p.settings.voice, p.settings.speakerVoices, p.settings.rate])) {
      p.segments.forEach((s) => { s.dirty = true; });
    }
  }
  if (Array.isArray(req.body.segments)) {
    const old = new Map(p.segments.map((s) => [s.id, s]));
    let nextId = Math.max(0, ...p.segments.map((s) => s.id), ...req.body.segments.map((s) => s.id || 0)) + 1;
    p.segments = req.body.segments.map((s) => {
      const prev = old.get(s.id);
      const seg = {
        ...(prev || { tts: null, ttsDur: 0 }),
        id: prev ? s.id : (s.id && !old.has(s.id) ? s.id : nextId++),
        start: Math.max(0, Number(s.start) || 0),
        end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 0.2),
        speaker: s.speaker || "A",
        zh: String(s.zh ?? ""),
        my: String(s.my ?? ""),
        voice: s.voice || "",
      };
      if (!prev || prev.my !== seg.my || (prev.voice || "") !== seg.voice) seg.dirty = true;
      return seg;
    }).sort((a, b) => a.start - b.start);
  }
  computeFit(p);
  res.json(await saveProject(p));
}));

app.post("/api/projects/:id/run", wrap(async (req, res) => {
  const { from = "extract", revoiceAll = false } = req.body || {};
  if (!STEPS.includes(from)) throw new Error("bad step");
  assertIdle(req.params.id);
  if (revoiceAll) {
    const p = await loadProject(req.params.id);
    p.segments.forEach((s) => { s.dirty = true; });
    await saveProject(p);
  }
  runPipeline(req.params.id, from, keysOf(req));
  res.json({ ok: true });
}));

app.post("/api/projects/:id/segments/:sid/translate", wrap(async (req, res) => {
  assertIdle(req.params.id);
  const p = await loadProject(req.params.id);
  const idx = p.segments.findIndex((s) => s.id === Number(req.params.sid));
  if (idx < 0) throw new Error("segment not found");
  const seg = p.segments[idx];
  const context = p.segments.slice(Math.max(0, idx - 3), idx + 3).filter((s) => s !== seg).map((s) => ({ zh: s.zh, my: s.my }));
  seg.my = await translateOne({ key: keysOf(req).gemini, model: p.settings.geminiModel, segment: seg, context });
  seg.dirty = true;
  res.json(await saveProject(p));
}));

app.post("/api/projects/:id/segments/:sid/tts", wrap(async (req, res) => {
  assertIdle(req.params.id);
  const p = await loadProject(req.params.id);
  const seg = p.segments.find((s) => s.id === Number(req.params.sid));
  if (!seg) throw new Error("segment not found");
  await voiceSegment(p, seg, keysOf(req));
  computeFit(p);
  res.json(await saveProject(p));
}));

app.get("/api/projects/:id/srt", wrap(async (req, res) => {
  const p = await loadProject(req.params.id);
  const file = req.query.lang === "zh" ? "original.srt" : "subs.srt";
  const text = await fs.readFile(path.join(DATA_DIR, "projects", p.id, file), "utf8");
  res.attachment(p.name.replace(/\.[^.]+$/, "") + (req.query.lang === "zh" ? "_zh.srt" : "_my.srt")).type("text/plain").send(text);
}));

app.delete("/api/projects/:id", wrap(async (req, res) => {
  await deleteProject(req.params.id);
  res.json({ ok: true });
}));

app.listen(PORT, () => {
  console.log(`\n  K RECAP is running:  http://localhost:${PORT}\n  Data folder: ${DATA_DIR}\n`);
});
