/* JARVIS front-end: voice in (Chrome speech recognition), voice out, UI. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ state
  let config = { language: "en-US", name: "" };
  let state = "idle";            // idle | listening | thinking | speaking
  let live = false;              // always-listening mode
  let voiceOn = true;
  let recognition = null;
  let recognizing = false;
  let busy = false;
  let level = 0;                 // mic level 0..1 for the orb
  const voiceWarned = {};

  function setState(s, label) {
    state = s;
    document.body.classList.remove("listening", "thinking", "speaking");
    if (s !== "idle") document.body.classList.add(s);
    const labels = { idle: live ? "LIVE · WAITING" : "STANDBY", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };
    $("state").textContent = label || labels[s];
  }

  // ------------------------------------------------------------ log
  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function addMsg(kind, text) {
    if (!text) return;
    const div = document.createElement("div");
    div.className = "msg " + kind;
    if (kind === "user" || kind === "bot") {
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = (kind === "user" ? (config.name || "YOU").toUpperCase() : "JARVIS") + " · " + timeNow();
      div.appendChild(t);
    }
    div.appendChild(document.createTextNode(text));
    $("log").appendChild(div);
    $("log").scrollTop = $("log").scrollHeight;
  }
  function toast(text, ms = 6000) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), ms);
  }

  // ------------------------------------------------------------ server calls
  async function api(path, body) {
    const opts = body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis": "1" },
      body: JSON.stringify(body),
    };
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ------------------------------------------------------------ speaking
  const hasArabicScript = (s) => /[؀-ۿ]/.test(s);
  const hasDevanagari = (s) => /[ऀ-ॿ]/.test(s);

  function pickVoice(text) {
    const voices = speechSynthesis.getVoices();
    let want;
    if (hasArabicScript(text)) {
      want = config.language.startsWith("ur") ? ["ur", "fa", "ar"] : config.language.startsWith("ar") ? ["ar", "fa", "ur"] : ["fa", "ur", "ar"];
    } else if (hasDevanagari(text)) {
      want = ["hi"];
    } else {
      want = ["en"];
    }
    const chosen = hasArabicScript(text) ? config.voice_rtl : (!hasDevanagari(text) ? config.voice_en : "");
    if (chosen) {
      const v = voices.find((x) => x.name === chosen);
      if (v) return v;
    }
    // Male voices first (Edge "Online (Natural)" voices sound best).
    const MALE = /Farid|Asad|Salman|Madhur|Hamed|Shakir|Gul Nawaz|Ryan|Guy|Andrew|Brian|Christopher|Eric|Roger|Steffan|Thomas|Daniel|David|Mark|George|James|UK English Male/i;
    const FEMALE = /Dilara|Uzma|Gul\b|Swara|Zariyah|Latifa|Aria|Jenny|Emma|Ava|Michelle|Sonia|Libby|Zira|Hazel|Susan|Female/i;
    const score = (v) => (MALE.test(v.name) ? 4 : 0) + (/Natural|Online/i.test(v.name) ? 2 : 0) + (FEMALE.test(v.name) ? -5 : 0) + (/en-GB/i.test(v.lang) ? 1 : 0);
    for (const lang of want) {
      const list = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
      if (list.length) return list.sort((x, y) => score(y) - score(x))[0];
    }
    return want[0] === "en" ? null : false; // false = no voice for this language
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!voiceOn || !text || !("speechSynthesis" in window)) return resolve();
      const voice = pickVoice(text);
      if (voice === false) {
        const key = hasArabicScript(text) ? "arabic" : "other";
        if (!voiceWarned[key]) {
          voiceWarned[key] = true;
          addMsg("sys", "No voice for this language on this computer — reading the text on screen instead.");
        }
        return resolve();
      }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = 1.02;
      u.pitch = 0.95;
      stopListening();
      setState("speaking");
      let done = false;
      const finish = () => { if (done) return; done = true; clearInterval(keep); resolve(); };
      // Chrome stops long speech after ~15s unless nudged
      const keep = setInterval(() => { if (speechSynthesis.speaking) { speechSynthesis.pause(); speechSynthesis.resume(); } }, 10000);
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      setTimeout(finish, Math.min(60000, 4000 + text.length * 120));
    });
  }

  // ------------------------------------------------------------ commands
  async function sendCommand(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    busy = true;
    addMsg("user", text);
    $("heard").textContent = text;
    setState("thinking");
    try {
      let res = await api("/api/command", { text });
      if (res.ask_ai) {
        const content = await askAI(res.ask_ai);
        if (content === null) return;
        res = await api("/api/ai-reply", { text, content, fallback: res.fallback || [] });
      }
      (res.results || []).forEach((r) => addMsg("sys", "✓ " + r));
      if (res.say) {
        addMsg("bot", res.say);
        $("heard").textContent = res.say;
        await speak(res.say);
      }
    } catch (e) {
      addMsg("bot", "I lost connection to my core. Is the JARVIS window still open?");
      setOnline(false);
    } finally {
      busy = false;
      setState("idle");
      if (live) setTimeout(startListening, 400);
    }
  }

  // Chrome talks to the AI service directly (works even when Python is blocked).
  async function askAI(req) {
    // If the main model is busy, quietly try the backup models.
    const models = [req.body.model, ...(req.backup || [])];
    for (let i = 0; i < models.length; i++) {
      const last = i === models.length - 1;
      const out = await askOnce({ ...req, body: { ...req.body, model: models[i] } }, last);
      if (out !== "RETRY") return out;
    }
    return null;
  }

  async function askOnce(req, last) {
    const fail = async (msg) => { addMsg("bot", msg); $("heard").textContent = msg; await speak(msg); return null; };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), last ? 45000 : 20000);
    let r;
    try {
      r = await fetch(req.url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + req.key },
        body: JSON.stringify(req.body),
      });
    } catch (e) {
      if (!last && e.name === "AbortError") return "RETRY";
      return fail(e.name === "AbortError"
        ? "The AI service is taking too long. Please try again."
        : "I can't reach the AI service. Please check the internet connection.");
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (Array.isArray(data)) data = data[0];
    if (!r.ok && !last && [404, 429, 500, 503].includes(r.status)) return "RETRY";
    if (!r.ok) {
      const detail = (data && data.error && data.error.message) || "";
      console.warn("AI error", r.status, detail);
      if (r.status === 400 && /api key/i.test(detail)) return fail("My AI key is not valid. Please paste it again in Settings.");
      if (r.status === 401 || r.status === 403) return fail("My AI key is not working. Please check it in Settings.");
      if (r.status === 404) return fail("The AI model name is wrong. Open Settings, choose the provider again and save.");
      if (r.status === 429) return fail("The AI service is busy or the free limit is reached. Please try again in a minute.");
      return fail("The AI service returned an error (" + r.status + "). " + detail.slice(0, 120));
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    return (msg && msg.content) || "";
  }

  // ------------------------------------------------------------ listening
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function makeRecognition() {
    const r = new SR();
    r.lang = config.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    r.onstart = () => { recognizing = true; finalText = ""; setState("listening"); };
    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t; else interim += t;
      }
      $("heard").textContent = finalText || interim;
    };
    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        live = false; updateLive();
        navigator.mediaDevices.enumerateDevices().then((list) => {
          const mics = list.filter((d) => d.kind === "audioinput");
          addMsg("bot", mics.length
            ? "I need microphone permission. Click the lock icon next to the address bar and allow the microphone."
            : "Windows can't find any microphone. Please connect a headset or microphone. You can type commands meanwhile.");
        }).catch(() => addMsg("bot", "I can't use the microphone. Please check it is connected and allowed."));
      } else if (ev.error === "audio-capture") {
        live = false; updateLive();
        addMsg("bot", "I can't find a microphone. Please connect a headset or microphone.");
      } else if (ev.error === "network") {
        addMsg("bot", "Speech recognition needs internet. Please check the connection.");
      }
    };
    r.onend = () => {
      recognizing = false;
      const text = finalText.trim();
      if (text) {
        sendCommand(text);
      } else if (state === "listening") {
        setState("idle");
        if (live && !busy) setTimeout(startListening, 250);
      }
    };
    return r;
  }

  function startListening() {
    if (!SR) {
      addMsg("bot", "Voice input works in Microsoft Edge or Google Chrome.");
      return;
    }
    if (recognizing || busy || state === "speaking") return;
    try {
      recognition = makeRecognition();
      recognition.start();
      startLevelMeter();
    } catch (e) { /* already started */ }
  }
  function stopListening() {
    if (recognition && recognizing) {
      try { recognition.abort(); } catch (e) {}
    }
    recognizing = false;
  }

  // mic level for the orb animation
  let analyser = null;
  async function startLevelMeter() {
    if (analyser || !navigator.mediaDevices) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
    } catch (e) { analyser = null; }
  }
  const levelBuf = new Uint8Array(128);
  function readLevel() {
    if (analyser && state === "listening") {
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0;
      for (const v of levelBuf) sum += Math.abs(v - 128);
      const l = Math.min(1, sum / levelBuf.length / 20);
      level += (l - level) * 0.3;
    } else if (state === "speaking") {
      level += ((0.35 + Math.random() * 0.45) - level) * 0.2;
    } else {
      level += (0 - level) * 0.1;
    }
  }

  function updateLive() {
    $("liveBtn").querySelector(".led").classList.toggle("on", live);
    if (state === "idle") setState("idle");
  }

  // ------------------------------------------------------------ orb
  const canvas = $("orb");
  const ctx2d = canvas.getContext("2d");
  const N = 700;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * Math.PI * (3 - Math.sqrt(5));
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random()]);
  }
  let rot = 0;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  window.addEventListener("resize", resize);
  resize();

  function draw(ts) {
    readLevel();
    const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;
    const speed = { idle: 0.002, listening: 0.006, thinking: 0.018, speaking: 0.008 }[state];
    rot += speed;
    const base = Math.min(w, h) * 0.34;
    const R = base * (1 + level * 0.18 + Math.sin(ts / 900) * 0.015);
    ctx2d.clearRect(0, 0, w, h);

    // glow
    const g = ctx2d.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.4);
    const col = { idle: "34,211,238", listening: "52,211,153", thinking: "251,191,36", speaking: "103,232,249" }[state];
    g.addColorStop(0, `rgba(${col},${0.18 + level * 0.25})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx2d.fillStyle = g;
    ctx2d.beginPath(); ctx2d.arc(cx, cy, R * 1.4, 0, Math.PI * 2); ctx2d.fill();

    const cosA = Math.cos(rot), sinA = Math.sin(rot), tilt = 0.35, cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const dpr = window.devicePixelRatio || 1;
    for (const p of pts) {
      let x = p[0] * cosA - p[2] * sinA;
      let z = p[0] * sinA + p[2] * cosA;
      let y = p[1] * cosT - z * sinT;
      z = p[1] * sinT + z * cosT;
      const wobble = 1 + level * 0.25 * Math.sin(ts / 180 + p[3] * 12);
      const s = (z + 2) / 3;
      const px = cx + x * R * wobble, py = cy + y * R * wobble;
      ctx2d.fillStyle = `rgba(${col},${0.15 + s * 0.75})`;
      const size = (0.6 + s * 1.6) * dpr;
      ctx2d.fillRect(px - size / 2, py - size / 2, size, size);
    }
    // inner core
    ctx2d.strokeStyle = `rgba(${col},0.55)`;
    ctx2d.lineWidth = 1.2 * dpr;
    ctx2d.beginPath(); ctx2d.arc(cx, cy, R * (0.22 + level * 0.1), 0, Math.PI * 2); ctx2d.stroke();
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // ------------------------------------------------------------ panels
  function tickClock() {
    const d = new Date();
    $("clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    $("seconds").textContent = String(d.getSeconds()).padStart(2, "0");
    $("date").textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase();
  }
  setInterval(tickClock, 1000);
  tickClock();

  function setOnline(ok) {
    const el = $("netState");
    el.textContent = ok ? "ONLINE" : "OFFLINE";
    el.classList.toggle("off", !ok);
  }

  function setBar(id, valId, v) {
    const bar = $(id);
    bar.style.width = Math.round(v) + "%";
    bar.classList.toggle("hot", v >= 85);
    $(valId).textContent = Math.round(v) + "%";
  }

  async function pollStatus() {
    try {
      const s = await api("/api/status");
      setOnline(true);
      const sys = s.system;
      setBar("cpuBar", "cpuVal", sys.cpu);
      setBar("ramBar", "ramVal", sys.memory);
      $("disks").innerHTML = "";
      for (const d of sys.disks) {
        const row = document.createElement("div");
        row.className = "meter";
        row.innerHTML = `<span>${d.name}:</span><div class="bar"><i style="width:${d.percent}%" class="${d.percent >= 90 ? "hot" : ""}"></i></div><b>${d.free_gb}G</b>`;
        row.title = `${d.name}: drive — ${d.percent}% used, ${d.free_gb} GB free`;
        $("disks").appendChild(row);
      }
      $("sysName").textContent = `${sys.computer} · ${sys.os}`;

      const rem = s.reminders;
      const ul = $("reminders");
      ul.innerHTML = "";
      if (!rem.upcoming.length) ul.innerHTML = '<li class="muted small">No reminders</li>';
      for (const r of rem.upcoming) {
        const li = document.createElement("li");
        const span = document.createElement("span"); span.textContent = r.text;
        const b = document.createElement("b"); b.textContent = r.at;
        li.append(span, b);
        ul.appendChild(li);
      }
      for (const r of rem.due) {
        beep();
        toast("⏰ " + r.text, 15000);
        addMsg("bot", "⏰ Reminder: " + r.text);
        await speak((hasArabicScript(r.text) ? "یادآوری: " : "Reminder: ") + r.text);
        setState("idle");
      }
    } catch (e) {
      setOnline(false);
    }
  }
  setInterval(pollStatus, 3000);
  pollStatus();

  async function pollWeather() {
    try {
      const w = await api("/api/weather");
      if (w && w.temp !== undefined) {
        $("temp").textContent = w.temp + "°C";
        $("wdesc").textContent = w.desc || "";
        $("wmore").textContent = `Feels ${w.feels}° · Humidity ${w.humidity}%`;
        $("city").textContent = w.city ? "· " + w.city.toUpperCase() : "";
      } else {
        $("wdesc").textContent = "Unavailable";
      }
    } catch (e) { $("wdesc").textContent = "Unavailable"; }
  }
  setInterval(pollWeather, 10 * 60 * 1000);
  pollWeather();

  function beep() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach((t) => {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(a.destination);
        g.gain.setValueAtTime(0.15, a.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + t + 0.2);
        o.start(a.currentTime + t); o.stop(a.currentTime + t + 0.21);
      });
    } catch (e) {}
  }

  // ------------------------------------------------------------ settings
  let providers = {};
  async function loadConfig() {
    try {
      config = await api("/api/config");
      providers = config.providers || {};
    } catch (e) { /* keep defaults */ }
    return config;
  }
  function fillVoices() {
    const voices = ("speechSynthesis" in window) ? speechSynthesis.getVoices() : [];
    const fill = (id, langs, current) => {
      const sel = $(id);
      sel.innerHTML = "";
      const auto = document.createElement("option");
      auto.value = ""; auto.textContent = "Automatic (male)";
      sel.appendChild(auto);
      voices.filter((v) => langs.some((l) => v.lang.toLowerCase().startsWith(l))).forEach((v) => {
        const o = document.createElement("option");
        o.value = v.name;
        o.textContent = v.name.replace(/^Microsoft\s+/, "").replace(/\s*-\s*.*$/, "") + " (" + v.lang + ")";
        sel.appendChild(o);
      });
      if (sel.options.length === 1) auto.textContent = "No voice on this browser";
      sel.value = current || "";
    };
    fill("cfgVoiceRtl", ["fa", "ur", "ar", "ps"], config.voice_rtl);
    fill("cfgVoiceEn", ["en"], config.voice_en);
  }
  document.querySelectorAll(".test-btn").forEach((b) => b.addEventListener("click", () => {
    const rtl = b.dataset.test === "rtl";
    const name = $(rtl ? "cfgVoiceRtl" : "cfgVoiceEn").value;
    const saved = { voice_rtl: config.voice_rtl, voice_en: config.voice_en };
    if (rtl) config.voice_rtl = name; else config.voice_en = name;
    speak(rtl ? "سلام، من جارویس هستم. چطور می‌توانم کمکتان کنم؟" : "Hello, I am JARVIS. How can I help you?")
      .then(() => { Object.assign(config, saved); setState("idle"); });
  }));
  if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", () => { if (!$("modal").hidden) fillVoices(); });

  function openSettings() {
    fillVoices();
    $("cfgName").value = config.name || "";
    $("cfgLang").value = config.language || "en-US";
    $("cfgProvider").value = config.provider || "gemini";
    $("cfgModel").value = config.model || "";
    $("cfgUrl").value = config.base_url || "";
    $("cfgKey").value = "";
    $("keyHint").textContent = config.has_key ? "(saved " + (config.key_hint || "") + " — leave empty to keep)" : "";
    updateKeyHelp();
    $("modal").hidden = false;
  }
  function updateKeyHelp() {
    const p = $("cfgProvider").value;
    const help = {
      gemini: "Free Gemini key: open <b>aistudio.google.com/apikey</b> → <b>Create API key</b> → copy → paste here.",
      openrouter: "Get a key at <b>openrouter.ai/keys</b>. For free use, set Model (Advanced) to a model ending in <b>:free</b>.",
      openai: "Get a key at <b>platform.openai.com/api-keys</b> (paid).",
      custom: "Any OpenAI-compatible service: set Model and Base URL under Advanced.",
    };
    $("keyHelp").innerHTML = help[p] || "";
  }
  $("cfgProvider").addEventListener("change", () => {
    const p = providers[$("cfgProvider").value];
    if (p) { $("cfgModel").value = p.model; $("cfgUrl").value = p.base_url; }
    updateKeyHelp();
  });
  $("settingsBtn").addEventListener("click", openSettings);
  $("closeModal").addEventListener("click", () => ($("modal").hidden = true));
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });
  $("saveCfg").addEventListener("click", async () => {
    try {
      await api("/api/config", {
        name: $("cfgName").value,
        language: $("cfgLang").value,
        voice_rtl: $("cfgVoiceRtl").value,
        voice_en: $("cfgVoiceEn").value,
        provider: $("cfgProvider").value,
        model: $("cfgModel").value,
        base_url: $("cfgUrl").value,
        api_key: $("cfgKey").value,
      });
      await loadConfig();
      $("modal").hidden = true;
      toast("Settings saved ✓", 2500);
      if (recognizing) { stopListening(); if (live) setTimeout(startListening, 300); }
    } catch (e) { toast("Could not save settings"); }
  });

  // ------------------------------------------------------------ controls
  $("micBtn").addEventListener("click", () => {
    if (state === "speaking") { speechSynthesis.cancel(); return; }
    if (recognizing) { recognition.stop(); return; }
    startListening();
  });
  $("liveBtn").addEventListener("click", () => {
    live = !live;
    updateLive();
    addMsg("sys", live ? "Live mode ON — I'm always listening." : "Live mode OFF.");
    if (live) startListening(); else stopListening(), setState("idle");
  });
  $("muteBtn").addEventListener("click", () => {
    voiceOn = !voiceOn;
    if (!voiceOn) speechSynthesis.cancel();
    $("muteBtn").querySelector(".led").classList.toggle("on", voiceOn);
  });
  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("input").value;
    $("input").value = "";
    sendCommand(v);
  });
  $("clearBtn").addEventListener("click", async () => {
    $("log").innerHTML = "";
    try { await api("/api/clear", {}); } catch (e) {}
  });
  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
    if (e.code === "Space" && !typing && !e.repeat) { e.preventDefault(); $("micBtn").click(); }
    if (e.key === "Escape") { $("modal").hidden = true; speechSynthesis.cancel(); }
  });

  // ------------------------------------------------------------ updates
  let update = null;
  async function checkUpdate() {
    $("verMsg").textContent = "Checking for updates…";
    try {
      update = await api("/api/update");
      $("verNow").textContent = update.current;
      if (update.available) {
        $("verMsg").textContent = "New version " + update.latest + " is ready.";
        $("updBtn").textContent = "Update now";
        $("updBtn").classList.add("go");
      } else if (update.latest === null) {
        $("verMsg").textContent = "Couldn't check right now.";
        $("updBtn").textContent = "Check";
        $("updBtn").classList.remove("go");
      } else {
        $("verMsg").textContent = "You have the latest version.";
        $("updBtn").textContent = "Check";
        $("updBtn").classList.remove("go");
      }
      $("updChip").hidden = !update.available;
    } catch (e) {
      $("verMsg").textContent = "Couldn't check right now.";
    }
  }
  async function runUpdate() {
    $("modal").hidden = true;
    $("updating").hidden = false;
    $("updText").textContent = "Updating JARVIS…";
    try {
      const r = await api("/api/update", {});
      if (!r.ok) throw new Error(r.error || "failed");
      $("updText").textContent = "Restarting…";
      await new Promise((ok) => setTimeout(ok, 2500));
      for (let i = 0; i < 40; i++) {
        try { await api("/api/status"); location.reload(); return; } catch (e) {}
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      $("updText").textContent = "JARVIS didn't come back. Please open it again from the desktop icon.";
    } catch (e) {
      $("updating").hidden = true;
      toast("Update failed: " + e.message, 8000);
    }
  }
  $("updBtn").addEventListener("click", () => (update && update.available ? runUpdate() : checkUpdate()));
  $("updChip").addEventListener("click", () => { openSettings(); });
  setTimeout(checkUpdate, 3000);
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);

  // ------------------------------------------------------------ start
  loadConfig().then((cfg) => {
    setState("idle");
    const hour = new Date().getHours();
    const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const hello = `${part}${cfg.name ? ", " + cfg.name : ""}. JARVIS is online.`;
    addMsg("bot", hello + (cfg.has_key ? " How can I help?" : " Open Settings (top right) and add an AI key so I can talk about anything."));
    if (!cfg.has_key) setTimeout(openSettings, 1200);
  });
})();
