// K RECAP editor (no build step).
const $ = (sel) => document.querySelector(sel);
const LS_KEY = "krecap.settings.v1";
const STEP_LABELS = {
  extract: "1. အသံထုတ်",
  transcribe: "2. စာသားထုတ်",
  translate: "3. မြန်မာပြန်",
  tts: "4. အသံသွင်း",
  render: "5. ညှိ + Video ထုတ်",
};

let meta = null;
let project = null;   // last project from server
let segs = [];        // editable copy of project.segments
let pollTimer = null;
let saveTimer = null;
let savePromise = null;
let videoSrc = "output";
let stopAt = null;

// ---------- settings (stored only in this browser) ----------
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveLocal(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
let local = loadLocal();

function keyHeaders() {
  return { "x-assembly-key": local.assemblyKey || "", "x-gemini-key": local.geminiKey || "" };
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...keyHeaders(), ...(opts.json ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function voiceOptions(selected, withDefault) {
  const opts = [];
  if (withDefault) opts.push(`<option value="">(Default)</option>`);
  opts.push(`<optgroup label="Edge TTS (အခမဲ့ • မြန်မာ)">`);
  for (const v of meta.edgeVoices) opts.push(`<option value="edge:${v.id}">${v.label}</option>`);
  opts.push(`</optgroup><optgroup label="Gemini TTS (Gemini key သုံး)">`);
  for (const v of meta.geminiVoices) opts.push(`<option value="gemini:${v}">Gemini • ${v}</option>`);
  opts.push(`</optgroup>`);
  const html = opts.join("");
  return selected === undefined ? html : html.replace(`value="${selected}"`, `value="${selected}" selected`);
}

function fillSettingsDialog() {
  const d = meta.defaults;
  $("#assemblyKey").value = local.assemblyKey || "";
  $("#geminiKey").value = local.geminiKey || "";
  $("#sLanguage").value = local.language || d.language;
  $("#sGeminiModel").value = local.geminiModel || d.geminiModel;
  $("#sGeminiTtsModel").value = local.geminiTtsModel || d.geminiTtsModel;
  $("#sVoice").innerHTML = voiceOptions(local.voice || d.voice);
  $("#sSpeakers").checked = local.speakers ?? d.speakers;
}

function openSettings() { fillSettingsDialog(); $("#settingsDlg").showModal(); }

$("#saveSettings").addEventListener("click", () => {
  local = {
    ...local,
    assemblyKey: $("#assemblyKey").value.trim(),
    geminiKey: $("#geminiKey").value.trim(),
    language: $("#sLanguage").value,
    geminiModel: $("#sGeminiModel").value.trim() || meta.defaults.geminiModel,
    geminiTtsModel: $("#sGeminiTtsModel").value.trim() || meta.defaults.geminiTtsModel,
    voice: $("#sVoice").value,
    speakers: $("#sSpeakers").checked,
  };
  saveLocal(local);
  updateKeyWarning();
  // Model choices also apply to the open project.
  if (project) queueSave({ geminiModel: local.geminiModel, geminiTtsModel: local.geminiTtsModel });
});
document.querySelectorAll(".eye").forEach((b) => b.addEventListener("click", () => {
  const i = document.getElementById(b.dataset.for);
  i.type = i.type === "password" ? "text" : "password";
}));
$("#openSettings").addEventListener("click", openSettings);
$("#warnOpenSettings").addEventListener("click", (e) => { e.preventDefault(); openSettings(); });

function updateKeyWarning() {
  $("#keyWarning").classList.toggle("hidden", !!(local.assemblyKey && local.geminiKey));
}

// ---------- home ----------
const fmtDate = (t) => new Date(t).toLocaleString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function showHome() {
  stopPolling();
  project = null;
  $("#editor").classList.add("hidden");
  $("#home").classList.remove("hidden");
  $("#video").removeAttribute("src");
  history.replaceState(null, "", location.pathname);
  const list = await api("/api/projects").catch(() => []);
  $("#projectList").innerHTML = list.length ? list.map((p) => `
    <div class="project" data-id="${p.id}">
      <div><div class="name">${esc(p.name)}</div><div class="muted small">${fmtDate(p.createdAt)} • ${p.segments} လိုင်း</div></div>
      <div class="row">
        <span class="badge ${p.status}">${p.status === "done" ? "ပြီးပြီ" : p.status === "error" ? "Error" : p.status === "running" ? STEP_LABELS[p.step] || "လုပ်နေသည်" : "—"}</span>
        <button class="btn sm danger" data-del="${p.id}">🗑</button>
      </div>
    </div>`).join("") : `<div class="muted">Project မရှိသေးပါ</div>`;
}

$("#projectList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirm("ဒီ project ကို ဖျက်မှာ သေချာလား?")) return;
    try { await api(`/api/projects/${del.dataset.del}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
    return showHome();
  }
  const row = e.target.closest(".project");
  if (row) openProject(row.dataset.id);
});

$("#homeLink").addEventListener("click", (e) => { e.preventDefault(); showHome(); });

function uploadFile(file) {
  if (!file) return;
  if (!local.assemblyKey || !local.geminiKey) {
    openSettings();
    return alert("AssemblyAI နှင့် Gemini API key အရင်ထည့်ပါ");
  }
  const fd = new FormData();
  fd.append("video", file);
  fd.append("settings", JSON.stringify({
    language: local.language, speakers: local.speakers, voice: local.voice,
    geminiModel: local.geminiModel, geminiTtsModel: local.geminiTtsModel,
  }));
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/projects");
  for (const [k, v] of Object.entries(keyHeaders())) xhr.setRequestHeader(k, v);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) $("#uploadStatus").textContent = `Upload တင်နေသည်... ${Math.round(e.loaded / e.total * 100)}%`; };
  xhr.onload = () => {
    $("#uploadStatus").textContent = "";
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status !== 200) return alert(data.error || "Upload failed");
    openProject(data.id);
  };
  xhr.onerror = () => { $("#uploadStatus").textContent = ""; alert("Upload failed"); };
  xhr.send(fd);
}

$("#fileInput").addEventListener("change", (e) => { uploadFile(e.target.files[0]); e.target.value = ""; });
const dz = $("#dropZone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); uploadFile(e.dataTransfer.files[0]); });

// ---------- editor ----------
async function openProject(id) {
  $("#home").classList.add("hidden");
  $("#editor").classList.remove("hidden");
  history.replaceState(null, "", `#p=${id}`);
  project = await api(`/api/projects/${id}`);
  segs = structuredClone(project.segments);
  videoSrc = project.output ? "output" : "input";
  renderAll();
  if (project.running || project.status === "running") startPolling();
}

const isBusy = () => !!project && (project.running || project.status === "running");

function renderAll() {
  renderPipeline();
  renderMixer();
  renderSegments();
  setVideo();
}

function renderPipeline() {
  const p = project;
  $("#projName").textContent = p.name;
  const cur = meta.steps.indexOf(p.step);
  $("#steps").innerHTML = meta.steps.map((s, i) => {
    let cls = "";
    if (p.status === "done") cls = "done";
    else if (isBusy() && i < cur) cls = "done";
    else if (isBusy() && i === cur) cls = "active";
    return `<li class="${cls}">${STEP_LABELS[s]}</li>`;
  }).join("");
  const stepProgress = p.status === "done" ? 1 : isBusy() ? (cur + (p.progress || 0)) / meta.steps.length : 0;
  $("#progressBar").style.width = `${Math.round(stepProgress * 100)}%`;
  $("#statusMsg").textContent = isBusy() ? `${p.message || ""} ${p.progress ? Math.round(p.progress * 100) + "%" : ""}` : (p.message || "");
  $("#errorMsg").textContent = p.error ? `❌ ${p.error}` : "";
  $("#errorMsg").classList.toggle("hidden", !p.error);
  const hasOut = !!p.output;
  $("#dlVideo").classList.toggle("disabled", !hasOut || isBusy());
  $("#dlVideo").href = hasOut ? `/files/${p.id}/${p.output}` : "#";
  $("#dlVideo").setAttribute("download", p.name.replace(/\.[^.]+$/, "") + "_myanmar.mp4");
  $("#dlSrt").classList.toggle("disabled", !hasOut);
  $("#dlSrt").href = `/api/projects/${p.id}/srt`;
  $("#dlSrtZh").classList.toggle("disabled", !hasOut);
  $("#dlSrtZh").href = `/api/projects/${p.id}/srt?lang=zh`;
  document.querySelectorAll("#editor button, #editor input, #editor select, #editor textarea").forEach((el) => {
    if (!el.classList.contains("tab")) el.disabled = isBusy();
  });
}

function renderMixer() {
  const s = project.settings;
  $("#origVolume").value = s.origVolume;
  $("#origVolumeVal").textContent = Math.round(s.origVolume * 100) + "%";
  $("#maxSpeed").value = s.maxSpeed;
  $("#maxSpeedVal").textContent = "x" + Number(s.maxSpeed).toFixed(2);
  $("#rate").value = s.rate;
  $("#burnSubs").checked = !!s.burnSubs;
  $("#voice").innerHTML = voiceOptions(s.voice);
  const speakers = [...new Set(segs.map((x) => x.speaker))].sort();
  $("#speakerVoices").innerHTML = speakers.length > 1 ? speakers.map((sp) => `
    <label>ပြောသူ ${esc(sp)} အသံ <select data-speaker="${esc(sp)}">${voiceOptions(s.speakerVoices?.[sp] || "", true)}</select></label>`).join("") : "";
  renderPipeline();
}

$("#origVolume").addEventListener("input", (e) => { $("#origVolumeVal").textContent = Math.round(e.target.value * 100) + "%"; queueSave({ origVolume: Number(e.target.value) }); });
$("#maxSpeed").addEventListener("input", (e) => { $("#maxSpeedVal").textContent = "x" + Number(e.target.value).toFixed(2); queueSave({ maxSpeed: Number(e.target.value) }); });
$("#rate").addEventListener("change", (e) => queueSave({ rate: Number(e.target.value) || 0 }));
$("#burnSubs").addEventListener("change", (e) => queueSave({ burnSubs: e.target.checked }));
$("#voice").addEventListener("change", (e) => queueSave({ voice: e.target.value }));
$("#speakerVoices").addEventListener("change", (e) => {
  const sp = e.target.dataset.speaker;
  if (!sp) return;
  const speakerVoices = { ...(project.settings.speakerVoices || {}) };
  if (e.target.value) speakerVoices[sp] = e.target.value; else delete speakerVoices[sp];
  queueSave({ speakerVoices });
});

const fmtT = (t) => {
  const m = Math.floor(t / 60), s = (t % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
};

function fitInfo(s) {
  if (!(s.my || "").trim()) return { cls: "", text: "စာမရှိ" };
  if (s.dirty || !s.tts) return { cls: "dirty", text: "● ပြင်ထား (အသံ မထုတ်ရသေး)" };
  if (s.fits === false) return { cls: "bad", text: `⚠️ စာရှည်နေ (${s.ttsDur.toFixed(1)}s / ${s.available}s)` };
  return { cls: "ok", text: `✓ ကိုက်ညီ${s.speed > 1.01 ? ` (x${s.speed.toFixed(2)})` : ""}` };
}

function segHtml(s, i) {
  const f = fitInfo(s);
  const speakers = [...new Set(segs.map((x) => x.speaker))].sort();
  return `
  <div class="seg ${f.cls}" data-id="${s.id}">
    <div class="seg-top">
      <span class="num">#${i + 1}</span>
      <span class="time-link" data-act="seek" title="ဗီဒီယို ဒီနေရာသွား">⏱ ${fmtT(s.start)}</span>
      <input class="t" type="number" step="0.05" min="0" data-f="start" value="${s.start.toFixed(2)}" title="စချိန် (s)" />
      →
      <input class="t" type="number" step="0.05" min="0" data-f="end" value="${s.end.toFixed(2)}" title="ဆုံးချိန် (s)" />
      <select data-f="speaker" title="ပြောသူ">${[...new Set([...speakers, s.speaker])].map((sp) => `<option ${sp === s.speaker ? "selected" : ""}>${esc(sp)}</option>`).join("")}</select>
      <select data-f="voice" title="ဒီလိုင်းအတွက် အသံ">${voiceOptions(s.voice || "", true)}</select>
      <span class="fit ${f.cls}">${f.text}</span>
    </div>
    <div class="zh"><textarea data-f="zh" rows="1">${esc(s.zh)}</textarea></div>
    <div class="my"><textarea data-f="my" rows="2" placeholder="မြန်မာစာ...">${esc(s.my)}</textarea></div>
    <div class="seg-actions">
      <button class="btn sm" data-act="orig">▶ မူရင်း</button>
      <button class="btn sm" data-act="play" ${s.tts ? "" : "disabled"}>🔊 မြန်မာအသံ</button>
      <button class="btn sm" data-act="tts">🎙 အသံပြန်ထုတ်</button>
      <button class="btn sm" data-act="translate">🌐 ပြန်ဘာသာပြန်</button>
      <button class="btn sm" data-act="add">➕ အောက်မှာထည့်</button>
      <button class="btn sm danger" data-act="del">🗑</button>
    </div>
  </div>`;
}

function renderSegments() {
  const onlyWarn = $("#onlyWarn").checked;
  const shown = segs.map((s, i) => [s, i]).filter(([s]) => !onlyWarn || fitInfo(s).cls === "bad" || fitInfo(s).cls === "dirty");
  $("#segList").innerHTML = shown.length ? shown.map(([s, i]) => segHtml(s, i)).join("") : `<div class="muted">${isBusy() ? "လုပ်ဆောင်နေသည်..." : "စကားပြော မရှိသေးပါ"}</div>`;
  const bad = segs.filter((s) => fitInfo(s).cls === "bad").length;
  $("#segCount").textContent = `(${segs.length} လိုင်း${bad ? ` • ⚠️ ${bad} မကိုက်` : ""})`;
  renderPipeline();
}
$("#onlyWarn").addEventListener("change", renderSegments);

// Updates only the fit badges so typing is never interrupted by a re-render.
function refreshBadges() {
  for (const el of document.querySelectorAll(".seg")) {
    const s = segs.find((x) => x.id === Number(el.dataset.id));
    if (!s) continue;
    const f = fitInfo(s);
    el.className = `seg ${f.cls}`;
    const b = el.querySelector(".fit");
    b.className = `fit ${f.cls}`;
    b.textContent = f.text;
    el.querySelector('[data-act="play"]').disabled = !s.tts || isBusy();
  }
  const bad = segs.filter((s) => fitInfo(s).cls === "bad").length;
  $("#segCount").textContent = `(${segs.length} လိုင်း${bad ? ` • ⚠️ ${bad} မကိုက်` : ""})`;
}

const segOf = (el) => segs.find((s) => s.id === Number(el.closest(".seg").dataset.id));

$("#segList").addEventListener("input", (e) => {
  const f = e.target.dataset.f;
  if (!f) return;
  const s = segOf(e.target);
  if (f === "start" || f === "end") s[f] = Number(e.target.value) || 0;
  else s[f] = e.target.value;
  if (f === "my" || f === "voice") s.dirty = true;
  refreshBadges();
  queueSave();
});

$("#segList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const s = segOf(btn);
  const act = btn.dataset.act;
  if (act === "seek") return seek(s.start, false);
  if (act === "orig") return playRange("input", s.start, s.end);
  if (act === "play") {
    const a = $("#clipPlayer");
    a.src = `/files/${project.id}/${s.tts}?v=${s.ttsVersion || 0}`;
    return a.play();
  }
  if (act === "del") {
    if (!confirm("ဒီလိုင်းကို ဖျက်မလား?")) return;
    segs = segs.filter((x) => x !== s);
    renderSegments();
    return queueSave();
  }
  if (act === "add") {
    const idx = segs.indexOf(s);
    const next = segs[idx + 1];
    const start = s.end + 0.05;
    const end = next ? Math.max(start + 0.3, next.start - 0.05) : start + 2;
    segs.splice(idx + 1, 0, { id: 0, start, end, speaker: s.speaker, zh: "", my: "", voice: "", dirty: true });
    await flushSave();
    return renderSegments();
  }
  if (act === "tts" || act === "translate") {
    btn.disabled = true;
    btn.textContent = "⏳...";
    try {
      await flushSave();
      project = await api(`/api/projects/${project.id}/segments/${s.id}/${act}`, { method: "POST" });
      segs = structuredClone(project.segments);
      renderSegments();
      if (act === "tts") {
        const ns = segs.find((x) => x.id === s.id);
        if (ns?.tts) { const a = $("#clipPlayer"); a.src = `/files/${project.id}/${ns.tts}?v=${ns.ttsVersion}`; a.play(); }
      }
    } catch (err) {
      alert(err.message);
      renderSegments();
    }
  }
});

// ---------- saving ----------
let pendingSettings = {};
function queueSave(settingsPatch) {
  if (settingsPatch) {
    Object.assign(pendingSettings, settingsPatch);
    Object.assign(project.settings, settingsPatch);
  }
  $("#saveState").textContent = "…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) await savePromise;
  if (!project) return;
  const body = { segments: segs.map(({ id, start, end, speaker, zh, my, voice }) => ({ id, start, end, speaker, zh, my, voice })) };
  if (Object.keys(pendingSettings).length) body.settings = pendingSettings;
  pendingSettings = {};
  savePromise = (async () => {
    try {
      const p = await api(`/api/projects/${project.id}`, { method: "PUT", json: body });
      const structural = p.segments.length !== segs.length || p.segments.some((s, i) => s.id !== segs[i]?.id);
      project = p;
      // Keep the text the user is typing; take timing/fit info from the server.
      const byId = new Map(p.segments.map((s) => [s.id, s]));
      if (structural) segs = structuredClone(p.segments);
      else segs.forEach((s) => Object.assign(s, { ...byId.get(s.id), zh: s.zh, my: s.my, start: s.start, end: s.end }));
      $("#saveState").textContent = "✓ သိမ်းပြီး";
      if (structural) renderSegments(); else refreshBadges();
    } catch (err) {
      $("#saveState").textContent = "❌ " + err.message;
    } finally {
      savePromise = null;
    }
  })();
  return savePromise;
}

async function run(from, extra = {}) {
  if (!local.assemblyKey && from === "transcribe") return openSettings();
  if (!local.geminiKey && (from === "translate")) return openSettings();
  try {
    await flushSave();
    await api(`/api/projects/${project.id}/run`, { method: "POST", json: { from, ...extra } });
    project.running = true;
    project.status = "running";
    project.error = null;
    renderPipeline();
    startPolling();
  } catch (err) {
    alert(err.message);
  }
}

$("#renderBtn").addEventListener("click", () => run("tts"));
$("#revoiceAllBtn").addEventListener("click", () => confirm("အသံ အားလုံး ပြန်ထုတ်မလား?") && run("tts", { revoiceAll: true }));
$("#retranslateBtn").addEventListener("click", () => confirm("မြန်မာစာ အားလုံး ပြန်ဘာသာပြန်မလား? (ပြင်ထားတာတွေ ပျောက်မယ်)") && run("translate"));
$("#retranscribeBtn").addEventListener("click", () => confirm("စာသား အားလုံး ပြန်ထုတ်မလား? (ပြင်ထားတာ အားလုံး ပျောက်မယ်)") && run("transcribe"));

// ---------- polling ----------
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!project) return stopPolling();
    try {
      const p = await api(`/api/projects/${project.id}`);
      const finished = !p.running && p.status !== "running";
      const countChanged = p.segments.length !== segs.length;
      project = p;
      if (finished) {
        stopPolling();
        segs = structuredClone(p.segments);
        if (p.output) videoSrc = "output";
        renderAll();
      } else {
        if (countChanged || p.step === "translate" || p.step === "tts") { segs = structuredClone(p.segments); renderSegments(); }
        renderPipeline();
      }
    } catch { /* keep trying */ }
  }, 1500);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ---------- video ----------
const video = $("#video");

function srcFor(kind) {
  if (kind === "output" && project.output) return `/files/${project.id}/${project.output}`;
  return `/files/${project.id}/${project.input}`;
}

function setVideo(keepTime) {
  const t = keepTime ? video.currentTime : 0;
  const src = srcFor(videoSrc);
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.src === (project.output ? videoSrc : "input")));
  if (!video.src.endsWith(src)) {
    video.src = src;
    if (t) video.addEventListener("loadedmetadata", () => { video.currentTime = t; }, { once: true });
  }
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.src === "output" && !project.output) return;
  videoSrc = b.dataset.src;
  setVideo(true);
}));

function seek(t, play) {
  const go = () => { video.currentTime = t; if (play) video.play(); };
  if (video.readyState >= 1) go(); else video.addEventListener("loadedmetadata", go, { once: true });
}

function playRange(kind, start, end) {
  if (videoSrc !== kind) { videoSrc = kind; setVideo(); }
  stopAt = end;
  seek(start, true);
}

video.addEventListener("timeupdate", () => {
  const t = video.currentTime;
  if (stopAt !== null && t >= stopAt) { video.pause(); stopAt = null; }
  const cur = segs.find((s) => t >= s.start && t <= s.end + 0.2);
  document.querySelectorAll(".seg.active").forEach((el) => el.classList.remove("active"));
  const overlay = $("#subOverlay");
  if (cur) {
    const el = document.querySelector(`.seg[data-id="${cur.id}"]`);
    if (el) {
      el.classList.add("active");
      if (!video.paused && !el.contains(document.activeElement)) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  // Translation preview over the original video.
  const show = cur && videoSrc === "input" && (cur.my || "").trim();
  overlay.innerHTML = show ? `<span>${esc(cur.my)}</span>` : "";
});
video.addEventListener("pause", () => { stopAt = null; });

// ---------- boot ----------
(async () => {
  meta = await api("/api/meta");
  updateKeyWarning();
  const m = location.hash.match(/p=([\w-]+)/);
  if (m) openProject(m[1]).catch(showHome);
  else showHome();
  if (!local.assemblyKey || !local.geminiKey) openSettings();
})();
