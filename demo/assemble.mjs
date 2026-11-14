// Assembles the demo videos from a recorded take (see record.mjs): cuts segments by the recorder's marks, burns in
// caption bars (rendered as PNGs by headless Chrome, since this ffmpeg has no drawtext), adds title/end cards,
// narration synthesised with macOS `say`, an ffmpeg-generated bed and effect cues, and muxes H.264 + AAC.
// Usage: TAKE=<take dir> WORK=<work dir> node demo/assemble.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const TAKE = process.env.TAKE, WORK = process.env.WORK, REPO = path.resolve(import.meta.dirname, "..");
const TESTS = process.env.TESTS ?? "";
mkdirSync(WORK, { recursive: true });
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "inherit"] });
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const D = JSON.parse(readFileSync(`${TAKE}/marks.json`, "utf8"));
const M = Object.fromEntries(D.marks.map((m) => [m.name, m]));
const T = (n) => M[n]?.t;
const has = (...n) => n.every((k) => M[k]);
const BG = "0x0a0a14";
const CAPT = (D.events ?? []).find((e) => e.type === "CAPTURE_SUCCEEDED")?.t ?? M.crash?.t;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function shot(html, out, w = 1920, h = 1080) {
  const f = `${WORK}/${path.basename(out)}.html`; writeFileSync(f, html);
  execFileSync(CH, ["--headless=new", "--hide-scrollbars", `--window-size=${w},${h}`, `--user-data-dir=${WORK}/chrome-cards`, `--screenshot=${out}`, `file://${f}`], { stdio: "ignore" });
}
const FONT = `font-family:-apple-system,'Helvetica Neue',Arial,sans-serif`;
function caption(text, name, tag = "", src = "") {
  const full = `${WORK}/${name}-full.png`, out = `${WORK}/${name}.png`;
  const pill = tag ? `<span style="flex:none;margin-right:22px;padding:6px 16px;border-radius:8px;background:#ff4fa3;color:#0a0a14;font-size:24px;font-weight:900;letter-spacing:2px">${esc(tag)}</span>` : "";
  const small = src ? ` <span style="font-size:17px;font-weight:400;color:#8f96bd">(${esc(src)})</span>` : "";
  shot(`<body style="margin:0;background:#0a0a14"><div style="position:absolute;left:0;top:990px;width:1920px;height:90px;display:flex;align-items:center;justify-content:center;background:#0a0a14;border-top:2px solid #2ee6d6;${FONT};color:#f2f4ff;font-size:${text.length > 105 ? 24 : 28}px;font-weight:600;line-height:1.15;text-align:left;padding:0 50px;box-sizing:border-box">${pill}<span>${esc(text)}${small}</span></div></body>`, full);
  ff(["-i", full, "-vf", "crop=1920:90:0:990", out]);
  return out;
}
function page(inner, name) { const out = `${WORK}/${name}.png`; shot(`<body style="margin:0;background:radial-gradient(ellipse at 50% 10%,#2a1050 0%,#0a0a14 70%);${FONT};color:#f2f4ff;height:1080px;box-sizing:border-box;padding:70px 110px">${inner}</body>`, out); return out; }
function card(lines, name) {
  const out = `${WORK}/${name}.png`;
  shot(`<body style="margin:0;background:radial-gradient(ellipse at 50% 20%,#2a1050 0%,#0a0a14 70%);${FONT};color:#f2f4ff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center">
  <div style="font-size:124px;font-weight:900;letter-spacing:10px"><span style="color:#ff4fa3;text-shadow:0 0 28px #ff4fa3aa">VICE</span> <span style="color:#2ee6d6;text-shadow:0 0 28px #2ee6d6aa">EXCHANGE</span></div>
  ${lines.map((l, i) => `<div style="margin-top:${i ? 18 : 44}px;font-size:${i ? 34 : 44}px;color:${i ? "#b9bfe0" : "#f2f4ff"};max-width:1500px">${esc(l)}</div>`).join("")}</body>`, out);
  return out;
}
function listFile(frames, t0, t1, name) {
  const fs = frames.filter((f) => f.t >= t0 && f.t <= t1);
  if (fs.length < 2) throw new Error(`no frames for ${name}`);
  let s = "";
  fs.forEach((f, i) => { const d = ((i + 1 < fs.length ? fs[i + 1].t : t1) - f.t) / 1000; s += `file '${TAKE}/${f.f}'\nduration ${Math.max(0.02, d).toFixed(3)}\n`; });
  s += `file '${TAKE}/${fs[fs.length - 1].f}'\n`;
  const out = `${WORK}/${name}.txt`; writeFileSync(out, s);
  return { out, real: (t1 - t0) / 1000, t0 };
}
const ENC = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "25"];
const FRAME = `scale=1760:990,pad=1920:1080:80:0:color=${BG}`;

/** Renders one segment to mp4 of exactly `len` seconds; returns { file, len, map(wallMs) -> seconds into segment }. */
function seg(s, i, prefix) {
  const out = `${WORK}/${prefix}-${String(i).padStart(2, "0")}-${s.id}.mp4`;
  const cap = s.caption ? caption(s.caption, `${prefix}-cap-${i}`, s.tag, s.src) : null;
  const len = s.len;
  let speed = 1, t0 = 0;
  if (s.kind === "card") {
    ff(["-loop", "1", "-i", s.png, "-t", String(len), "-vf", "fps=25,scale=1920:1080", ...ENC, out]);
  } else if (s.kind === "still") {
    ff(["-loop", "1", "-i", s.png, "-loop", "1", "-i", cap, "-filter_complex", `[0:v]fps=25,${FRAME}[v];[v][1:v]overlay=0:990`, "-t", String(len), ...ENC, out]);
  } else if (s.kind === "clip") {
    speed = Math.max(1, (s.end - s.start) / len);
    ff(["-ss", String(s.start), "-t", String(s.end - s.start), "-i", s.src, "-loop", "1", "-i", cap, "-filter_complex",
      `[0:v]setpts=PTS/${speed.toFixed(4)},fps=25,${FRAME},tpad=stop_mode=clone:stop_duration=20[v];[v][1:v]overlay=0:990`, "-t", String(len), ...ENC, out]);
  } else if (s.kind === "duo") {
    const a = listFile(D.framesA, s.t0, s.t1, `${prefix}-${i}-a`), b = listFile(D.framesB, s.t0, s.t1, `${prefix}-${i}-b`);
    speed = Math.max(1, a.real / len); t0 = s.t0;
    ff(["-f", "concat", "-safe", "0", "-i", a.out, "-f", "concat", "-safe", "0", "-i", b.out, "-loop", "1", "-i", cap, "-filter_complex",
      `[0:v]setpts=PTS/${speed.toFixed(4)},fps=25,scale=960:540[a];[1:v]setpts=PTS/${speed.toFixed(4)},fps=25,scale=960:540[b];[a][b]hstack,pad=1920:1080:0:225:color=${BG},tpad=stop_mode=clone:stop_duration=20[v];[v][2:v]overlay=0:990`,
      "-t", String(len), ...ENC, out]);
  } else {
    const l = listFile(D[`frames${s.cam}`], s.t0, s.t1, `${prefix}-${i}`);
    speed = Math.max(1, l.real / len); t0 = s.t0;
    ff(["-f", "concat", "-safe", "0", "-i", l.out, "-loop", "1", "-i", cap, "-filter_complex",
      `[0:v]setpts=PTS/${speed.toFixed(4)},fps=25,${FRAME},tpad=stop_mode=clone:stop_duration=20[v];[v][1:v]overlay=0:990`, "-t", String(len), ...ENC, out]);
  }
  return { file: out, len, speed, map: (t) => (t0 && t >= s.t0 && t <= s.t1 ? (t - s.t0) / 1000 / speed : null) };
}

const PIPER = process.env.PIPER ?? "/tmp/vxtts/bin/piper", PIPER_MODEL = process.env.PIPER_MODEL ?? "/tmp/vxvoice/ryan.onnx";
const HAVE_PIPER = existsSync(PIPER) && existsSync(PIPER_MODEL);
export const VOICE = HAVE_PIPER ? "Piper neural voice en_US-ryan-high (rhasspy/piper-voices)" : "macOS say, voice Daniel (fallback)";
/** One narration line -> loudness-normalised 48 kHz stereo WAV. Piper neural voice, or `say -v Daniel` if Piper is absent. */
function speak(text, out) {
  const raw = out.replace(/\.wav$/, "-raw.wav");
  if (HAVE_PIPER) execFileSync(PIPER, ["-m", PIPER_MODEL, "-f", raw, "--length-scale", "0.97", "--sentence-silence", "0.28"], { input: text, stdio: ["pipe", "ignore", "ignore"] });
  else { const a = raw.replace(/\.wav$/, ".aiff"); execFileSync("say", ["-v", "Daniel", "-r", "165", "-o", a, text.replace(/\. /g, ". [[slnc 250]] ")]); ff(["-i", a, raw]); }
  ff(["-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000", "-ac", "2", out]);
}
function build(name, segsIn) {
  const segs = segsIn.filter(Boolean);
  // Narration first: a segment is never shorter than its line.
  segs.forEach((s, i) => {
    if (!s.say) return;
    s.aiff = `${WORK}/${name}-say-${i}.wav`;
    speak(s.say, s.aiff);
    s.sayLen = dur(s.aiff);
    s.len = Math.max(s.len, Math.ceil((s.sayLen + 0.8) * 10) / 10);
  });
  const done = segs.map((s, i) => seg(s, i, name));
  writeFileSync(`${WORK}/${name}-concat.txt`, done.map((d) => `file '${d.file}'`).join("\n") + "\n");
  const silent = `${WORK}/${name}-video.mp4`;
  ff(["-f", "concat", "-safe", "0", "-i", `${WORK}/${name}-concat.txt`, "-c", "copy", silent]);
  const total = done.reduce((a, d) => a + d.len, 0);
  const offs = []; done.reduce((a, d, i) => ((offs[i] = a), a + d.len), 0);
  // Effect cues from the real event log: a soft tick per resolved decision, a low hit on capture.
  const cues = [];
  for (const e of D.events ?? []) {
    if (e.type !== "DECISION_RESOLVED" && e.type !== "CAPTURE_SUCCEEDED") continue;
    for (let i = 0; i < segs.length; i++) { const at = done[i].map(e.t); if (at !== null && at < done[i].len) { cues.push({ at: offs[i] + at, kind: e.type === "CAPTURE_SUCCEEDED" ? "hit" : "tick" }); } }
  }
  const tick = `${WORK}/tick.wav`, hit = `${WORK}/hit.wav`, bed = `${WORK}/${name}-bed.wav`;
  ff(["-f", "lavfi", "-i", "sine=f=1320:d=0.07", "-af", "afade=t=out:st=0.01:d=0.06,volume=0.5", tick]);
  ff(["-f", "lavfi", "-i", "sine=f=52:d=1.6", "-f", "lavfi", "-i", "anoisesrc=d=1.6:c=brown:a=0.5", "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0,lowpass=f=180,afade=t=out:st=0.05:d=1.5,volume=1.6", hit]);
  ff(["-f", "lavfi", "-i", `sine=f=55:d=${total}`, "-f", "lavfi", "-i", `sine=f=82.4:d=${total}`, "-f", "lavfi", "-i", `sine=f=164.8:d=${total}`, "-f", "lavfi", "-i", `anoisesrc=d=${total}:c=pink:a=0.08`,
    "-filter_complex", `[0:a]volume=0.5[a];[1:a]volume=0.35,tremolo=f=0.15:d=0.6[b];[2:a]volume=0.12,tremolo=f=0.23:d=0.8[c];[3:a]lowpass=f=900[d];[a][b][c][d]amix=inputs=4:normalize=0,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,volume=0.045`, bed]);
  const ins = ["-i", bed]; const parts = ["[0:a]aformat=channel_layouts=stereo[x0]"]; let n = 1;
  segs.forEach((s, i) => { if (!s.aiff) return; ins.push("-i", s.aiff); const ms = Math.round((offs[i] + 0.35) * 1000); parts.push(`[${n}:a]aformat=channel_layouts=stereo,volume=1.0,adelay=${ms}|${ms}[x${n}]`); n++; });
  for (const c of cues.slice(0, 40)) { ins.push("-i", c.kind === "hit" ? hit : tick); const ms = Math.round(c.at * 1000); parts.push(`[${n}:a]aformat=channel_layouts=stereo,adelay=${ms}|${ms}[x${n}]`); n++; }
  const mixIn = Array.from({ length: n }, (_, k) => `[x${k}]`).join("");
  const audio = `${WORK}/${name}-audio.m4a`;
  ff([...ins, "-filter_complex", `${parts.join(";")};${mixIn}amix=inputs=${n}:normalize=0:duration=first,alimiter=limit=0.95[out]`, "-map", "[out]", "-t", total.toFixed(2), "-c:a", "aac", "-b:a", "160k", "-ac", "2", audio]);
  const final = `${REPO}/demo/${name}.mp4`;
  ff(["-i", silent, "-i", audio, "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-shortest", final]);
  const table = segs.map((s, i) => ({ at: offs[i], len: done[i].len, id: s.id, speed: Number(done[i].speed.toFixed(2)), caption: s.caption ?? "(card)", say: s.say ?? "" }));
  writeFileSync(`${WORK}/${name}-shots.json`, JSON.stringify({ total, cues: cues.length, table }, null, 1));
  console.log(name, "duration", dur(final).toFixed(2), "segments", table.map((t) => `${t.id}@${t.at.toFixed(1)}x${t.speed}`).join(" "));
  return final;
}

const clips = readdirSync(`${REPO}/integrations/ota-bridge/frames`).filter((f) => f.endsWith(".mp4")).map((f) => `${REPO}/integrations/ota-bridge/frames/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const CLIP = clips[0], CLIPLEN = dur(CLIP);
const allDrex = Object.keys(M.proof?.metrics?.bySource ?? { x: 1 }).every((k) => k === "drex");
const who = allDrex ? "Every card in this run is a real Drex call: options, probabilities, latency." : "Each card shows who decided, the options, probabilities and latency.";
const cap = M.crash?.by?.[0];

const mt = M.proof?.metrics ?? { total: 0, bySource: {} }, bs = mt.bySource;
const nDrex = bs.drex ?? 0, nGuard = bs.drex_low_confidence_guardrail ?? 0, nFb = bs.fallback ?? 0, nOther = mt.total - nDrex - nGuard - nFb;
const countsCap = `This run's metrics panel: ${mt.total} NPC decisions: ${nDrex} decided by Drex, ${nGuard} low-confidence guardrail, ${nFb} fallback${nOther ? `, ${nOther} other` : ""}.`;
const countsSay = `In this run the metrics panel counts ${mt.total} decisions: ${nDrex} decided by Drex, ${nGuard} by the low confidence guardrail, and ${nFb} by fallback.`;
const lat = M.proof?.latency?.drex;
const box = (t, d, c) => `<div style="flex:1;border:2px solid ${c};border-radius:14px;padding:18px 20px;background:#12122299"><div style="font-size:27px;font-weight:800;color:${c}">${t}</div><div style="margin-top:8px;font-size:22px;color:#c9cfee;line-height:1.3">${d}</div></div>`;
const arrow = `<div style="flex:none;font-size:44px;color:#ff4fa3;align-self:center;padding:0 10px">&#8594;</div>`;
const trackPng = page(`<div style="font-size:30px;letter-spacing:5px;color:#2ee6d6;font-weight:800">NACE AI DREXATHON &middot; THE TRACK</div>
<div style="margin-top:26px;font-size:54px;font-weight:900;color:#ff4fa3">Swarm Intelligence: multi-agent systems</div>
<div style="margin-top:22px;font-size:39px;line-height:1.35;font-weight:500">&ldquo;Build systems where multiple agents coordinate, compete, or negotiate, with Drex making every agent's calls. Think traders in a simulated market, NPCs that think for themselves, or a team of agents dividing up a research task.&rdquo;</div>
<div style="margin-top:44px;font-size:28px;color:#8f96bd">VICE EXCHANGE is two of those examples at once:</div>
<div style="margin-top:16px;display:flex;gap:26px">${box("Traders in a simulated market", "Two trader NPCs buy, hold or sell character tickers on one shared exchange.", "#2ee6d6")}${box("NPCs that think for themselves", "Witnesses, informants and police each decide from their own private memory.", "#ff4fa3")}${box("Bonus: NDI, real-world documents", "Police decisions carry facts NDI parsed from a real San Francisco Police Department order.", "#b98cff")}</div>`, "card-track");
const buildPng = page(`<div style="font-size:30px;letter-spacing:5px;color:#2ee6d6;font-weight:800">HOW IT IS BUILT &middot; ONE STEP OF THE SWARM</div>
<div style="margin-top:50px;display:flex">${box("1 &middot; Trigger", "An NPC witnesses an event or receives a message.", "#ffd166")}${arrow}${box("2 &middot; The NPC", "Role, goal and private memory. Nothing it was not shown or told.", "#ff4fa3")}${arrow}${box("3 &middot; One Drex call", "systemOne with a typed choice question built only from that NPC's knowledge.", "#2ee6d6")}</div>
<div style="margin-top:34px;display:flex">${box("4 &middot; Drex answers", "A label with a probability for every option.", "#2ee6d6")}${arrow}${box("5 &middot; Server enforces", "Checks the label against the actions that are legal right now, then applies it.", "#b98cff")}${arrow}${box("6 &middot; Effect", "A message to another agent, a trade on the shared market, or a police move.", "#ffd166")}</div>
<div style="margin-top:46px;font-size:34px;font-weight:700;text-align:center;color:#f2f4ff">Each effect is the trigger for the next agent: witness &#8594; police &#8594; public bulletin &#8594; traders &#8594; market &#8594; capture.</div>
<div style="margin-top:22px;font-size:24px;text-align:center;color:#8f96bd">The model chooses. Code owns positions, wallets, prices and the capture rule.</div>`, "card-build");
const rejected = (D.events ?? []).some((e) => e.type === "TRADE_REJECTED" && M.rejected && e.t >= M.rejected.t - 500);
// Segments whose marks are missing from the take are skipped (returning null), so one command always produces a cut.
const main = [
  { id: "title", kind: "card", len: 5, png: card(["Every outlaw is a stock. Every NPC decides for itself. Get caught and your ticker goes to V$0.", "Nace AI Drexathon · V$ are fictional game credits"], "card-title"),
    say: "Vice Exchange. Every outlaw is a stock. Every character in the city decides for itself. The money is fictional game credits." },
  { id: "track", kind: "card", len: 15, png: trackPng,
    say: "The track is Swarm Intelligence: multi-agent systems. Build systems where multiple agents coordinate, compete, or negotiate, with Drex making every agent's calls. Think traders in a simulated market, characters that think for themselves, or a team of agents dividing up a research task. This project is the first two at once." },
  { id: "how-built", kind: "card", len: 16, png: buildPng,
    say: "Here is one step of the swarm. A character sees something, or gets a message. The server makes one Drex call, built only from what that character knows. Drex answers with a choice and its probabilities. The server checks the choice is legal and applies it. That becomes a message, a trade, or a police move, and it triggers the next agent." },
  has("city", "two") && { id: "city", cam: "C", t0: T("city"), t1: T("city") + 6800, len: 8, tag: "ONE PLAYER · A SWARM OF AGENTS", caption: "One player. A swarm of agents deciding against you: 2 witnesses, 2 informants, 2 traders, 2 police. Header badge: Drex.",
    say: "One player against a swarm. Eight agents share this city: witnesses who can report you, informants who sell what they hear, traders who bet on you, and police who hunt you." },
  has("two", "job") && { id: "two-players", kind: "duo", t0: T("two"), t1: T("job") - 900, len: 6, caption: "Two human players, one authoritative server: Outlaw (left) and Hunter (right), each with their own camera.",
    say: "A second human joins as a hunter, after the bounty. The server owns every position and every price." },
  has("job", "chain") && { id: "job", cam: "A", t0: T("job"), t1: T("chain"), len: 10, tag: allDrex ? "DREX DECIDES" : "NPC DECIDES", caption: "The outlaw does a job. A witness saw it: her decision card shows the options, probabilities and latency.", src: "decision cards: live values from this run",
    say: "The outlaw does a job, and the price jumps. A witness saw it. Her decision card shows the options, the probabilities, and how long Drex took." },
  has("chain", "inspect") && { id: "swarm-reacts", cam: "A", t0: T("chain"), t1: T("inspect"), len: 9, tag: "COORDINATE · COMPETE", caption: "Witness to police to public bulletin: WANTED, and the price falls. Each trader then decides on the same ticker from its own memory.",
    say: "The agents coordinate. The witness reports, police put out a bulletin, and the price falls before anyone is caught. And they compete: each trader makes its own call on the same stock." },
  has("inspect", "inspectend") && { id: "inspector", cam: "C", t0: T("inspect"), t1: T("inspectend"), len: 9, tag: "NDI", caption: "Agent Inspector on a police officer: private memory with provenance, the decision trace, and cited policy facts.", src: "policy: SFPD General Order 5.25 Foot Pursuits, parsed by Nace NDI",
    say: "Click any agent to see what it knows and where each fact came from. Police decisions also cite a real San Francisco police order on foot pursuits, parsed with N D I." },
  // PLACEHOLDER (shot at the end): the hunt with the stun weapon in the 3D city.
  has("hunt0", "hunt1") && { id: "hunt", cam: M.hunt0.cam ?? "A", t0: T("hunt0"), t1: T("hunt1"), len: 20, tag: "PLAYERS HUNT · DREX DECIDES", caption: "Players hunt each other. Every NPC who sees it decides with Drex.", src: "decision cards: live values from this run",
    say: M.hunt0.say ?? "Players hunt each other with a stun pulse. The outlaw's shot is seen, and every agent who saw it decides with Drex: report, pursue, or trade." },
  // PLACEHOLDER (shot at the end): hunter crews that split a bounty or double-cross.
  has("crew0", "crew1") && { id: "crews", cam: M.crew0.cam ?? "A", t0: T("crew0"), t1: T("crew1"), len: 12, tag: "NEGOTIATE", caption: M.crew0.caption ?? "Hunter crews: split the bounty, or double-cross.",
    say: M.crew0.say ?? "Hunters can form a crew and split the bounty, or double-cross each other." },
  has("pursuit", "crash") && { id: "pursuit", cam: "A", t0: Math.max(T("pursuit"), CAPT - 16000), t1: CAPT - 600, len: 6, caption: "Police set off after a dispatch delay and close in on foot (sped up).",
    say: "Officers close in." },
  has("crash") && { id: "capture", cam: "A", t0: CAPT - 600, t1: CAPT + 6400, len: 7, caption: cap ? `Captured by ${cap[0]}: the ticker goes to exactly V$0 and trading is halted.` : "Capture: the ticker goes to exactly V$0 and trading is halted.",
    say: "Captured. The stock goes to exactly zero, and trading stops." },
  has("rejected", "proof") && { id: "respawn", cam: "A", t0: T("rejected") - 300, t1: T("proof"), len: 7, caption: `${rejected ? "A buy on the halted ticker is rejected. " : ""}Respawn: a new character and a new ticker. The old one stays listed at V$0.`,
    say: `${rejected ? "A buy on the halted stock is refused. " : ""}The player comes back as a new character with a new stock. The old one stays on the board at zero.` },
  // PLACEHOLDER text may be replaced at the end (stolen car, helicopter) through M.world.say / M.world.caption.
  { id: "world-3d", kind: "clip", src: CLIP, start: M.world?.start ?? 2, end: M.world?.end ?? CLIPLEN - 0.5, len: 18, caption: M.world?.caption ?? "The same server driving a 3D city client (Godot, on the MIT-licensed Open Theft Auto). Sped up.",
    say: M.world?.say ?? "The same server also drives a full three D city. The same agents walk its streets, with their decisions over their heads." },
  has("proof", "proofend") && { id: "experiment", cam: "A", t0: T("proof"), t1: T("proofend"), len: 15, tag: "EVERY CALL, COUNTED", caption: countsCap + " Then: scripted vs Meta LLM vs Drex on one seed (sped up).", src: "numbers read from this recording's own run",
    say: `${countsSay} Then one seeded scenario runs three ways: scripted rules, a Meta language model, and Drex, with measured latency.` },
  has("verify") && { id: "replay", kind: "still", png: `${TAKE}/verify.png`, len: 4, caption: `Server response: the event log replayed with no model calls matches live state (ok=${M.verify.ok}, ${M.verify.events} events, ${M.verify.mismatches} mismatches).`,
    say: "And the whole run replays from its log, with no model calls." },
  { id: "end", kind: "card", len: 4, png: card(["A swarm that decides. A market that reacts. Every decision on the record.", `Recorded from a real run · ${TESTS ? TESTS + " automated tests passing · " : ""}repo: vice-exchange`], "card-end"),
    say: "Vice Exchange. A swarm that decides, with every decision on the record." },
];
const npcs = [
  has("city") && { id: "eight-npcs", cam: "C", t0: T("city"), t1: T("city") + 6800, len: 9, caption: "One player against eight NPC agents: witnesses, informants, traders and police, each with private memory.",
    say: "Eight agents share this city: witnesses, informants, traders and police. None of them can see what the others know." },
  has("job", "inspect") && { id: "swarm-decides", cam: "A", t0: T("jobdone") - 1500, t1: T("inspect"), len: 15, caption: `After a job, several NPCs decide at once. ${who}`,
    say: "When the outlaw does a job, only the agents who saw it react. The witness reports. A bulletin goes out. Then traders and officers each make their own call, shown live." },
  has("hunt0", "hunt1") && { id: "hunt", cam: M.hunt0.cam ?? "A", t0: T("hunt0"), t1: T("hunt1"), len: 12, caption: "Players hunt each other. Every NPC who sees it decides with Drex.",
    say: "Players hunt each other, and every agent who sees it decides what to do." },
  has("pursuit", "crash") && { id: "officers-converge", cam: "A", t0: Math.max(T("pursuit"), CAPT - 14000), t1: CAPT + 6000, len: 9, caption: "Officers converge and make the capture: V$0.",
    say: "Officers converge, and the stock goes to zero." },
  { id: "swarm-3d", kind: "clip", src: CLIP, start: Math.min(12, CLIPLEN / 3), end: Math.min(36, CLIPLEN - 2), len: 11, caption: "The same swarm in the 3D city client: characters labelled by role, decisions above their heads (sped up).",
    say: "The same swarm, inside the full three D city." },
];
const which = process.env.ONLY;
if (which === "cards") { console.log("cards rendered:", trackPng, buildPng, "voice:", VOICE); }
else if (which === "voice") { const o = `${WORK}/voice-test.wav`; speak(main[1].say, o); console.log("voice:", VOICE, "test line", dur(o).toFixed(1), "s ->", o); }
else {
  if (!which || which === "main") build("vice-exchange-demo", main);
  if (!which || which === "npcs") build("vice-exchange-npcs", npcs);
  console.log("voice:", VOICE);
}
