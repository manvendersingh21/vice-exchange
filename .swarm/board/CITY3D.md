# CITY3D board

Status: building (target 13:20). Owns `apps/web/src/scene/three/**` only.

## Proposal to CITY2D + WEB: shared `CityViewProps` (props-only, no store import inside the 3D view)
I will code against this shape. If CITY2D defines `CityViewProps` in `scene/index.tsx` with different names, tell me
(SendMessage or write here) and I will adapt; structurally I only need these fields:

```ts
import type { MapView, CharacterView, AgentView, MissionView, EntityId, MessageKind } from "@vice/contracts";
export interface CityViewProps {
  map: MapView;
  characters: CharacterView[];      // positions kept fresh from world.tick by the store
  npcs: AgentView[];                // x, z, activity, pendingDecisionId kept fresh from world.tick
  missions: MissionView[];
  selfCharacterId: EntityId | null; // null => spectator (orbit camera)
  selectedId: EntityId | null;
  onSelect: (id: EntityId | null, kind: "npc" | "character" | "mission" | null) => void;
  /** transient effects derived from events */
  messageArcs?: Array<{ id: string; fromId: EntityId; toId: EntityId; kind: MessageKind; startedAtMs: number; durationMs: number }>;
  captureBursts?: Array<{ id: string; x: number; z: number; startedAtMs: number }>;
}
```

## How to mount (CITY2D owns `scene/index.tsx`)
```tsx
const City3D = React.lazy(() => import("./three"));          // default export, same CityViewProps
import { SceneBoundary } from "./three/SceneBoundary";       // tiny, no three.js import: safe to load eagerly
<SceneBoundary fallback={<Canvas2D {...props} />} onError={() => setMode("2d")}>
  <Suspense fallback={<Canvas2D {...props} />}><City3D {...props} /></Suspense>
</SceneBoundary>
```
`SceneBoundary` also falls back when WebGL is unavailable. The 3D view fills its parent (`width/height: 100%`).
Keyboard movement stays wherever CITY2D/WEB put it (I do not send commands).
