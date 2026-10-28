// AssemblyAI speech-to-text with sentence timestamps.
import fs from "node:fs";
import fsp from "node:fs/promises";

const BASE = "https://api.assemblyai.com/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(key, path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { authorization: key, ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!res.ok) throw new Error(`AssemblyAI ${res.status}: ${body.error || text}`);
  return body;
}

async function createTranscript(key, audioUrl, language, speakers) {
  const req = { audio_url: audioUrl, punctuate: true, format_text: true };
  if (language === "auto") req.language_detection = true;
  else req.language_code = language;
  if (speakers) req.speaker_labels = true;
  return api(key, "/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

// Long sentences (Chinese often comes back with little punctuation) are split on
// word gaps so each dubbed line stays short enough to sync.
function splitSentence(s, isCjk) {
  const words = s.words || [];
  if ((s.end - s.start) <= 7000 || words.length < 2) return [s];
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      speaker: s.speaker,
      text: cur.map((w) => w.text).join(isCjk ? "" : " "),
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const len = w.end - cur[0].start;
    const gap = i + 1 < words.length ? words[i + 1].start - w.end : 0;
    const punct = /[，。！？、,.!?；;]$/.test(w.text);
    if ((len > 3500 && (gap > 250 || punct)) || len > 6500) flush();
  }
  flush();
  return out;
}

export async function transcribe({ key, audioFile, language = "zh", speakers = true, onStatus = () => {} }) {
  if (!key) throw new Error("AssemblyAI API key မထည့်ရသေးပါ (Settings တွင်ထည့်ပါ)");
  onStatus("အသံဖိုင် upload တင်နေသည်...");
  const size = (await fsp.stat(audioFile)).size;
  const up = await api(key, "/upload", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    body: fs.createReadStream(audioFile),
    duplex: "half",
  });

  let job;
  try {
    job = await createTranscript(key, up.upload_url, language, speakers);
  } catch (e) {
    // Speaker labels are not offered for every language; fall back without them.
    if (!speakers) throw e;
    job = await createTranscript(key, up.upload_url, language, false);
  }

  onStatus("စာသားထုတ်နေသည် (AssemblyAI)...");
  let t;
  for (;;) {
    await sleep(3000);
    t = await api(key, `/transcript/${job.id}`);
    if (t.status === "completed") break;
    if (t.status === "error") throw new Error(`AssemblyAI: ${t.error}`);
  }

  const { sentences } = await api(key, `/transcript/${job.id}/sentences`);
  const isCjk = /^(zh|ja|ko)/.test(t.language_code || language);
  return sentences
    .flatMap((s) => splitSentence(s, isCjk))
    .filter((s) => s.text && s.text.trim())
    .map((s) => ({
      start: s.start / 1000,
      end: s.end / 1000,
      speaker: s.speaker || "A",
      zh: s.text.trim(),
    }));
}
