// Records a real run of VICE EXCHANGE in the 3D city view: headless Chrome driven in real time over the Chrome DevTools
// Protocol against a real server with real Drex decisions. Frames come from Page.startScreencast (every frame, acked),
// one page at a time wherever possible so motion stays smooth.
// Usage: OUT=<take dir> BASE=http://localhost:5781 API=http://localhost:3781 node demo/record.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.OUT, BASE = process.env.BASE, API = process.env.API;
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: Date.now(), ...extra }); console.log("MARK", name, JSON.stringify(extra)); };
const kids = [];
const save = (extra = {}) => writeFileSync(`${OUT}/marks.json`, JSON.stringify({ marks, ...extra }, null, 0));

async function browser(port, tag) {
  mkdirSync(`${OUT}/${tag}`, { recursive: true });
  const p = spawn(CH, ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1600,900", "--hide-scrollbars", "--use-angle=metal",
    "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${OUT}/profile-${tag}`, "about:blank"], { stdio: "ignore" });
  kids.push(p);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(250); }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const frames = []; let seq = 0; let casting = false; const logs = []; let lastFrame = 0; let shotMode = false; let restarts = 0;
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === "Page.screencastFrame") {
      send("Page.screencastFrameAck", { sessionId: d.params.sessionId });
      if (!casting) return;
      const f = `${tag}/${String(++seq).padStart(6, "0")}.jpg`;
      writeFileSync(`${OUT}/${f}`, Buffer.from(d.params.data, "base64"));
      frames.push({ f, t: Date.now() }); lastFrame = Date.now();
    }
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 200));
  };
  // Watchdog: headless Chrome sometimes stops delivering screencast frames. Restart the screencast, and if it stalls
  // again fall back to a screenshot loop for this page so the take is never lost.
  const shotLoop = async () => { while (casting && shotMode) { const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }); if (!casting || !r.result?.data) continue; const f = `${tag}/${String(++seq).padStart(6, "0")}.jpg`; writeFileSync(`${OUT}/${f}`, Buffer.from(r.result.data, "base64")); frames.push({ f, t: Date.now() }); lastFrame = Date.now(); } };
  setInterval(async () => {
    if (!casting || shotMode || Date.now() - lastFrame < 700) return;
    restarts++; console.log("WATCHDOG", tag, "screencast stalled, restart", restarts);
    if (restarts > 2) { shotMode = true; send("Page.stopScreencast"); shotLoop(); return; }
    lastFrame = Date.now();
    await send("Page.stopScreencast"); await send("Page.bringToFront"); await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
  }, 400).unref();
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const key = (type, k) => send("Input.dispatchKeyEvent", { type, key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  return {
    tag, frames, logs, send, proc: p,
    nav: (url) => send("Page.navigate", { url }),
    async cast(on) {
      if (on && !casting) { casting = true; lastFrame = Date.now(); if (shotMode) { shotLoop(); return; } await send("Page.bringToFront"); await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 }); }
      else if (!on && casting) { casting = false; await send("Page.stopScreencast"); }
    },
    async hold(k, ms) { await key("rawKeyDown", k); await sleep(ms); await key("keyUp", k); },
    async press(k) { await key("rawKeyDown", k); await sleep(70); await key("keyUp", k); },
    /** Left-drag on the 3D canvas: orbits the camera. */
    async drag(x0, y0, x1, y1, ms = 900) {
      await mouse("mouseMoved", x0, y0, { buttons: 0 }); await mouse("mousePressed", x0, y0);
      const n = Math.max(6, Math.round(ms / 30));
      for (let i = 1; i <= n; i++) { await mouse("mouseMoved", x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); await sleep(ms / n); }
      await mouse("mouseReleased", x1, y1);
    },
    wheel: (x, y, dy) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }),
    async js(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; },
    clickText: function (re, sel = "button") { return this.js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>${re}.test(x.textContent||""));if(!b)return false;b.click();return (b.textContent||"").trim().slice(0,60)})()`); },
    close() { try { p.kill(); } catch {} },
  };
}
const snap = async () => (await fetch(`${API}/api/rooms/VICE-42/snapshot`)).json();
const live = (s, nick) => s.characters.find((c) => c.nickname === nick && !["CAPTURED", "ARCHIVED"].includes(c.status));
/** Walks with the chase camera at its default yaw, where W is north (-z) and D is east (+x). Nudges sideways if stuck. */
async function walkTo(P, nick, tx, tz, maxSteps = 70, near = 1.5) {
  let last = null, stuck = 0;
  for (let i = 0; i < maxSteps; i++) {
    const c = live(await snap(), nick); if (!c) return false;
    const dx = tx - c.x, dz = tz - c.z; if (Math.hypot(dx, dz) < near) return true;
    if (last && Math.hypot(c.x - last.x, c.z - last.z) < 0.15) stuck++; else stuck = 0;
    last = { x: c.x, z: c.z };
    let k = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "d" : "a") : (dz > 0 ? "s" : "w");
    if (stuck >= 2) { k = "wasd"[(i + stuck) % 4]; stuck = 0; await P.hold(k, 350); continue; }
    await P.hold(k, Math.min(500, Math.max(70, (Math.max(Math.abs(dx), Math.abs(dz)) / 9) * 800)));
  }
  return false;
}
const route = async (P, nick, pts) => { for (const [x, z] of pts) if (!(await walkTo(P, nick, x, z, 45, 2.2))) return false; return true; };
const fpsOf = (fr, t0, t1) => { const f = fr.filter((x) => x.t >= t0 && x.t <= t1); return f.length > 1 ? Number((f.length / ((t1 - t0) / 1000)).toFixed(1)) : 0; };
const SHORT = !!process.env.SHORT; // dry run: stops after the capture
const all = () => ({ framesA: A?.frames ?? [], framesB: B?.frames ?? [], framesC: C?.frames ?? [], framesD: D2?.frames ?? [] });

let A, B, C, D2;
try {
  let s = await snap();
  const ryder = s.characters.find((c) => /^Ryder/i.test(c.nickname) && c.role === "OUTLAW");
  A = await browser(9441, "A");
  await A.nav(`${BASE}/?nick=Ace&role=OUTLAW&room=VICE-42&auto=1&view=3d`);
  await sleep(6000);
  C = await browser(9443, "C");
  await C.nav(`${BASE}/?nick=Judge&role=SPECTATOR&room=VICE-42&auto=1&view=3d`);
  await sleep(6000);
  // Shot: the whole city from the spectator's orbit camera (many labelled NPCs in frame).
  await C.cast(true);
  mark("city", { ryder: ryder ? ryder.ticker : null });
  await C.drag(500, 300, 760, 330, 5000);
  await sleep(1500);
  await C.cast(false);
  // Two hunters join as one crew. Both pages are driven; only B is recorded.
  B = await browser(9442, "B");
  await B.nav(`${BASE}/?nick=Rio&role=HUNTER&room=VICE-42&auto=1&view=3d&crew=WOLF`);
  await sleep(6000);
  D2 = await browser(9444, "D");
  await D2.nav(`${BASE}/?nick=Vex&role=HUNTER&room=VICE-42&auto=1&view=3d&crew=WOLF`);
  await sleep(6000);
  s = await snap();
  mark("crewinfo", { crews: (s.crews ?? []).map((c) => [c.name, c.memberPlayerIds.length]), hunters: s.characters.filter((c) => c.role === "HUNTER").map((c) => [c.nickname, Math.round(c.x), Math.round(c.z), c.crewName ?? null]) });
  await A.cast(true); await B.cast(true);
  mark("two");
  await Promise.all([
    (async () => { await A.hold("d", 900); await sleep(400); await A.hold("a", 900); await sleep(400); await A.hold("w", 500); await sleep(300); await A.hold("s", 500); })(),
    (async () => { await B.hold("s", 1300); await sleep(400); await B.hold("a", 900); await sleep(300); await B.hold("d", 900); })(),
  ]);
  await sleep(1200);
  mark("twoend");
  await B.cast(false);
  // Hunters walk to a staging point south-east of the dock (unrecorded on their pages; A keeps recording).
  const hx = live(await snap(), "Rio");
  const legs = hx && hx.z < 40 ? [[hx.x, 54], [61, 55], [61, 66]] : [[61, 55], [61, 66]];
  const staged = await Promise.all([route(B, "Rio", legs), (async () => { await sleep(1200); return route(D2, "Vex", [...legs.slice(0, -1), [64, 64]]); })()]);
  mark("staged", { staged });
  // Shot: the job, from the outlaw's own page, chase camera.
  s = await snap();
  const m = s.missions.find((x) => x.status === "AVAILABLE");
  mark("job", { mission: [m.x, m.z], priceBefore: s.listings.find((l) => l.status === "ACTIVE" && /^ACE/.test(l.ticker))?.spotPrice });
  const reached = await walkTo(A, "Ace", m.x, m.z);
  await A.press("e");
  mark("jobdone", { reached });
  save(all());
  await sleep(4500);
  // Shot: the hunt. The outlaw fires (seen by NPCs -> Drex cards), hunters close in, stun, capture.
  await B.cast(true);
  mark("hunt0");
  await A.press("f");
  mark("outlawshot");
  await sleep(3500);
  await A.press("c"); // high-angle preset: more of the street and the NPCs in frame while cards resolve
  await sleep(3500);
  let ace = live(await snap(), "Ace");
  if (ace && !ace.wanted) { await A.press("f"); await sleep(2600); await A.press("f"); await sleep(2200); ace = live(await snap(), "Ace"); }
  mark("wanted", { wanted: !!ace?.wanted, heat: ace?.heat });
  await A.press("c"); await sleep(250); await A.press("c"); await sleep(250); await A.press("c"); // back to chase
  // Hunters approach from the south so the outlaw is in front of their chase cameras.
  if (ace) await Promise.all([walkTo(B, "Rio", ace.x, ace.z + 7, 30, 2.5), (async () => { await sleep(600); return walkTo(D2, "Vex", ace.x + 6, ace.z + 9, 30, 3.5); })()]);
  let captured = false;
  for (let i = 0; i < 6 && !captured; i++) {
    await B.press("f"); mark("huntershot", { i });
    await sleep(700);
    ace = live(await snap(), "Ace");
    if (ace) { const h = live(await snap(), "Rio"); if (h && Math.hypot(h.x - ace.x, h.z - ace.z) > 2.2) await walkTo(B, "Rio", ace.x, ace.z + 1.2, 10, 1.9); }
    await B.press("e");
    await sleep(600);
    s = await snap();
    captured = s.characters.some((c) => c.nickname === "Ace" && c.status === "CAPTURED");
    if (!captured) await sleep(1900);
  }
  const t0 = Date.now();
  while (!captured && Date.now() - t0 < 45000) { s = await snap(); captured = s.characters.some((c) => c.nickname === "Ace" && c.status === "CAPTURED"); await sleep(300); }
  s = await snap();
  const capEv = s.recentEvents.filter((e) => e.type === "CAPTURE_SUCCEEDED").pop();
  mark("crash", { captured, listing: s.listings.map((l) => [l.ticker, l.status, l.spotPrice]), by: capEv ? [[capEv.payload.captorName, capEv.payload.bounty, capEv.payload.survivalSeconds]] : [], crew: capEv ? { crewName: capEv.payload.crewName ?? null, doubleCross: !!capEv.payload.doubleCross, payouts: capEv.payload.payouts ?? capEv.payload.shares ?? null, captorKind: capEv.payload.captorKind } : null,
    weapon: s.recentEvents.filter((e) => e.type === "WEAPON_FIRED" || e.type === "STUNNED").map((e) => [e.type, e.payload.shooterKind ?? e.payload.targetKind, e.payload.hitKind ?? null]) });
  mark("hunt1");
  save(all());
  await sleep(7500);
  await B.cast(false);
  mark("halted");
  if (SHORT) throw new Error("short run end");
  B.close(); D2.close();
  const rej = await A.clickText("/BUY 1/");
  mark("rejected", { clicked: rej });
  await sleep(3000);
  mark("respawn");
  await A.press("r");
  await sleep(1500);
  await A.press("v");
  await A.hold("w", 900); await sleep(300); await A.hold("d", 900);
  await sleep(3000);
  mark("respawnend");
  // Inspector on the SPECTATOR page: an officer's memory, decision trace and policy citations.
  await C.cast(true);
  const chip = await C.clickText("/Duarte/", "button.chip");
  mark("inspect", { chip });
  await sleep(4000);
  await C.js(`(()=>{const el=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+40&&getComputedStyle(e).overflowY!=='visible'&&e.closest('.inspector, [class*=inspect], [class*=agent]'));const t=el[el.length-1];if(t){t.scrollBy({top:260,behavior:'smooth'});return t.className}return null})()`);
  await sleep(4500);
  mark("inspectend");
  await C.cast(false);
  s = await snap();
  mark("proof", { listings: s.listings.map((l) => [l.ticker, l.status, l.spotPrice]), metrics: s.metrics.decisions, latency: s.metrics.latency, shadow: s.metrics.shadow, trades: s.trades.map((t) => [t.actorName, t.side, t.ticker, t.executionPrice]) });
  await A.clickText("/DEMO DIRECTOR/");
  await sleep(2500);
  const exp = await A.clickText("/Run scripted/");
  console.log("experiment button:", exp);
  const t1 = Date.now(); let done = null;
  while (exp && Date.now() - t1 < 60000) {
    const xs = await (await fetch(`${API}/api/experiments`)).json();
    done = xs.find((x) => x.status === "DONE"); if (done) break;
    await sleep(700);
  }
  mark("expdone", { rows: done?.rows?.map((r) => ({ mode: r.mode, calls: r.realProviderCalls, p50: r.latencyP50Ms, p95: r.latencyP95Ms, trades: r.npcTrades, captured: r.captured })) });
  await sleep(1500);
  await A.js(`(()=>{const el=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+30&&getComputedStyle(e).overflowY!=='visible'&&e.querySelector('.exp-head'));const t=el[el.length-1];if(t){const h=t.querySelector('.exp-head');h.scrollIntoView({block:'start',behavior:'smooth'});return t.className}return null})()`);
  await sleep(5500);
  mark("proofend");
  await A.cast(false);
  await C.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 450, deviceScaleFactor: 2, mobile: false });
  await C.nav(`${API}/api/rooms/VICE-42/replay/verify`);
  await sleep(1500);
  const r = await C.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/verify.png`, Buffer.from(r.result.data, "base64"));
  const v = await (await fetch(`${API}/api/rooms/VICE-42/replay/verify`)).json();
  mark("verify", { ok: v.ok, source: v.source, events: v.eventCount, mismatches: v.mismatches.length });
} catch (e) { console.error("DRIVER END/ERROR", String(e).slice(0, 300)); }
finally {
  try {
    const evs = await (await fetch(`${API}/api/rooms/VICE-42/events?limit=1000`)).json();
    const T = Object.fromEntries(marks.map((m) => [m.name, m.t]));
    const rates = { city: C && T.city ? fpsOf(C.frames, T.city, T.city + 6500) : 0, two_A: T.two && T.twoend ? fpsOf(A.frames, T.two, T.twoend) : 0, two_B: T.two && T.twoend ? fpsOf(B.frames, T.two, T.twoend) : 0, job_A: T.job && T.hunt0 ? fpsOf(A.frames, T.job, T.hunt0) : 0, hunt_A: T.hunt0 && T.hunt1 ? fpsOf(A.frames, T.hunt0, T.hunt1) : 0, crash_A: T.hunt1 && T.halted ? fpsOf(A.frames, T.hunt1, T.halted) : 0 };
    console.log("CAPTURE FPS", JSON.stringify(rates));
    save({ ...all(), rates, events: evs.events.map((e) => ({ type: e.type, t: Date.parse(e.time), actor: e.actorId, p: e.type === "DECISION_RESOLVED" ? { src: e.payload.decisionSource, role: e.payload.role, action: e.payload.chosenAction, ms: e.payload.latencyMs } : ["TRADE_REJECTED", "WEAPON_FIRED", "STUNNED", "CAPTURE_SUCCEEDED", "CREW_JOINED", "CREW_BETRAYED", "CREW_TIP", "OUTLAW_WARNED"].includes(e.type) ? e.payload : undefined })), logsA: A?.logs, logsB: B?.logs, logsC: C?.logs });
  } catch (e) { console.error("SAVE ERROR", String(e)); try { save(all()); } catch {} }
  for (const k of kids) { try { k.kill(); } catch {} }
  process.exit(0);
}
