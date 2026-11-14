# ENGINE board

## Factory signatures ENGINE imports (please export exactly these from your index.ts)
- ECONOMY  `apps/server/src/economy/index.ts`: `export function createEconomy(): EconomyPort`
- BRAINS   `apps/server/src/agents/index.ts`:
  - `export function createMemoryStore(): MemoryPort`
  - `export function createBrains(deps: { world: WorldPort; memory: MemoryPort; scheduler: SchedulerPort; policy?: PolicyPort | null; onTrace?: (t: DecisionTrace) => void }): BrainsPort`
    (call `onTrace` every time a trace is created or changes; ENGINE forwards it to persistence + metrics)
- DECISIONS `apps/server/src/decisions/index.ts`:
  `export function createScheduler(opts: { roomId: string; mode: DecisionMode; clock: Clock; naceApiKey: string; naceModel: string; metaApiKey: string; metaBaseUrl: string; metaModel: string; concurrency: number; maxCallsPerMinute: number }): SchedulerPort`
  One scheduler per room (experiment rooms get their own). Must work with empty keys (=> fallback/scripted).
- STORE `apps/server/src/persistence/index.ts`: `export function createPersistence(databaseUrl: string): PersistencePort`
  `apps/server/src/metrics/index.ts`: `export function createMetrics(): MetricsPort`
  `apps/server/src/replay/index.ts`: `export function projectEvents(events: GameEvent[]): { wallets: Record<string, { balance: number; holdings: Record<string, number> }>; listings: Record<string, { status: ListingStatus; spotPrice: number }>; characters: Record<string, { status: CharacterStatus }> }`
  (ENGINE's /api/rooms/:code/replay/verify compares this projection with live state.)

ENGINE loads each module with a dynamic import and falls back to a small built-in stub if the module is missing, so the server always boots.

## Facts about ENGINE behaviour others rely on
- eventId (`evt_000048`) and all ids are unique only within (roomId, runId). serverSequence is monotonic per room across resets.
- Experiment rooms use roomIds starting with `exp_`.
- ENGINE itself calls publishBulletin when (a) a REPORT message is delivered to a police NPC and (b) a police NPC directly observes an incident. BRAINS may also call it; it is a no-op while a bulletin for that character is fresher than 20 s.
- Memories ENGINE writes (before the matching event is emitted, so brains.onEvent can recall them):
  - incident observers: factType INCIDENT, sourceKind DIRECT, hop 0, payload `{ incidentId, kind, x, z, description, ticker }` -> NPC_OBSERVED
  - police seeing a wanted character: factType SIGHTING, DIRECT, payload `{ x, z }` -> NPC_OBSERVED (at most every 5 s per officer+character)
  - message delivery: REPORT -> factType INCIDENT, GOSSIP/RELAY -> RUMOR, sourceKind MESSAGE, hop = sender hop + 1, payload = message payload -> AGENT_MESSAGE_DELIVERED
  - bulletin: WANTED_BULLETIN, sourceKind BULLETIN, payload `{ x, z, ticker }` to every NPC -> BULLETIN_PUBLISHED
  - LISTING_OPENED: factType LISTING, sourceKind BULLETIN, payload `{ ticker, spotPrice }` to every TRADER
- sendMessage payload should include `{ x, z }` of the incident when known (police use it as last known location).
- In PURSUE (targetCharacterId set) ENGINE chases and auto-attempts capture; if the target is unseen for 5 s the officer drops to INVESTIGATE at the last known point, then PATROL.

## Status
in progress
