// Gemini: Chinese -> Myanmar translation, plus optional Gemini text-to-speech.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(key, model, body, tries = 4) {
  if (!key) throw new Error("Gemini API key မထည့်ရသေးပါ (Settings တွင်ထည့်ပါ)");
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      lastErr = new Error(`Gemini ${res.status}: ${json.error?.message || res.statusText}`);
      // Bad key / bad request will not get better by retrying.
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (/Gemini (400|401|403|404)/.test(e.message)) throw e;
    }
    await sleep(2000 * 2 ** i);
  }
  throw lastErr;
}

const STYLE = `You are a professional dubbing translator for Chinese short dramas (AI drama / 短剧).
Translate each Chinese line into natural, spoken, colloquial Myanmar (Burmese, Unicode) as people really talk in Myanmar movie dubbing.
Rules:
- Keep the meaning, emotion and character names (transliterate names into Burmese script).
- Each line will be voiced by TTS and MUST fit inside its "sec" seconds. Burmese speech is about 5 syllables per second, so keep lines short; shorten or paraphrase when needed.
- Use polite/casual particles that fit the speaker's relation (ရှင်/ဗျ/ကွ/နော် etc.).
- No explanations, no romanisation, no Chinese characters in the output.`;

function parseJson(resp) {
  const text = resp.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(clean);
}

export async function translateSegments({ key, model, segments, onProgress = () => {} }) {
  const BATCH = 50;
  const result = new Map();
  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    const items = batch.map((s) => ({ id: s.id, sec: +(s.end - s.start).toFixed(1), zh: s.zh }));
    const resp = await generate(key, model, {
      systemInstruction: { parts: [{ text: STYLE }] },
      contents: [{ role: "user", parts: [{ text: "Translate these lines. Return a JSON array of {id, my}.\n" + JSON.stringify(items) }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: { type: "OBJECT", properties: { id: { type: "INTEGER" }, my: { type: "STRING" } }, required: ["id", "my"] },
        },
      },
    });
    for (const r of parseJson(resp)) result.set(Number(r.id), String(r.my || "").trim());
    onProgress(Math.min(1, (i + batch.length) / segments.length));
  }
  return result;
}

export async function translateOne({ key, model, segment, context }) {
  const resp = await generate(key, model, {
    systemInstruction: { parts: [{ text: STYLE }] },
    contents: [{
      role: "user",
      parts: [{
        text: `Context (previous/next lines): ${JSON.stringify(context)}\n` +
          `Translate only this line, it must fit ${(segment.end - segment.start).toFixed(1)} seconds. Return JSON {"my": "..."}.\n` +
          segment.zh,
      }],
    }],
    generationConfig: { temperature: 0.6, responseMimeType: "application/json" },
  });
  return String(parseJson(resp).my || "").trim();
}

// Returns raw 24 kHz 16-bit mono PCM.
export async function geminiTts({ key, model, voice, text }) {
  const resp = await generate(key, model, {
    contents: [{ parts: [{ text: `Say this in natural Burmese, like a drama voice actor:\n${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  }, 6);
  const data = resp.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!data) throw new Error("Gemini TTS: အသံ မထွက်လာပါ");
  return Buffer.from(data, "base64");
}
