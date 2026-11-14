# CITY3D board

Owns `apps/web/src/scene/three/**` only. Built to the FINAL `CityViewProps` in `apps/web/src/scene/types.ts` (CITY2D's).

## Exports
- `scene/three/index.tsx` and `scene/three/ThreeCity.tsx`: `export default function ThreeCity(props: CityViewProps)`.
  `scene/index.tsx` already lazy-loads it behind its error boundary; nothing else to wire.
- Throws during render when WebGL is unavailable, so the boundary falls back to the 2D canvas.
- Fills its parent (100% x 100%). Sends no commands; keyboard stays with WEB.

## Behaviour
- Positions/heat/status/activity/pending come from `tick` when present, else from the views; movement is smoothed per frame.
- Effects are derived from `events` by `serverSequence` (history present at mount is not replayed; a lower top sequence = room reset):
  `AGENT_MESSAGE_SENT` -> arc sender->recipient coloured by kind; `BULLETIN_PUBLISHED` -> arcs issuer->each recipient;
  `CAPTURE_SUCCEEDED` -> burst at the character.
- `youCharacterId` set and not captured -> cinematic follow camera with fixed heading (north = away, so WASD matches 2D), which
  rises automatically when a building would block the shot. Otherwise (spectator / captured) -> orbit camera.
- Click an NPC -> `onSelect(id, "npc")`; a human -> `onSelect(id, "character")`; empty space -> `onSelect(null, null)`.
- QUALITY button (bottom-right, saved in localStorage `vice.city3d.quality`): HIGH = soft sun shadows + HDR bloom + up to 1.75x DPR;
  LOW = none of those. HIGH auto-drops to LOW after 5 s below 20 fps.

## Startup and stability (measured in headless Chrome on Metal, real app, 1600x900)
- Before: canvas blank at 6 s, city only by ~15 s. Cause: `webglAvailable()` created a new WebGL context on every render (151 contexts
  in 16 s), so the browser kept evicting the scene's context (33 losses); plus ~2.8 s of blocking shader links.
- After: 1 scene context, 0 losses, first lit frame 300-650 ms after the view mounts (0.5-1.0 s after page load; 4.7 s once while
  the machine was at load 11). Shaders compile in parallel while a loading veil is up. 8 programs for the scene, 61 fps on HIGH.
- Labels are one DOM overlay, not drei `Html` roots: the React "synchronously unmount a root" error and the `removeChild` exception are gone.
- No dynamic lights and few program families, so nothing recompiles mid-game.
- Console is clean. The THREE.Clock deprecation line comes from inside React Three Fiber; that single line is filtered in ThreeCity.tsx.

## Files
`ThreeCity.tsx` (view, camera, labels, pipeline), `World.tsx` (city, sky, lighting), `Life.tsx` (ambient traffic, pedestrians, sea
glitter; cosmetic only), `Entities.tsx` (figures, beacons, arcs), `materials.ts` (shared programs, keyhole fade), `SceneBoundary.tsx`.
Capture driver: `.swarm/repro/city3d/shot.mjs`; captures in `.swarm/repro/city3d/captures/`.

## Look (all procedural, no external assets)
PBR materials lit by a low sunset sun plus image-based lighting baked from the procedural sky (PMREM), ACES tone mapping, bloom on
HDR neon / lamps / lit windows; facades with generated window grids (lit rooms, reflective glass via roughness/metalness maps),
ledges, parapets, canopies, rooftop units and tanks; wet asphalt with puddle reflections, lane paint, crosswalks, signals,
streetlights, palms, planters, bins, parked cars, boardwalk and piers; articulated figures with a walk cycle.

## Dev harness (not imported by the app)
`apps/web/src/scene/three/dev/index.html` (+ `harness.tsx`): mock props. Open `/src/scene/three/dev/index.html` (add `?spectate=1`
for orbit, `&noauto=1` to keep HIGH quality under software GL).
