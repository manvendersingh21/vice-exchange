import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { segmentHitsRect, type MapView, type MessageKind } from "@vice/contracts";
import type { CityViewProps } from "../types";
import { webglAvailable } from "./SceneBoundary";
import { World } from "./World";
import { CaptureBurst, Human, MessageArc, MissionBeacon, Npc } from "./Entities";

interface Arc { id: string; from: { x: number; z: number }; to: { x: number; z: number }; kind: MessageKind; startedAtMs: number; durationMs: number }
interface Burst { id: string; x: number; z: number; startedAtMs: number }
type Quality = "high" | "low";
const ARC_MS = 1100, ARC_LINGER_MS = 500, BURST_MS = 2600, QUALITY_KEY = "vice.city3d.quality";

function loadQuality(): Quality { try { return localStorage.getItem(QUALITY_KEY) === "low" ? "low" : "high"; } catch { return "high"; } }

/** HDR pipeline: scene -> bloom (only values above 1.0, i.e. neon, lamps, lit windows, sun) -> ACES tone mapping. */
function PostFX({ onSlow }: { onSlow: () => void }) {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    const c = new EffectComposer(gl);
    c.addPass(new RenderPass(scene, camera));
    c.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.75, 1.0));
    c.addPass(new OutputPass());
    return c;
  }, [gl, scene, camera]);
  useEffect(() => { composer.setPixelRatio(gl.getPixelRatio()); composer.setSize(size.width, size.height); }, [composer, gl, size]);
  useEffect(() => () => composer.dispose(), [composer]);
  const slow = useRef({ t: 0, frames: 0, fired: false });
  useFrame((_, dt) => {
    composer.render(dt);
    // auto-degrade: sustained < 22 fps for 4 s switches to the light pipeline
    const s = slow.current;
    s.t += dt; s.frames++;
    if (s.t >= 4) { if (!s.fired && s.frames / s.t < 22 && !location.search.includes("noauto")) { s.fired = true; onSlow(); } s.t = 0; s.frames = 0; }
  }, 1);
  return null;
}

/** Cinematic third-person camera. Heading is fixed (north = away) so WASD matches the 2D view; it rises over buildings that would block the shot. */
function FollowCamera({ target, map }: { target: { x: number; z: number }; map: MapView }) {
  const { camera } = useThree();
  const focus = useRef(new THREE.Vector3(target.x, 0, target.z));
  const off = useRef(new THREE.Vector3(0, 6.2, 12.5));
  const vel = useRef(new THREE.Vector2());
  const first = useRef(true);
  useFrame(({ clock }, dt) => {
    const k = first.current ? 1 : 1 - Math.exp(-dt * 4.5);
    const px = focus.current.x, pz = focus.current.z;
    focus.current.x += (target.x - px) * k; focus.current.z += (target.z - pz) * k;
    if (!first.current && dt > 0) vel.current.lerp(new THREE.Vector2((focus.current.x - px) / dt, (focus.current.z - pz) / dt), 0.06);
    first.current = false;
    // pick the lowest shot whose sightline to the player clears every building
    const shots: Array<[number, number]> = [[6.2, 12.5], [11, 11], [17, 9], [25, 6.5]];
    let pick = shots[shots.length - 1]!;
    for (const s of shots) {
      const cam = { x: focus.current.x, z: focus.current.z + s[1] };
      const blocked = map.buildings.some((b) => b.height > s[0] * 0.55 && segmentHitsRect({ x: focus.current.x, z: focus.current.z }, cam, { x0: b.x0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, z1: b.z1 + 1 }));
      if (!blocked) { pick = s; break; }
    }
    const ko = 1 - Math.exp(-dt * 2.2);
    off.current.y += (pick[0] - off.current.y) * ko; off.current.z += (pick[1] - off.current.z) * ko;
    const lead = Math.min(1, vel.current.length() / 9);
    const sway = Math.sin(clock.elapsedTime * 0.5) * 0.12;
    camera.position.set(focus.current.x + vel.current.x * 0.22 + sway, off.current.y, focus.current.z + off.current.z);
    camera.lookAt(focus.current.x + vel.current.x * 0.35, 1.5, focus.current.z - 2.5 - lead * 2 + vel.current.y * 0.2);
    const pc = camera as THREE.PerspectiveCamera;
    const fov = 44 + lead * 6;
    if (Math.abs(pc.fov - fov) > 0.05) { pc.fov += (fov - pc.fov) * 0.08; pc.updateProjectionMatrix(); }
  });
  return null;
}

export default function ThreeCity(props: CityViewProps) {
  const { map, characters, npcs, missions, listings, tick, events, youCharacterId, selectedId, onSelect } = props;
  if (!webglAvailable()) throw new Error("WebGL unavailable"); // the scene boundary falls back to 2D
  const [quality, setQualityState] = useState<Quality>(loadQuality);
  const setQuality = (q: Quality) => { setQualityState(q); try { localStorage.setItem(QUALITY_KEY, q); } catch { /* private mode */ } };
  const high = quality === "high";

  // Freshest positions: tick overrides the views.
  const chars = useMemo(() => {
    const live = new Map(tick?.characters.map((c) => [c.id, c]) ?? []);
    return characters.filter((c) => c.status !== "ARCHIVED").map((c) => {
      const t = live.get(c.id);
      return t ? { ...c, x: t.x, z: t.z, heat: t.heat, status: t.status } : c;
    });
  }, [characters, tick]);
  const agents = useMemo(() => {
    const live = new Map(tick?.npcs.map((n) => [n.id, n]) ?? []);
    return npcs.map((n) => {
      const t = live.get(n.id);
      return { id: n.id, name: n.name, role: n.role, x: t?.x ?? n.x, z: t?.z ?? n.z, activity: t?.activity ?? n.activity, thinking: t?.pending ?? n.pendingDecisionId !== null };
    });
  }, [npcs, tick]);
  const priceByTicker = useMemo(() => new Map(listings.map((l) => [l.ticker, l.spotPrice])), [listings]);

  // Effects derived from the event stream (diffed by serverSequence; history on mount is not replayed).
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const lastSeq = useRef<number | null>(null);
  const posRef = useRef(new Map<string, { x: number; z: number }>());
  posRef.current = new Map([...chars.map((c) => [c.id, { x: c.x, z: c.z }] as const), ...agents.map((a) => [a.id, { x: a.x, z: a.z }] as const)]);
  useEffect(() => {
    const top = events.length ? events[events.length - 1]!.serverSequence : 0;
    if (lastSeq.current === null || top < lastSeq.current) { lastSeq.current = top; return; } // first load or room reset
    const since = lastSeq.current;
    lastSeq.current = top;
    const now = Date.now(), newArcs: Arc[] = [], newBursts: Burst[] = [];
    const arc = (id: string, fromId: string, toId: string, kind: MessageKind) => {
      const from = posRef.current.get(fromId), to = posRef.current.get(toId);
      if (from && to && fromId !== toId) newArcs.push({ id, from: { ...from }, to: { ...to }, kind, startedAtMs: now, durationMs: ARC_MS });
    };
    for (const e of events) {
      if (e.serverSequence <= since) continue;
      if (e.type === "AGENT_MESSAGE_SENT") { const p = e.payload as { messageId: string; senderId: string; recipientId: string; kind: MessageKind }; arc(p.messageId, p.senderId, p.recipientId, p.kind); }
      else if (e.type === "BULLETIN_PUBLISHED") { const p = e.payload as { bulletinId: string; issuedBy: string; recipientIds: string[] }; p.recipientIds.forEach((r) => arc(`${p.bulletinId}:${r}`, p.issuedBy, r, "BULLETIN")); }
      else if (e.type === "CAPTURE_SUCCEEDED") { const p = e.payload as { captureId: string; characterId: string }; const at = posRef.current.get(p.characterId); if (at) newBursts.push({ id: p.captureId, x: at.x, z: at.z, startedAtMs: now }); }
    }
    if (newArcs.length) setArcs((a) => [...a.filter((x) => now - x.startedAtMs < ARC_MS + ARC_LINGER_MS), ...newArcs]);
    if (newBursts.length) setBursts((b) => [...b.filter((x) => now - x.startedAtMs < BURST_MS), ...newBursts]);
  }, [events]);
  useEffect(() => {
    if (!arcs.length && !bursts.length) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setArcs((a) => a.filter((x) => now - x.startedAtMs < ARC_MS + ARC_LINGER_MS));
      setBursts((b) => b.filter((x) => now - x.startedAtMs < BURST_MS));
    }, 700);
    return () => clearTimeout(t);
  }, [arcs, bursts]);

  const you = youCharacterId ? chars.find((c) => c.id === youCharacterId && c.status !== "CAPTURED") ?? null : null;
  const youTarget = useRef({ x: 60, z: 40 });
  if (you) { youTarget.current.x = you.x; youTarget.current.z = you.z; }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#1a0f2e" }}>
      <Canvas
        key={quality}
        shadows={high ? "soft" : false}
        dpr={high ? [1, 1.75] : [1, 1]}
        camera={{ fov: 44, near: 0.3, far: 1400, position: [map.width / 2 - 30, 46, map.height + 46] }}
        gl={{ antialias: true, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
        onPointerMissed={() => onSelect(null, null)}
      >
        <World map={map} shadows={high} />
        {high && <PostFX onSlow={() => setQuality("low")} />}
        {you ? <FollowCamera target={youTarget.current} map={map} /> : (
          <OrbitControls makeDefault target={[map.width / 2, 2, map.height / 2 - 4]} maxPolarAngle={Math.PI / 2.08} minDistance={14} maxDistance={220} enablePan />
        )}
        {missions.filter((m) => m.status === "AVAILABLE").map((m) => <MissionBeacon key={m.id} x={m.x} z={m.z} label={m.label} />)}
        {agents.map((a) => (
          <Npc key={a.id} {...a} selected={selectedId === a.id} onSelect={(id) => onSelect(id, "npc")} />
        ))}
        {chars.map((c) => (
          <Human
            key={c.id} id={c.id} x={c.x} z={c.z} nickname={c.nickname} ticker={c.ticker} role={c.role}
            heat={c.heat} wanted={c.status === "WANTED"} captured={c.status === "CAPTURED"}
            isYou={c.id === youCharacterId} selected={selectedId === c.id}
            price={c.ticker ? priceByTicker.get(c.ticker) ?? null : null}
            onSelect={(id) => onSelect(id, "character")}
          />
        ))}
        {arcs.map((a) => <MessageArc key={a.id} from={a.from} to={a.to} kind={a.kind} startedAtMs={a.startedAtMs} durationMs={a.durationMs} />)}
        {bursts.map((b) => <CaptureBurst key={b.id} x={b.x} z={b.z} startedAtMs={b.startedAtMs} />)}
      </Canvas>
      <div style={{ position: "absolute", left: 10, bottom: 8, font: "600 10px 'Avenir Next','Segoe UI',sans-serif", color: "rgba(255,255,255,0.65)", pointerEvents: "none", letterSpacing: 1 }}>
        {map.name.toUpperCase()} · 3D{you ? "" : " · DRAG TO ORBIT"}
      </div>
      <button
        type="button" onClick={() => setQuality(high ? "low" : "high")} title="Toggle shadows, bloom and high-resolution rendering"
        style={{ position: "absolute", right: 10, bottom: 8, font: "700 10px 'Avenir Next','Segoe UI',sans-serif", letterSpacing: 1, color: "#fff", background: "rgba(14,8,28,0.7)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
      >
        QUALITY: {high ? "HIGH" : "LOW"}
      </button>
    </div>
  );
}
