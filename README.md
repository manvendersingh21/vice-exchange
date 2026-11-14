# VICE EXCHANGE

VICE EXCHANGE is a multiplayer simulation set in an original neon city, Coral Bay. Every outlaw character is a tradable fictional ticker. Eight NPCs (two witnesses, two informants, two traders, two police officers) each decide what to do with a real Nace Drex `choice` call built only from their own private memory. Information spreads only through recorded messages, and capturing a wanted character sets its ticker to exactly V$0. It was built for the Nace AI Drexathon, Swarm Intelligence track.

**V$ are fictional, nonredeemable game credits. There is no real money, no cash-out and no payment code anywhere in this repository.**

## What works today

Status was recorded on 2026-11-14. "Automated test" means `npm test` (150 tests passing when run for this document at 13:09 local). "E2E" means the two-browser harness `npm run e2e` (report started 21:04 UTC, `e2e/out/report.json`): all 12 scenario steps passed and one extra socket-level check failed, listed under Known limitations.

| Feature | Status | Evidence |
|---|---|---|
| Join a room from several browsers, synchronized movement | Verified by E2E and automated test | E2E S01, S02; `apps/server/test/socket.test.ts` |
| Mission completes exactly once and raises reference value (AT-01) | Verified by E2E and automated test | E2E S03; `apps/server/test/acceptance.test.ts` |
| Private NPC memory, knowledge spreads only by message (AT-02) | Verified by E2E and automated test | E2E S04; `acceptance.test.ts`, `apps/server/src/agents/brains.test.ts` |
| Real Drex decisions with probabilities, confidence, request id, latency (AT-03) | Verified by E2E (live run) | E2E S05: 10 decisions labeled `drex` across all four roles in that run |
| Trading with idempotency and reject reasons (AT-04) | Verified by E2E and automated test | E2E S06; `apps/server/src/economy/economy.test.ts` |
| Capture is atomic, ticker exactly V$0, bounty paid once (AT-05) | Verified by E2E and automated test | E2E S07; `acceptance.test.ts` |
| Respawn with a new ticker, old one stays halted (AT-06) | Verified by E2E and automated test | E2E S08; `acceptance.test.ts` |
| Provider failure is labeled fallback, room keeps running (AT-07) | Verified by E2E and automated test | E2E S11; `apps/server/src/decisions/scheduler.test.ts` |
| Replay from the SQLite event log matches live state (AT-08) | Verified by E2E and automated test | E2E S10; `apps/server/src/persistence/store.test.ts` |
| Seeded reset, mode switch, three-mode experiment | Verified by E2E | E2E S09 |
| Live Drex versus Meta shadow comparison | Verified by E2E (live run) and automated test | E2E metrics; `apps/server/test/shadow.test.ts` |
| NDI document grounding for police decisions | Verified by a live run and automated test | `.swarm/board/NDI.md`; `apps/server/src/policy/*.test.ts` |
| 2D city, 3D browser view, inspector, timeline, director panel | Verified by E2E (rendered and captured) | E2E S12 |
| Godot 3D world client | Verified by scripted live runs, not by a human at the keyboard | `.swarm/board/GODOT.md` |
| Swarm graph, decision cards, crash cinematic, ticker tape (`apps/web/src/components/wow`) | Implemented and imported by the app; typecheck and build pass; not covered by the E2E report and not visually verified for this document | `apps/web/src/App.tsx` imports |

## Quick start

Prerequisites: Node.js 22.13 or later (developed on Node 26; persistence uses the built-in `node:sqlite`), npm, and Google Chrome for the browser client.

```bash
npm install
cp .env.example .env
# edit .env: set NACE_API_KEY (required for live Drex) and optionally META_API_KEY
npm run dev
```

`npm run dev` starts the game server on port 3001 and the web app on port 5173. Open `http://localhost:5173`.

Variables read from `.env` (names only; values stay on the server): `NACE_API_KEY`, `NACE_DEFAULT_DECISION_MODEL`, `META_API_KEY`, `META_BASE_URL`, `META_DECISION_MODEL` (or `META_MODEL`), `SHADOW_META`, `PORT`, `WEB_ORIGIN`, `DATABASE_URL`, `GAME_TICK_HZ`, `NPC_DECISION_CONCURRENCY`, `MAX_DECISION_CALLS_PER_MIN`, `DEMO_DIRECTOR_SECRET`. Without `NACE_API_KEY` the room starts in scripted mode and says so.

The join screen accepts a deep link:

```
http://localhost:5173/?nick=Ace&role=OUTLAW&room=VICE-42&auto=1
```

Parameters: `nick` (up to 16 characters), `role` (`OUTLAW`, `HUNTER` or `SPECTATOR`), `room` (room code; the server creates `VICE-42` at boot), `auto=1` (join without clicking), `create=1` (create a new room instead of joining), `view=3d` or `view=2d`.

Two players on one machine: open the link above in one window and `http://localhost:5173/?nick=Rio&role=HUNTER&room=VICE-42&auto=1` in a second window. From a second laptop on the same network, replace `localhost` with this machine's network address, which Vite prints when it starts.

Controls: W A S D or the arrow keys move, E does the job at the marker (outlaw) or captures a wanted target within 2.5 m (hunter), R respawns after capture.

Demo-director controls (seeded reset, incident trigger, mode switch, experiment) belong to the first browser that joins `VICE-42`, to the creator of a room made with `create=1`, and to any join that enters the director secret in the join form. The secret is `DEMO_DIRECTOR_SECRET` from `.env`; when that is empty the server prints a per-run secret in its console at boot.

## Scripts

| Command | What it does | Checked |
|---|---|---|
| `npm run dev` | Server (watch mode) and web app together | Not run for this document: ports 3001 and 5173 were in use by the running demo |
| `npm run dev:server`, `npm run dev:web` | Each half alone | Not run (same reason) |
| `npm run start:server` | Server without watch mode | Run on a spare port, see below; `/health` answered |
| `npm run typecheck` | TypeScript check of every workspace | Run |
| `npm test` | Server test suite (vitest) | Run: 150 passed |
| `npm run build` | Production build of the web app | Run |
| `npm run e2e` | Two-browser end-to-end harness on its own ports; writes `e2e/out/` | Not re-run for this document; the report cited above is its output |
| `npm run replay` | Lists recorded runs; `npm run replay -- <roomCode> [runId]` prints a run's projection from SQLite | Run |
| `npm run ndi:ingest` | Runs the NDI document ingestion once and prints the facts | Run against the cache |

To run a second server beside a running one: `PORT=3301 DATABASE_URL=:memory: npm run start:server`.

## How the swarm works

Each NPC has a role, a persona, a goal, contacts and a bounded private memory. A memory entry records what it is about, where it came from (direct observation, message or public bulletin), the number of message hops and a provenance confidence.

| Role | Can choose | Triggered by |
|---|---|---|
| Witness | `report` (to the nearest police officer), `gossip` (to its informant contact), `ignore` | Seeing an incident within 14 m with line of sight |
| Informant | `relay` (to its trader contacts), `withhold` | A delivered message, or seeing an incident |
| Trader | `buy`, `sell` (only when it holds shares), `hold` | A new listing, a delivered rumor, a public bulletin |
| Police | `investigate`, `patrol`, `pursue` (only with a fresh direct sighting) | A delivered report, a bulletin, a direct sighting |

A decision request contains only that NPC's own memories, wallet, contacts and, for traders, the public market summary. The server offers only actions that are legal at that moment, sends them to the provider, validates the answer again against the current world, and then applies it through the same paths a human uses. A report that reaches police publishes a wanted bulletin, which raises heat and is visible to every NPC.

To inspect a decision, click an NPC in the city or in the Agent Intelligence list. The inspector shows what the NPC knows and where each fact came from, the offered actions, the chosen action, the source badge, probabilities and confidence when the provider returned them, round-trip latency, provider evaluation time, the request id and any policy citations.

## Market rules

All numbers come from `RULES` in `packages/contracts/src/constants.ts` and are implemented in `apps/server/src/economy/index.ts`.

```
reference = 100 + 15 * notorietyPoints + 60 * completedMissions + 2 * floor(survivalSeconds / 5)
survival  = clamp(0.95 - 0.007 * heat + 0.02 * successfulEscapes, 0.15, 0.98)
sentiment = clamp(1 + 0.03 * netBuyUnitsLast60s, 0.75, 1.25)
spot      = max(1, round(reference * survival * sentiment))      captured => exactly 0
ask = spot        bid = max(1, floor(spot * 0.97))
bounty    = max(50, round(0.5 * reference))
```

Guardrails: one share per order, at most 10 shares per wallet per ticker, a 2 second cooldown per wallet and ticker, wallets start at V$2,000, integers only, no shorting. The server is the counterparty. A mission adds 2 notoriety points and 12 heat; a police report adds 30 heat; a character is wanted at heat 30 or more.

## How decisions are labeled

| `decisionSource` | Meaning | Badge in the UI |
|---|---|---|
| `drex` | Drex was called and its choice applied | `DREX · live` |
| `drex_low_confidence_guardrail` | Drex was called, the margin between its top two labels was under 0.1, the NPC's safe action was applied; Drex's real numbers stay in the trace | `DREX unsure → safe action` |
| `meta` | Meta's model was called and its choice applied (Meta mode) | `META LLM · live` |
| `scripted` | Scripted mode: no provider called | `SCRIPTED rule` |
| `fallback` | A provider was unavailable, failed or timed out; a safe rule was applied and the error type recorded | `FALLBACK rule` |
| `replay` | Served from a recorded log | `REPLAY (recorded)` |

Probabilities and confidence are shown only when the provider returned them. Meta does not return probabilities, so those fields are empty for Meta decisions. The header badge reads `DREX: LIVE`, `DREX: FALLBACK`, `META: LIVE`, `META: FALLBACK` or `SCRIPTED`.

## Experiment modes

The director's experiment button runs the same seeded scenario in three headless rooms at once, one per mode (`scripted`, `meta`, `drex`), each driven by the same scripted outlaw. It reports decisions, real provider calls, fallbacks, measured latency, messages, NPC trades and the capture outcome. One run per mode is a demonstration, not statistical evidence, and the result carries that caveat.

Measured values, with how they were measured:

- E2E run (20 second experiment, one run per mode): Meta 7 calls, median 660 ms, 95th percentile 1177 ms; Drex 7 calls, median 279 ms, 95th percentile 444 ms; no fallbacks; NPC trades 0 scripted, 1 Meta, 2 Drex; every mode reported to police and none captured within 20 seconds.
- Same E2E run, live room: 10 decisions labeled `drex`, median round trip 309 ms. The background shadow comparison completed 12 times and agreed 12 times, with medians of 314 ms for Drex and 784 ms for Meta. An earlier run of the same harness gave 11 of 12 agreement with medians of 277 ms and 800 ms.
- Pacing, one live run per mode with an outlaw who stands still after the first job: mission to capture took 25.6 s scripted, 28.4 s Meta, 26.3 s Drex.

These are observations from a few runs on one machine, not benchmarks.

## Optional: NDI document grounding

`apps/server/src/policy` ingests one real public document with Nace NDI: the San Francisco Police Department's Department Notice 24-068 with General Order 5.25 "Foot Pursuits" (5 pages, fetched from sanfranciscopolice.org). Two real NDI jobs (parse, then extract) produced 9 policy facts, each with a page number and a verbatim quote that was checked against the page text. The facts are added to every police NPC's decision state and shown as citations in the inspector. The PDF and the cached NDI result live in `data/ndi/`, which is git-ignored; the repository keeps only the URL, the hash and the short quotes. If ingestion fails, the policy view is empty and nothing is substituted. Details: `.swarm/board/NDI.md`.

## Optional: Godot 3D world client

`integrations/ota-bridge` contains a bridge script (`vice_bridge.gd`) and an apply script (`apply.py`) that turn the open-source Godot project Open Theft Auto into a 3D client of this server through a plain WebSocket at `/bridge` (`apps/server/src/bridge/index.ts`). The upstream project is not committed here. Setup and launch commands, keys and what was verified are in `.swarm/board/GODOT.md`. In that client, server perception and line of sight use the server's own map, not the 3D city's buildings. It was verified with scripted runs through the real key path, not with a human at the keyboard.

## Deviations from the draft spec

| Deviation | Reason |
|---|---|
| Event types are `DECISION_REQUESTED` and `DECISION_RESOLVED`, not `DREX_DECISION_*` | The same events carry scripted, Meta and fallback decisions; the type must not say Drex when Drex did not decide |
| Only outlaws are listed; hunters have an avatar and a wallet but no ticker | A hunter cannot be captured and would be a riskless asset |
| Survival adds 2 reference value every 5 seconds (24 per minute), not 8 per minute | Visible in a five-minute demo; founder rule that a character is worth more the longer it lives |
| Captor bounty is half the target's reference value, minimum V$50 | Founder rule added after the spec: a later capture pays more |
| Sells fill 3 percent below spot | A buy-then-sell round trip cannot profit from its own price impact |
| `node:sqlite` instead of better-sqlite3; npm workspaces instead of pnpm | No native build, nothing extra to install |
| Three mission spots moved a few metres | Every job stands on open ground in both the browser map and the 3D world |
| Police acting on a second-hand report wait 10 seconds and search at half walking pace; heat does not cool while an officer is on the case | Demo pacing: the message chain and the market react before a capture |
| A Meta LLM mode and a background shadow comparison were added | Baseline for the Drex comparison |

## Known limitations

- `player.pose`, the position command used by the 3D world client, is checked for map bounds and speed but not for buildings. This is the one failing check in the E2E report (`SX.pose-into-building`).
- A disconnected player's avatar and ticker stay in the world until the player rejoins with the same nickname and role or the director resets the room.
- The live room's Meta shadow and an experiment's Meta lane share one Meta rate limit; running both can produce labeled Meta fallbacks.
- Room state is in memory. Events, decisions and experiments persist in SQLite, but a server restart starts a fresh seeded room.
- No accounts, no multiple persistent rooms, no matchmaking, no cloud deployment. No Adobe tooling was used.
- Experiments are one run per mode.

## Credits and licenses

- Nace Drex and NDI through `nace-sdk`; Meta's model API as a labeled baseline.
- React, Vite, zustand, three.js, React Three Fiber, Express, Socket.IO, Zod, vitest, playwright-core.
- The optional 3D world client builds on Open Theft Auto by mehulkapadia5 (MIT license) and the Godot engine. Its files are not included here.
- This project does not use, include or depend on any commercial game's code or assets. City, characters and names are original.

More: `docs/ARCHITECTURE.md`, `docs/DEMO_SCRIPT.md`, and the original spec in `docs/spec/`.
