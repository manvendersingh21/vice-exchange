import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { MessageKind } from "@vice/contracts";
import type { CityViewProps } from "../types";
import { webglAvailable } from "./SceneBoundary";
import { World } from "./World";
import { CaptureBurst, Human, MessageArc, MissionBeacon, Npc } from "./Entities";

interface Arc { id: string; from: { x: number; z: number }; to: { x: number; z: number }; kind: MessageKind; startedAtMs: number; durationMs: number }
interface Burst { id: string; x: number; z: number; startedAtMs: number }
const ARC_MS = 1100, ARC_LINGER_MS = 500, BURST_MS = 2600;

/** Fixed-heading follow camera: north stays "up", so WASD matches the 2D view. */
function FollowCamera({ target }: { target: { x: number; z: number } }) {
  const { camera } = useThree();
  const focus = useRef(new THREE.Vector3(target.x, 1.2, target.z));
  const first = useRef(true);
  useFrame((_, dt) => {
    const k = first.current ? 1 : Math.min(1, dt * 5);
    first.current = false;
    focus.current.x += (target.x - focus.current.x) * k;
    focus.current.z += (target.z - focus.current.z) * k;
    camera.position.set(focus.current.x, 12.5, focus.current.z + 23);
    camera.lookAt(focus.current.x, 2.2, focus.current.z - 6);
  });
  return null;
}

export default function ThreeCity(props: CityViewProps) {
  const { map, characters, npcs, missions, listings, tick, events, youCharacterId, selectedId, onSelect } = props;
  if (!webglAvailable()) throw new Error("WebGL unavailable"); // the scene boundary falls back to 2D

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
        dpr={[1, 1.5]}
        camera={{ fov: 48, near: 0.5, far: 900, position: [map.width / 2, 62, map.height + 52] }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onPointerMissed={() => onSelect(null, null)}
      >
        <World map={map} />
        {you ? <FollowCamera target={youTarget.current} /> : (
          <OrbitControls makeDefault target={[map.width / 2, 0, map.height / 2 - 4]} maxPolarAngle={Math.PI / 2.15} minDistance={18} maxDistance={190} enablePan />
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
      <div style={{ position: "absolute", left: 10, bottom: 8, font: "600 10px 'Avenir Next','Segoe UI',sans-serif", color: "rgba(255,255,255,0.6)", pointerEvents: "none", letterSpacing: 1 }}>
        {map.name.toUpperCase()} · 3D{you ? "" : " · DRAG TO ORBIT"}
      </div>
    </div>
  );
}
