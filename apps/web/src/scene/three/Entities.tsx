import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { MessageKind, NpcActivity, NpcRole } from "@vice/contracts";

export const ROLE_COLOR: Record<NpcRole, string> = { WITNESS: "#ffd166", INFORMANT: "#c77dff", TRADER: "#3dffc8", POLICE: "#4d8dff" };
export const KIND_COLOR: Record<MessageKind, string> = { REPORT: "#4d8dff", GOSSIP: "#ff4fa3", RELAY: "#ffc46b", BULLETIN: "#ff5555" };

const labelBase: React.CSSProperties = {
  pointerEvents: "none", userSelect: "none", whiteSpace: "nowrap", textAlign: "center",
  font: "600 11px/1.25 'Avenir Next','Segoe UI',Helvetica,Arial,sans-serif", color: "#fff",
  padding: "2px 7px", borderRadius: 6, background: "rgba(14,8,28,0.72)", border: "1px solid rgba(255,255,255,0.18)",
  textShadow: "0 1px 2px #000",
};

/** Smoothly moves a group toward (x, z) and reports horizontal speed for walk animation. */
function useGlide(x: number, z: number) {
  const ref = useRef<THREE.Group>(null);
  const speed = useRef(0);
  const init = useRef(false);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (!init.current) { g.position.set(x, 0, z); init.current = true; return; }
    const k = Math.min(1, dt * 10);
    const dx = (x - g.position.x) * k, dz = (z - g.position.z) * k;
    g.position.x += dx; g.position.z += dz;
    const v = Math.hypot(dx, dz) / Math.max(dt, 0.001);
    speed.current += (v - speed.current) * 0.2;
    if (v > 0.4) {
      const target = Math.atan2(dx, dz);
      let d = target - g.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      g.rotation.y += d * Math.min(1, dt * 12);
    }
  });
  return { ref, speed };
}

export interface Outfit { top: string; legs: string; skin: string; hair: string; hat?: string }
const SKINS = ["#f0c8a4", "#d9a47a", "#b07a52", "#8a5a3a", "#6b4428"], HAIRS = ["#1b1512", "#3a2516", "#6b4a2a", "#111318", "#8a6a3a"];
export function outfitFor(id: string, top: string, legs = "#23242c", hat?: string): Outfit {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { top, legs, skin: SKINS[h % SKINS.length]!, hair: HAIRS[(h >> 3) % HAIRS.length]!, hat };
}

/** Articulated figure (hips, torso, head, two-segment arms and legs) with a speed-driven walk cycle. */
function Figure({ outfit, speed, dim = false }: { outfit: Outfit; speed: React.RefObject<number>; dim?: boolean }) {
  const root = useRef<THREE.Group>(null), torso = useRef<THREE.Group>(null);
  const hipL = useRef<THREE.Group>(null), hipR = useRef<THREE.Group>(null), kneeL = useRef<THREE.Group>(null), kneeR = useRef<THREE.Group>(null);
  const shL = useRef<THREE.Group>(null), shR = useRef<THREE.Group>(null), elL = useRef<THREE.Group>(null), elR = useRef<THREE.Group>(null);
  const phase = useRef(Math.random() * 6);
  useFrame(({ clock }, dt) => {
    const v = speed.current ?? 0, s = Math.min(1, v / 3.5), run = Math.min(1, Math.max(0, (v - 5) / 4));
    phase.current += dt * (4.5 + v * 1.25);
    const p = phase.current, a = Math.sin(p), amp = (0.55 + run * 0.35) * s;
    if (hipL.current) hipL.current.rotation.x = -a * amp;
    if (hipR.current) hipR.current.rotation.x = a * amp;
    if (kneeL.current) kneeL.current.rotation.x = Math.max(0, Math.cos(p)) * (0.9 + run * 0.5) * s + 0.04;
    if (kneeR.current) kneeR.current.rotation.x = Math.max(0, -Math.cos(p)) * (0.9 + run * 0.5) * s + 0.04;
    if (shL.current) shL.current.rotation.x = a * amp * 0.9;
    if (shR.current) shR.current.rotation.x = -a * amp * 0.9;
    const bend = -(0.15 + s * (0.5 + run * 0.6));
    if (elL.current) elL.current.rotation.x = bend;
    if (elR.current) elR.current.rotation.x = bend;
    if (root.current) root.current.position.y = Math.abs(Math.cos(p)) * 0.05 * s;
    if (torso.current) {
      torso.current.rotation.x = 0.04 + s * 0.08 + run * 0.14;
      torso.current.rotation.y = a * 0.12 * s;
      torso.current.position.y = 1.0 + Math.sin(clock.elapsedTime * 1.6 + phase.current * 0) * 0.008 * (1 - s); // idle breathing
    }
  });
  const top = dim ? "#55525e" : outfit.top, legs = dim ? "#3a3840" : outfit.legs, skin = outfit.skin;
  const M = ({ c, r = 0.75 }: { c: string; r?: number }) => <meshStandardMaterial color={c} roughness={r} />;
  const leg = (hip: React.RefObject<THREE.Group | null>, knee: React.RefObject<THREE.Group | null>, x: number) => (
    <group ref={hip} position={[x, 0.98, 0]}>
      <mesh position={[0, -0.23, 0]} castShadow><capsuleGeometry args={[0.095, 0.3, 3, 8]} /><M c={legs} /></mesh>
      <group ref={knee} position={[0, -0.47, 0]}>
        <mesh position={[0, -0.22, 0]} castShadow><capsuleGeometry args={[0.08, 0.3, 3, 8]} /><M c={legs} /></mesh>
        <mesh position={[0, -0.47, 0.06]} castShadow><boxGeometry args={[0.15, 0.09, 0.3]} /><M c="#141418" r={0.5} /></mesh>
      </group>
    </group>
  );
  const arm = (sh: React.RefObject<THREE.Group | null>, el: React.RefObject<THREE.Group | null>, x: number) => (
    <group ref={sh} position={[x, 0.5, 0]} rotation={[0, 0, x > 0 ? 0.08 : -0.08]}>
      <mesh position={[0, -0.16, 0]} castShadow><capsuleGeometry args={[0.07, 0.22, 3, 8]} /><M c={top} /></mesh>
      <group ref={el} position={[0, -0.33, 0]}>
        <mesh position={[0, -0.14, 0]} castShadow><capsuleGeometry args={[0.058, 0.2, 3, 8]} /><M c={skin} /></mesh>
        <mesh position={[0, -0.31, 0]}><sphereGeometry args={[0.065, 8, 6]} /><M c={skin} /></mesh>
      </group>
    </group>
  );
  return (
    <group ref={root} scale={1.12}>
      {leg(hipL, kneeL, -0.115)}
      {leg(hipR, kneeR, 0.115)}
      <mesh position={[0, 0.97, 0]} castShadow><boxGeometry args={[0.36, 0.2, 0.22]} /><M c={legs} /></mesh>
      <group ref={torso} position={[0, 1.0, 0]}>
        <mesh position={[0, 0.3, 0]} castShadow><boxGeometry args={[0.44, 0.56, 0.25]} /><M c={top} /></mesh>
        <mesh position={[0, 0.54, 0]} castShadow><boxGeometry args={[0.52, 0.12, 0.26]} /><M c={top} /></mesh>
        {arm(shL, elL, -0.3)}
        {arm(shR, elR, 0.3)}
        <mesh position={[0, 0.66, 0]}><cylinderGeometry args={[0.06, 0.07, 0.1, 8]} /><M c={skin} /></mesh>
        <mesh position={[0, 0.82, 0.01]} castShadow scale={[0.9, 1.08, 1]}><sphereGeometry args={[0.135, 14, 12]} /><M c={skin} r={0.6} /></mesh>
        <mesh position={[0, 0.87, -0.02]} scale={[0.95, 0.9, 1.02]}><sphereGeometry args={[0.142, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55]} /><M c={outfit.hair} r={0.9} /></mesh>
        {outfit.hat && <>
          <mesh position={[0, 0.95, 0]}><cylinderGeometry args={[0.15, 0.155, 0.09, 12]} /><M c={outfit.hat} /></mesh>
          <mesh position={[0, 0.915, 0.13]}><boxGeometry args={[0.2, 0.02, 0.14]} /><M c={outfit.hat} /></mesh>
        </>}
      </group>
    </group>
  );
}

function SelectRing({ color }: { color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => { if (ref.current) { ref.current.rotation.z = clock.elapsedTime * 1.5; const s = 1 + Math.sin(clock.elapsedTime * 5) * 0.06; ref.current.scale.set(s, s, 1); } });
  return <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}><ringGeometry args={[1.05, 1.3, 6]} /><meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.9} side={THREE.DoubleSide} /></mesh>;
}

export interface HumanProps {
  id: string; x: number; z: number; nickname: string; ticker: string | null; role: "OUTLAW" | "HUNTER";
  heat: number; wanted: boolean; captured: boolean; isYou: boolean; selected: boolean; price: number | null;
  onSelect: (id: string) => void;
}
export function Human(p: HumanProps) {
  const { ref, speed } = useGlide(p.x, p.z);
  const glow = useRef<THREE.Mesh>(null);
  const color = p.role === "OUTLAW" ? "#ff4fa3" : "#35e6ff";
  const outfit = useMemo(() => p.role === "OUTLAW" ? outfitFor(p.id, "#c2255c", "#1c1d24") : outfitFor(p.id, "#1f6f8a", "#2a2f3a", "#16323d"), [p.id, p.role]);
  useFrame(({ clock }) => {
    if (!glow.current) return;
    const h = Math.min(1, p.heat / 100), pulse = p.wanted ? 0.75 + Math.sin(clock.elapsedTime * 8) * 0.25 : 1;
    const s = 0.9 + h * 2.2;
    glow.current.scale.set(s, s, 1);
    (glow.current.material as THREE.MeshBasicMaterial).opacity = (0.12 + h * 0.5) * pulse;
  });
  return (
    <group ref={ref} onClick={(e) => { e.stopPropagation(); p.onSelect(p.id); }}>
      <Figure outfit={outfit} speed={speed} dim={p.captured} />
      {!p.captured && p.heat > 0 && (
        <mesh ref={glow} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
          <circleGeometry args={[1, 24]} /><meshBasicMaterial color={p.wanted ? "#ff3b3b" : "#ff9a3c"} transparent opacity={0.3} toneMapped={false} depthWrite={false} />
        </mesh>
      )}
      {p.isYou && <mesh position={[0, 3.3, 0]} rotation={[Math.PI, 0, 0]}><coneGeometry args={[0.28, 0.55, 4]} /><meshBasicMaterial color="#ffffff" toneMapped={false} /></mesh>}
      {p.selected && <SelectRing color="#ffffff" />}
      <Html position={[0, 2.75, 0]} center zIndexRange={[20, 0]}>
        <div style={{ ...labelBase, borderColor: p.captured ? "#666" : color, opacity: p.captured ? 0.6 : 1 }}>
          <div>{p.isYou ? "YOU · " : ""}{p.nickname}{p.captured ? " · CAPTURED" : p.wanted ? " · WANTED" : ""}</div>
          {p.ticker && <div style={{ color: p.captured ? "#ff6b6b" : "#3dffc8", fontWeight: 700 }}>{p.ticker} {p.price === null ? "" : `V$${p.price}`}</div>}
        </div>
      </Html>
    </group>
  );
}

export interface NpcProps {
  id: string; x: number; z: number; name: string; role: NpcRole; activity: NpcActivity; thinking: boolean; selected: boolean;
  onSelect: (id: string) => void;
}
export function Npc(p: NpcProps) {
  const { ref, speed } = useGlide(p.x, p.z);
  const think = useRef<THREE.Mesh>(null), red = useRef<THREE.Mesh>(null), blue = useRef<THREE.Mesh>(null);
  const color = ROLE_COLOR[p.role];
  const pursuing = p.role === "POLICE" && p.activity === "PURSUE";
  const outfit = useMemo(() => p.role === "POLICE" ? outfitFor(p.id, "#1c2c55", "#131a30", "#0f1730")
    : p.role === "TRADER" ? outfitFor(p.id, "#e9e6df", "#2b2d36")
    : p.role === "INFORMANT" ? outfitFor(p.id, "#4a2f66", "#1b1b22", "#2a1b3a")
    : outfitFor(p.id, "#c98f2e", "#3b4a5c"), [p.id, p.role]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (think.current) { think.current.rotation.y = t * 4; think.current.position.y = 3.25 + Math.sin(t * 5) * 0.12; }
    const on = Math.floor(t * 6) % 2 === 0;
    if (red.current) red.current.visible = on;
    if (blue.current) blue.current.visible = !on;
  });
  return (
    <group ref={ref} onClick={(e) => { e.stopPropagation(); p.onSelect(p.id); }}>
      <Figure outfit={outfit} speed={speed} />
      {p.role === "POLICE" && (
        <group position={[0, 2.3, 0]}>
          {pursuing && <>
            <mesh ref={red} position={[-0.2, 0.14, 0]}><boxGeometry args={[0.3, 0.16, 0.26]} /><meshBasicMaterial color={[4, 0.3, 0.3]} toneMapped={false} /></mesh>
            <mesh ref={blue} position={[0.2, 0.14, 0]}><boxGeometry args={[0.3, 0.16, 0.26]} /><meshBasicMaterial color={[0.3, 0.8, 4]} toneMapped={false} /></mesh>
            <pointLight color="#ff4466" intensity={40} distance={16} position={[0, 0.4, 0]} />
          </>}
        </group>
      )}
      {p.thinking && <mesh ref={think} position={[0, 3.25, 0]}><octahedronGeometry args={[0.28]} /><meshBasicMaterial color="#ffffff" toneMapped={false} wireframe /></mesh>}
      {p.selected && <SelectRing color={color} />}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}><ringGeometry args={[0.7, 0.85, 20]} /><meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.7} side={THREE.DoubleSide} /></mesh>
      <Html position={[0, 2.8, 0]} center zIndexRange={[10, 0]}>
        <div style={{ ...labelBase, borderColor: color, fontSize: 10 }}>
          <span style={{ color, fontWeight: 800 }}>{p.role}</span> {p.name}{p.thinking ? " …" : ""}{p.activity === "PURSUE" ? " · PURSUIT" : p.activity === "INVESTIGATE" ? " · INVESTIGATING" : ""}
        </div>
      </Html>
    </group>
  );
}

export function MissionBeacon({ x, z, label }: { x: number; z: number; label: string }) {
  const ring = useRef<THREE.Mesh>(null), beam = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (ring.current) { ring.current.rotation.z = t * 1.2; ring.current.scale.setScalar(1 + Math.sin(t * 3) * 0.08); }
    if (beam.current) (beam.current.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.sin(t * 3) * 0.08;
  });
  return (
    <group position={[x, 0, z]}>
      <mesh ref={beam} position={[0, 9, 0]}><cylinderGeometry args={[0.35, 0.9, 18, 12, 1, true]} /><meshBasicMaterial color="#ffe14d" transparent opacity={0.25} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}><ringGeometry args={[2.1, 2.5, 8]} /><meshBasicMaterial color="#ffe14d" toneMapped={false} side={THREE.DoubleSide} /></mesh>
      <mesh position={[0, 0.5, 0]} rotation={[0, 0.6, 0]}><boxGeometry args={[0.8, 0.6, 0.55]} /><meshStandardMaterial color="#ffe14d" emissive="#ffb400" emissiveIntensity={0.9} /></mesh>
      <Html position={[0, 2.1, 0]} center zIndexRange={[5, 0]}><div style={{ ...labelBase, borderColor: "#ffe14d", color: "#ffe14d" }}>◆ {label}</div></Html>
    </group>
  );
}

/** A glowing arc with a travelling pulse: one recorded message between two agents. */
export function MessageArc({ from, to, kind, startedAtMs, durationMs }: { from: { x: number; z: number }; to: { x: number; z: number }; kind: MessageKind; startedAtMs: number; durationMs: number }) {
  const dot = useRef<THREE.Mesh>(null);
  const color = KIND_COLOR[kind];
  const { line, curve } = useMemo(() => {
    const a = new THREE.Vector3(from.x, 2.2, from.z), b = new THREE.Vector3(to.x, 2.2, to.z);
    const mid = a.clone().add(b).multiplyScalar(0.5); mid.y = 5 + a.distanceTo(b) * 0.28;
    const c = new THREE.QuadraticBezierCurve3(a, mid, b);
    const geo = new THREE.BufferGeometry().setFromPoints(c.getPoints(28));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false }));
    return { line: l, curve: c };
    // endpoints are captured at send time on purpose: the arc shows where the message was sent from/to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAtMs]);
  useFrame(() => {
    const t = (Date.now() - startedAtMs) / durationMs;
    (line.material as THREE.LineBasicMaterial).opacity = t < 1 ? 0.9 : Math.max(0, 0.9 - (t - 1) * 3);
    if (dot.current) { dot.current.visible = t <= 1; dot.current.position.copy(curve.getPoint(Math.min(1, Math.max(0, t)))); }
  });
  return (
    <group>
      <primitive object={line} />
      <mesh ref={dot}><sphereGeometry args={[0.38, 10, 8]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
    </group>
  );
}

export function CaptureBurst({ x, z, startedAtMs }: { x: number; z: number; startedAtMs: number }) {
  const ring = useRef<THREE.Mesh>(null), beam = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const t = Math.min(1, (Date.now() - startedAtMs) / 1800);
    if (ring.current) { ring.current.scale.setScalar(1 + t * 14); (ring.current.material as THREE.MeshBasicMaterial).opacity = 1 - t; }
    if (beam.current) { beam.current.scale.set(1 - t * 0.7, 1, 1 - t * 0.7); (beam.current.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.7; }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]}><ringGeometry args={[0.8, 1, 32]} /><meshBasicMaterial color="#ff3b3b" transparent toneMapped={false} side={THREE.DoubleSide} depthWrite={false} /></mesh>
      <mesh ref={beam} position={[0, 12, 0]}><cylinderGeometry args={[1.2, 1.2, 24, 16, 1, true]} /><meshBasicMaterial color="#ff3b3b" transparent toneMapped={false} side={THREE.DoubleSide} depthWrite={false} /></mesh>
      <Html position={[0, 4.2, 0]} center><div style={{ ...labelBase, borderColor: "#ff3b3b", color: "#ff6b6b", fontSize: 14, fontWeight: 800 }}>CAPTURED · V$0</div></Html>
    </group>
  );
}
