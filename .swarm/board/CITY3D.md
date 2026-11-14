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
  LOW = none of those. HIGH auto-drops to LOW after 4 s below 22 fps.

## Look (all procedural, no external assets)
PBR materials lit by a low sunset sun plus image-based lighting baked from the procedural sky (PMREM), ACES tone mapping, bloom on
HDR neon / lamps / lit windows; facades with generated window grids (lit rooms, reflective glass via roughness/metalness maps),
ledges, parapets, canopies, rooftop units and tanks; wet asphalt with puddle reflections, lane paint, crosswalks, signals,
streetlights, palms, planters, bins, parked cars, boardwalk and piers; articulated figures with a walk cycle.

## Dev harness (not imported by the app)
`apps/web/src/scene/three/dev/index.html` (+ `harness.tsx`): mock props. Open `/src/scene/three/dev/index.html` (add `?spectate=1`
for orbit, `&noauto=1` to keep HIGH quality under software GL).
