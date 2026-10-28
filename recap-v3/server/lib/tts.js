// Text-to-speech engines. Each returns the path of a normalised 48k mono wav + its duration.
import fs from "node:fs/promises";
import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { normaliseClip, wavFromPcm24k } from "./media.js";
import { geminiTts } from "./gemini.js";

export const EDGE_VOICES = [
  { id: "my-MM-NilarNeural", label: "Nilar (မိန်းကလေး)" },
  { id: "my-MM-ThihaNeural", label: "Thiha (ယောကျ်ားလေး)" },
];

export const GEMINI_VOICES = ["Kore", "Puck", "Charon", "Zephyr", "Fenrir", "Aoede", "Leda", "Orus", "Callirrhoe", "Enceladus"];

async function edgeTts(voice, text, rate, dir) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioFilePath } = await tts.toFile(dir, text, { rate: `${rate >= 0 ? "+" : ""}${rate}%` });
    return audioFilePath;
  } finally {
    tts.close();
  }
}

// voice is "edge:<name>" or "gemini:<name>".
export async function synthesize({ voice, text, rate = 0, outWav, geminiKey, geminiTtsModel }) {
  const tmpDir = outWav + ".tmp";
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const [engine, name] = voice.split(":");
    let raw;
    if (engine === "gemini") {
      const pcm = await geminiTts({ key: geminiKey, model: geminiTtsModel, voice: name, text });
      raw = path.join(tmpDir, "gemini.wav");
      await fs.writeFile(raw, wavFromPcm24k(pcm));
    } else {
      let lastErr;
      for (let i = 0; i < 3 && !raw; i++) {
        try { raw = await edgeTts(name, text, rate, tmpDir); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
      }
      if (!raw) throw new Error(`Edge TTS: ${lastErr?.message || lastErr}`);
    }
    return await normaliseClip(raw, outWav);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
