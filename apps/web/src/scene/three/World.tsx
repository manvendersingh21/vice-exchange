import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { MISSION_SPOTS, type Building, type MapView } from "@vice/contracts";

export const TONES: Record<Building["tone"], { wall: string; neon: string }> = {
  pink: { wall: "#8a6f7c", neon: "#ff4fa3" },
  aqua: { wall: "#6c8794", neon: "#35e6ff" },
  purple: { wall: "#746c93", neon: "#a97bff" },
  sand: { wall: "#a08f7c", neon: "#ffc46b" },
  teal: { wall: "#5f8583", neon: "#3dffc8" },
};
/** Direction TO the sun (low, south-west): shared by the sky shader, the key light and reflections. */
export const SUN_DIR = new THREE.Vector3(-0.42, 0.3, 0.86).normalize();

export interface Inst { x: number; y: number; z: number; sx: number; sy: number; sz: number; color: string; rx?: number; ry?: number; rz?: number }
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

interface InstProps { items: Inst[]; shape?: "box" | "cyl" | "sphere"; glow?: number; opacity?: number; roughness?: number; metalness?: number; shadows?: boolean }
/** One draw call per kind. `glow` > 0 renders unlit HDR colour (value = brightness boost) so bloom picks it up. */
export function Instances({ items, shape = "box", glow = 0, opacity = 1, roughness = 0.85, metalness = 0.05, shadows = false }: InstProps) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      _e.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0, "YXZ");
      _m.compose(_p.set(it.x, it.y, it.z), _q.setFromEuler(_e), _s.set(it.sx, it.sy, it.sz));
      mesh.setMatrixAt(i, _m);
      _c.set(it.color);
      if (glow > 0) _c.multiplyScalar(glow);
      mesh.setColorAt(i, _c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items, glow]);
  if (items.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false} castShadow={shadows && glow === 0} receiveShadow={glow === 0}>
      {shape === "box" ? <boxGeometry args={[1, 1, 1]} /> : shape === "cyl" ? <cylinderGeometry args={[0.5, 0.5, 1, 12]} /> : <sphereGeometry args={[0.5, 12, 10]} />}
      {glow > 0
        ? <meshBasicMaterial toneMapped={false} transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 1} />
        : <meshStandardMaterial roughness={roughness} metalness={metalness} />}
    </instancedMesh>
  );
}

function hash(n: number): number { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  return [c, c.getContext("2d")!];
}
function tex(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Procedural facade: colour, emissive (lit rooms + storefront) and roughness/metalness (glass vs wall) maps. */
function facadeMaps(b: Building, seed: number) {
  const tone = TONES[b.tone];
  const span = Math.max(b.x1 - b.x0, b.z1 - b.z0);
  const cols = Math.max(2, Math.round(span / 1.7)), rows = Math.max(1, Math.round(b.height / 2.7));
  const W = 1024, H = 1024, cw = W / cols, rh = H / rows;
  const [cc, g] = canvas(W, H), [ec, eg] = canvas(W, H), [rc, rg] = canvas(W, H);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, tone.wall); grad.addColorStop(1, "#3d3742");
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${hash(seed + i) > 0.5 ? "255,255,255" : "0,0,0"},${0.02 + hash(seed * 3 + i) * 0.05})`; g.fillRect(hash(i * 7 + seed) * W, 0, 2 + hash(i) * 10, H); }
  eg.fillStyle = "#000"; eg.fillRect(0, 0, W, H);
  rg.fillStyle = "rgb(0,215,0)"; rg.fillRect(0, 0, W, H); // G = roughness, B = metalness
  for (let r = 0; r < rows; r++) {
    const ground = r === rows - 1;
    g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, r * rh, W, Math.max(2, rh * 0.035));
    g.fillStyle = "rgba(255,255,255,0.10)"; g.fillRect(0, r * rh + Math.max(2, rh * 0.035), W, 2);
    for (let c = 0; c < cols; c++) {
      const k = seed * 131 + r * 17 + c * 53;
      const x = c * cw + cw * 0.16, y = r * rh + rh * (ground ? 0.2 : 0.24), w = cw * 0.68, h = rh * (ground ? 0.72 : 0.52);
      const lit = ground ? hash(k) > 0.25 : hash(k) > 0.52;
      const warm = hash(k + 5) > 0.35;
      g.fillStyle = "#16181f"; g.fillRect(x - 3, y - 3, w + 6, h + 6);
      if (lit) {
        const col = ground ? tone.neon : warm ? `hsl(${32 + hash(k + 9) * 14},85%,${62 + hash(k + 2) * 14}%)` : `hsl(${195 + hash(k + 9) * 30},60%,70%)`;
        g.fillStyle = col; g.fillRect(x, y, w, h);
        eg.fillStyle = col; eg.globalAlpha = ground ? 1 : 0.55 + hash(k + 1) * 0.45; eg.fillRect(x, y, w, h); eg.globalAlpha = 1;
        g.fillStyle = "rgba(0,0,0,0.28)"; eg.fillStyle = "rgba(0,0,0,0.45)";
        const bh = h * hash(k + 3) * 0.6; g.fillRect(x, y, w, bh); eg.fillRect(x, y, w, bh);
        if (hash(k + 4) > 0.6) eg.fillRect(x + w * 0.3, y + h * 0.55, w * 0.22, h * 0.45);
      } else {
        const gg = g.createLinearGradient(x, y, x + w, y + h);
        gg.addColorStop(0, "#2c3a52"); gg.addColorStop(1, "#0d1220");
        g.fillStyle = gg; g.fillRect(x, y, w, h);
      }
      g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(x + w / 2 - 1.5, y, 3, h);
      rg.fillStyle = "rgb(0,28,150)"; rg.fillRect(x, y, w, h); // glass: smooth + reflective
    }
  }
  return { map: tex(cc, true), emissiveMap: tex(ec, true), orm: tex(rc, false) };
}

function signTexture(label: string, color: string): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 192);
  g.font = "800 112px 'Avenir Next', 'Segoe UI', Helvetica, Arial, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = color; g.shadowBlur = 44; g.fillStyle = color;
  g.fillText(label.toUpperCase(), 512, 100, 980); g.fillText(label.toUpperCase(), 512, 100, 980);
  g.shadowBlur = 0; g.fillStyle = "#ffffff"; g.globalAlpha = 0.9;
  g.fillText(label.toUpperCase(), 512, 100, 980);
  return tex(c, true);
}

/** Wet asphalt: roughness varies between dry aggregate and standing water. */
function asphaltMaps() {
  const S = 1024, [cc, g] = canvas(S, S), [rc, rg] = canvas(S, S);
  g.fillStyle = "#25242b"; g.fillRect(0, 0, S, S);
  rg.fillStyle = "rgb(0,150,0)"; rg.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const x = hash(i) * S, y = hash(i + 0.5) * S, v = 30 + hash(i * 3) * 40;
    g.fillStyle = `rgba(${v},${v},${v + 6},0.5)`; g.fillRect(x, y, 2, 2);
  }
  for (let i = 0; i < 70; i++) {
    const x = hash(i * 11) * S, y = hash(i * 13) * S, r = 20 + hash(i * 17) * 70;
    const pg = rg.createRadialGradient(x, y, 0, x, y, r);
    pg.addColorStop(0, "rgba(0,12,0,1)"); pg.addColorStop(0.7, "rgba(0,40,0,0.8)"); pg.addColorStop(1, "rgba(0,150,0,0)");
    rg.fillStyle = pg; rg.beginPath(); rg.ellipse(x, y, r * 1.6, r, hash(i) * 3, 0, 7); rg.fill();
    const dg = g.createRadialGradient(x, y, 0, x, y, r);
    dg.addColorStop(0, "rgba(8,8,14,0.7)"); dg.addColorStop(1, "rgba(8,8,14,0)");
    g.fillStyle = dg; g.beginPath(); g.ellipse(x, y, r * 1.6, r, hash(i) * 3, 0, 7); g.fill();
  }
  const m = tex(cc, true), r = tex(rc, false);
  for (const t of [m, r]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 2); }
  return { map: m, orm: r };
}

const SKY_VERT = "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }";
const SKY_FRAG = `varying vec3 vDir; uniform vec3 sunDir; uniform float boost;
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
  float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=0.5; } return s; }
  void main(){
    vec3 d = normalize(vDir);
    float h = max(d.y, 0.0);
    float s = max(dot(d, sunDir), 0.0);
    vec3 zenith = vec3(0.05, 0.07, 0.22);
    vec3 midSky = vec3(0.36, 0.20, 0.50);
    vec3 horizon = mix(vec3(0.95, 0.52, 0.42), vec3(1.25, 0.62, 0.30), pow(s, 3.0));
    vec3 col = mix(horizon, midSky, smoothstep(0.0, 0.22, h));
    col = mix(col, zenith, smoothstep(0.15, 0.75, h));
    col += vec3(1.0, 0.55, 0.25) * pow(s, 8.0) * 0.55;
    if (d.y > 0.01) {
      vec2 uv = d.xz / (d.y + 0.12) * 0.9;
      float c = smoothstep(0.52, 0.85, fbm(uv + vec2(3.1, 1.7)));
      vec3 cloud = mix(vec3(0.30, 0.16, 0.36), vec3(1.25, 0.60, 0.45), pow(s, 2.0) * 0.8 + 0.2);
      col = mix(col, cloud, c * smoothstep(0.02, 0.2, d.y) * 0.75);
      float star = step(0.9975, h21(floor(d.xz / (d.y + 0.2) * 220.0)));
      col += vec3(star) * smoothstep(0.45, 0.9, h) * 0.8;
    }
    col += vec3(1.0, 0.85, 0.6) * (smoothstep(0.9993, 0.9997, s) * 14.0 * boost + pow(s, 900.0) * 3.0);
    if (d.y < 0.0) col = mix(col, vec3(0.05, 0.07, 0.13), smoothstep(0.0, -0.08, d.y));
    gl_FragColor = vec4(col, 1.0);
  }`;
function skyMaterial(boost: number) {
  return new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, uniforms: { sunDir: { value: SUN_DIR }, boost: { value: boost } }, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG });
}

/** Sky dome + image-based lighting generated from that same sky (glass, water and wet roads reflect the sunset). */
function Atmosphere({ center }: { center: [number, number, number] }) {
  const { gl, scene } = useThree();
  const mat = useMemo(() => skyMaterial(1), []);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 20), skyMaterial(0.15)));
    const rt = pmrem.fromScene(envScene, 0.03);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.85;
    return () => { scene.environment = null; rt.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  return <mesh material={mat} scale={[600, 600, 600]} position={center}><sphereGeometry args={[1, 48, 24]} /></mesh>;
}

function BuildingMesh({ b, index, shadows }: { b: Building; index: number; shadows: boolean }) {
  const mats = useMemo(() => {
    const f = facadeMaps(b, index + 1);
    const side = new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissiveMap, emissive: new THREE.Color("#ffffff"), emissiveIntensity: 2.2, roughnessMap: f.orm, metalnessMap: f.orm, roughness: 1, metalness: 1, envMapIntensity: 1.2 });
    const roof = new THREE.MeshStandardMaterial({ color: "#2b2a31", roughness: 0.95 });
    return [side, side, roof, roof, side, side];
  }, [b, index]);
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  return <mesh material={mats} position={[(b.x0 + b.x1) / 2, b.height / 2, (b.z0 + b.z1) / 2]} castShadow={shadows} receiveShadow><boxGeometry args={[w, b.height, d]} /></mesh>;
}

function roadLines(map: MapView): { xs: number[]; zs: number[] } {
  const mids = (ranges: Array<[number, number]>, max: number): number[] => {
    const merged: Array<[number, number]> = [];
    for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 3) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]);
    }
    const out: number[] = []; let prev = 0;
    for (const r of merged) { out.push((prev + r[0]) / 2); prev = r[1]; }
    out.push((prev + max) / 2);
    return out;
  };
  return {
    xs: mids(map.buildings.filter((b) => b.x1 - b.x0 > 6).map((b) => [b.x0, b.x1]), map.width),
    zs: mids(map.buildings.filter((b) => b.z1 - b.z0 > 6).map((b) => [b.z0, b.z1]), map.walkable.z1 + 1),
  };
}

const CAR_COLORS = ["#b3202a", "#1f4fa8", "#e8e4da", "#17181c", "#d48a1c", "#2a8f7a", "#7a2a8f", "#9aa3ad"];

export function World({ map, shadows }: { map: MapView; shadows: boolean }) {
  const data = useMemo(() => {
    const A = () => [] as Inst[];
    const kerbs = A(), ledges = A(), neon = A(), marks = A(), trunks = A(), fronds = A(), metal = A(), lamps = A(), pools = A(), roofKit = A(), tanks = A();
    const wood = A(), carBody = A(), carGlass = A(), wheels = A(), head = A(), tail = A(), sigRed = A(), sigGreen = A(), bins = A(), planters = A(), shrubs = A();
    const inB = (x: number, z: number, pad: number) => map.buildings.some((b) => x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad);
    const z1 = map.walkable.z1;
    const keepClear = (x: number, z: number, r: number) => MISSION_SPOTS.some((m) => Math.hypot(m.x - x, m.z - z) < r);

    map.buildings.forEach((b, bi) => {
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, tone = TONES[b.tone];
      kerbs.push({ x: cx, y: 0.09, z: cz, sx: w + 3.4, sy: 0.18, sz: d + 3.4, color: "#77747c" });
      ledges.push({ x: cx, y: 0.3, z: cz, sx: w + 0.3, sy: 0.6, sz: d + 0.3, color: "#3a3840" });
      for (let y = 5.4; y < b.height - 1; y += 5.4) ledges.push({ x: cx, y, z: cz, sx: w + 0.36, sy: 0.16, sz: d + 0.36, color: "#4a4650" });
      for (const [px, pz, sx, sz] of [[cx, b.z0, w + 0.3, 0.3], [cx, b.z1, w + 0.3, 0.3], [b.x0, cz, 0.3, d + 0.3], [b.x1, cz, 0.3, d + 0.3]] as const)
        ledges.push({ x: px, y: b.height + 0.3, z: pz, sx, sy: 0.6, sz, color: "#45424b" });
      neon.push({ x: cx, y: b.height + 0.66, z: b.z1 + 0.05, sx: w + 0.3, sy: 0.1, sz: 0.1, color: tone.neon });
      neon.push({ x: b.x1 + 0.05, y: b.height + 0.66, z: cz, sx: 0.1, sy: 0.1, sz: d + 0.3, color: tone.neon });
      neon.push({ x: cx, y: 2.75, z: b.z1 + 0.5, sx: w * 0.8, sy: 0.08, sz: 0.08, color: tone.neon });
      ledges.push({ x: cx, y: 2.9, z: b.z1 + 0.45, sx: w * 0.82, sy: 0.14, sz: 1.0, color: "#2f2c36" });
      const n = Math.max(1, Math.floor((w * d) / 60));
      for (let i = 0; i < n; i++) {
        const rx = b.x0 + 1.5 + hash(bi * 7 + i) * (w - 3), rz = b.z0 + 1.5 + hash(bi * 11 + i) * (d - 3);
        if (i % 3 === 0) tanks.push({ x: rx, y: b.height + 1.2, z: rz, sx: 1.5, sy: 1.6, sz: 1.5, color: "#6d6a70" });
        else roofKit.push({ x: rx, y: b.height + 0.45, z: rz, sx: 1.6 + hash(i) * 1.2, sy: 0.9, sz: 1.2, color: "#8d9097", ry: hash(i + bi) > 0.5 ? 0 : Math.PI / 2 });
      }
      if (w > 6) roofKit.push({ x: cx + w * 0.25, y: b.height + 1.3, z: cz + d * 0.2, sx: 2.2, sy: 2.6, sz: 2.2, color: "#55525a" });
    });

    const { xs, zs } = roadLines(map);
    for (const x of xs) for (let z = 3; z < z1 - 1; z += 4) if (!inB(x, z, 2) && !zs.some((zz) => Math.abs(zz - z) < 5.5)) marks.push({ x, y: 0.012, z, sx: 0.16, sy: 0.02, sz: 2, color: "#d9c36a" });
    for (const z of zs) for (let x = 3; x < map.width - 2; x += 4) if (!inB(x, z, 2) && !xs.some((xx) => Math.abs(xx - x) < 5.5)) marks.push({ x, y: 0.012, z, sx: 2, sy: 0.02, sz: 0.16, color: "#d9c36a" });
    for (const x of xs) for (const z of zs) {
      if (inB(x, z, 1)) continue;
      for (let k = -3; k <= 3; k++) {
        marks.push({ x: x + k * 0.9, y: 0.012, z: z - 5.2, sx: 0.5, sy: 0.02, sz: 2.2, color: "#cfd2d6" });
        marks.push({ x: x + k * 0.9, y: 0.012, z: z + 5.2, sx: 0.5, sy: 0.02, sz: 2.2, color: "#cfd2d6" });
        marks.push({ x: x - 5.2, y: 0.012, z: z + k * 0.9, sx: 2.2, sy: 0.02, sz: 0.5, color: "#cfd2d6" });
        marks.push({ x: x + 5.2, y: 0.012, z: z + k * 0.9, sx: 2.2, sy: 0.02, sz: 0.5, color: "#cfd2d6" });
      }
      for (const [sx, sz] of [[-4.6, -4.6], [4.6, 4.6]] as const) {
        const px = x + sx, pz = z + sz;
        if (inB(px, pz, 0) || px < 1 || px > map.width - 1 || pz > z1 || pz < 1) continue;
        const red = hash(x + z) > 0.5;
        metal.push({ x: px, y: 2.4, z: pz, sx: 0.14, sy: 4.8, sz: 0.14, color: "#24262b" });
        metal.push({ x: px, y: 4.4, z: pz, sx: 0.38, sy: 1.0, sz: 0.38, color: "#15161a" });
        (red ? sigRed : sigGreen).push({ x: px, y: red ? 4.7 : 4.1, z: pz + (sz > 0 ? -0.2 : 0.2), sx: 0.22, sy: 0.22, sz: 0.08, color: red ? "#ff2a2a" : "#2aff7a" });
      }
    }

    let carN = 0;
    map.buildings.forEach((b, bi) => {
      if (b.x1 - b.x0 < 6) return;
      const pts: Array<[number, number, number]> = [];
      for (let x = b.x0 + 1; x <= b.x1 - 1; x += 5.5) { pts.push([x, b.z0 - 1.25, 0]); pts.push([x + 2.7, b.z1 + 1.25, 0]); }
      for (let z = b.z0 + 2; z <= b.z1 - 2; z += 6) { pts.push([b.x0 - 1.25, z, 1]); pts.push([b.x1 + 1.25, z + 2, 1]); }
      pts.forEach(([x, z, side], i) => {
        if (inB(x, z, 0.3) || x < 1.5 || x > map.width - 1.5 || z < 1.5 || z > z1 - 0.5) return;
        const r = hash(bi * 97 + i), kind = i % 4;
        if (kind === 1) {
          const ax = side ? (x < (b.x0 + b.x1) / 2 ? -1 : 1) : 0, az = side ? 0 : (z < (b.z0 + b.z1) / 2 ? -1 : 1);
          metal.push({ x, y: 3.1, z, sx: 0.15, sy: 6.2, sz: 0.15, color: "#2a2c33" });
          metal.push({ x: x + ax * 0.9, y: 6.15, z: z + az * 0.9, sx: ax ? 1.9 : 0.1, sy: 0.1, sz: az ? 1.9 : 0.1, color: "#2a2c33" });
          const warm = (bi + i) % 3 !== 0;
          lamps.push({ x: x + ax * 1.7, y: 6.05, z: z + az * 1.7, sx: ax ? 0.7 : 0.3, sy: 0.12, sz: az ? 0.7 : 0.3, color: warm ? "#ffd9a6" : "#ff9ae0" });
          pools.push({ x: x + ax * 1.9, y: 0.21, z: z + az * 1.9, sx: 7.5, sy: 0.01, sz: 7.5, color: warm ? "#ffc98a" : "#ff8ad6" });
        } else if (kind === 3) {
          if (r > 0.5) bins.push({ x, y: 0.63, z, sx: 0.55, sy: 0.9, sz: 0.55, color: "#2f4f3f" });
          else { planters.push({ x, y: 0.45, z, sx: 1.5, sy: 0.55, sz: 0.8, color: "#6a6660", ry: side ? Math.PI / 2 : 0 }); shrubs.push({ x, y: 0.95, z, sx: 1.3, sy: 0.8, sz: 0.7, color: "#2f7a4a", ry: side ? Math.PI / 2 : 0 }); }
        } else {
          const h = 5 + r * 2.6, lean = (r - 0.5) * 0.16;
          trunks.push({ x, y: h / 2, z, sx: 0.3, sy: h, sz: 0.3, color: "#7a5d49", rz: lean });
          planters.push({ x, y: 0.24, z, sx: 1.2, sy: 0.14, sz: 1.2, color: "#4a443e" });
          for (let k = 0; k < 9; k++) {
            const ry = (k / 9) * Math.PI * 2 + r * 3, tilt = -0.35 - hash(i + k) * 0.35;
            const off = new THREE.Vector3(1.5, 0, 0).applyEuler(new THREE.Euler(0, ry, tilt, "YXZ"));
            fronds.push({ x: x + off.x - lean * h, y: h + off.y + 0.05, z: z + off.z, sx: 3.1, sy: 0.05, sz: 0.5, color: k % 2 ? "#2e7d4f" : "#3c9a5f", ry, rz: tilt });
          }
        }
      });
      const park = (x: number, z: number, ry: number) => {
        carN++;
        if (inB(x, z, 1.2) || keepClear(x, z, 6) || x < 4 || x > map.width - 4 || z > z1 - 3 || hash(carN * 5.3 + bi) > 0.62) return;
        const col = CAR_COLORS[Math.floor(hash(carN * 3.7) * CAR_COLORS.length)] ?? "#888";
        const e = new THREE.Euler(0, ry, 0);
        const at = (lx: number, ly: number, lz: number) => { const v = new THREE.Vector3(lx, ly, lz).applyEuler(e); return { x: x + v.x, y: ly, z: z + v.z }; };
        const suv = hash(carN) > 0.6;
        carBody.push({ ...at(0, 0.62, 0), sx: 4.3, sy: suv ? 0.75 : 0.6, sz: 1.82, color: col, ry });
        carBody.push({ ...at(-0.15, suv ? 1.42 : 1.24, 0), sx: suv ? 2.9 : 2.2, sy: 0.1, sz: 1.6, color: col, ry });
        carGlass.push({ ...at(-0.15, suv ? 1.18 : 1.05, 0), sx: suv ? 2.8 : 2.1, sy: suv ? 0.46 : 0.36, sz: 1.66, color: "#0c1118", ry });
        for (const [wx, wz] of [[1.35, 0.9], [1.35, -0.9], [-1.35, 0.9], [-1.35, -0.9]] as const) wheels.push({ ...at(wx, 0.34, wz), sx: 0.68, sy: 0.24, sz: 0.68, color: "#0b0b0d", ry, rx: Math.PI / 2 });
        for (const wz of [0.62, -0.62]) { head.push({ ...at(2.16, 0.7, wz), sx: 0.06, sy: 0.14, sz: 0.36, color: "#fff2cf", ry }); tail.push({ ...at(-2.16, 0.74, wz), sx: 0.06, sy: 0.12, sz: 0.4, color: "#ff1a1a", ry }); }
      };
      for (let x = b.x0 + 3; x <= b.x1 - 3; x += 6.2) park(x, b.z1 + 2.95, hash(x) > 0.5 ? 0 : Math.PI);
      for (let z = b.z0 + 4; z <= b.z1 - 3; z += 6.2) park(b.x1 + 2.95, z, Math.PI / 2);
    });

    const wz = map.water[0]?.z0 ?? map.height - 6;
    wood.push({ x: map.width / 2, y: 0.1, z: wz - 0.4, sx: map.width - 2, sy: 0.2, sz: 1.6, color: "#6b4f3a" });
    for (const px of [36, 44, 52, 60, 88]) {
      wood.push({ x: px, y: 0.12, z: wz + 6, sx: 1.8, sy: 0.24, sz: 13, color: "#6b4f3a" });
      for (const dz of [1, 6, 11.5]) for (const dx of [-0.8, 0.8]) metal.push({ x: px + dx, y: -0.3, z: wz + dz, sx: 0.22, sy: 1.6, sz: 0.22, color: "#3a2f28" });
      lamps.push({ x: px, y: 0.5, z: wz + 12.3, sx: 0.25, sy: 0.25, sz: 0.25, color: "#3dffc8" });
    }
    for (let x = 3; x < map.width - 2; x += 3) metal.push({ x, y: 0.65, z: wz - 0.05, sx: 0.08, sy: 0.9, sz: 0.08, color: "#c9ccd2" });
    metal.push({ x: map.width / 2, y: 1.08, z: wz - 0.05, sx: map.width - 4, sy: 0.07, sz: 0.07, color: "#c9ccd2" });
    return { kerbs, ledges, neon, marks, trunks, fronds, metal, lamps, pools, roofKit, tanks, wood, carBody, carGlass, wheels, head, tail, sigRed, sigGreen, bins, planters, shrubs };
  }, [map]);

  const signs = useMemo(() => map.buildings.filter((b) => b.x1 - b.x0 >= 6).map((b) => ({ b, tex: signTexture(b.label, TONES[b.tone].neon) })), [map]);
  const asphalt = useMemo(asphaltMaps, []);
  const cx = map.width / 2, cz = map.height / 2;
  const sun = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.target.position.set(cx, 0, cz - 4);
    l.target.updateMatrixWorld();
    const cam = l.shadow.camera;
    cam.left = -90; cam.right = 90; cam.top = 70; cam.bottom = -70; cam.near = 10; cam.far = 420;
    cam.updateProjectionMatrix();
  }, [cx, cz]);
  const waterRough = useMemo(() => {
    const [c, g] = canvas(512, 512);
    g.fillStyle = "rgb(0,30,0)"; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,${60 + hash(i) * 110},0,0.35)`; g.fillRect(hash(i * 3) * 512, hash(i * 7) * 512, 30 + hash(i) * 90, 2 + hash(i * 5) * 3); }
    const t = tex(c, false); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40);
    return t;
  }, []);
  useFrame(({ clock }) => { waterRough.offset.set(clock.elapsedTime * 0.01, clock.elapsedTime * 0.006); });

  return (
    <group>
      <Atmosphere center={[cx, 0, cz]} />
      <fogExp2 attach="fog" args={["#6a3b63", 0.0042]} />
      <hemisphereLight args={["#8fa0ff", "#3a2a3a", 0.35]} />
      <directionalLight
        ref={sun} color="#ffb27a" intensity={3.2} castShadow={shadows}
        position={[cx + SUN_DIR.x * 190, SUN_DIR.y * 190, cz + SUN_DIR.z * 190]}
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0005} shadow-normalBias={0.06} shadow-radius={5}
      />
      <directionalLight position={[cx + 80, 60, cz - 120]} intensity={0.35} color="#7d8cff" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, (map.walkable.z1 + 1) / 2]} receiveShadow>
        <planeGeometry args={[map.width + 6, map.walkable.z1 + 5]} />
        <meshStandardMaterial map={asphalt.map} roughnessMap={asphalt.orm} roughness={1} metalness={0.02} envMapIntensity={1.5} />
      </mesh>
      <mesh position={[cx, -1.52, (map.walkable.z1 + 1) / 2]}>
        <boxGeometry args={[map.width + 6, 3, map.walkable.z1 + 5]} /><meshStandardMaterial color="#3b3a40" roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.55, cz]}>
        <planeGeometry args={[1400, 1400]} />
        <meshStandardMaterial color="#0b2733" roughness={1} roughnessMap={waterRough} metalness={0.9} envMapIntensity={1.6} />
      </mesh>

      {map.buildings.map((b, i) => <BuildingMesh key={b.id} b={b} index={i} shadows={shadows} />)}
      <Instances items={data.kerbs} roughness={0.9} shadows={shadows} />
      <Instances items={data.ledges} roughness={0.8} shadows={shadows} />
      <Instances items={data.roofKit} roughness={0.55} metalness={0.5} shadows={shadows} />
      <Instances items={data.tanks} shape="cyl" roughness={0.6} metalness={0.4} shadows={shadows} />
      <Instances items={data.marks} roughness={0.6} />
      <Instances items={data.wood} roughness={0.8} shadows={shadows} />
      <Instances items={data.metal} roughness={0.4} metalness={0.7} shadows={shadows} />
      <Instances items={data.trunks} shape="cyl" roughness={0.95} shadows={shadows} />
      <Instances items={data.fronds} roughness={0.7} shadows={shadows} />
      <Instances items={data.bins} shape="cyl" roughness={0.5} metalness={0.4} shadows={shadows} />
      <Instances items={data.planters} roughness={0.9} shadows={shadows} />
      <Instances items={data.shrubs} roughness={0.95} shadows={shadows} />
      <Instances items={data.carBody} roughness={0.22} metalness={0.75} shadows={shadows} />
      <Instances items={data.carGlass} roughness={0.05} metalness={0.9} />
      <Instances items={data.wheels} shape="cyl" roughness={0.9} />
      <Instances items={data.head} glow={1.6} />
      <Instances items={data.tail} glow={2.2} />
      <Instances items={data.sigRed} glow={3} />
      <Instances items={data.sigGreen} glow={3} />
      <Instances items={data.neon} glow={3.2} />
      <Instances items={data.lamps} glow={4} />
      <Instances items={data.pools} shape="cyl" glow={1} opacity={0.07} />

      {signs.map(({ b, tex: t }) => {
        const w = Math.min(b.x1 - b.x0 - 1, 15);
        return (
          <mesh key={b.id} position={[(b.x0 + b.x1) / 2, b.height + 1.9, b.z1 + 0.12]}>
            <planeGeometry args={[w, w * (192 / 1024)]} />
            <meshBasicMaterial map={t} color={[2.2, 2.2, 2.2]} transparent toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}
