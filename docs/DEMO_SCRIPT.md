# VICE EXCHANGE: five-minute demo script

This follows section 9 of the product spec. Rehearse it once end to end before going on stage.

## Before the demo

1. Start the app: `npm run dev`. Wait for the server line `server listening on http://0.0.0.0:3001`.
2. Window A (left half of the screen): `http://localhost:5173/?nick=Ace&role=OUTLAW&room=VICE-42&auto=1`. Open this one first: the first browser to join `VICE-42` gets the director controls.
3. Window B (right half): `http://localhost:5173/?nick=Rio&role=HUNTER&room=VICE-42&auto=1`.
4. Check the header badge in both windows reads `DREX: LIVE`. If it reads `SCRIPTED`, the Nace key is missing from `.env`.
5. In window A open the `DEMO DIRECTOR · METRICS` tab and press the seeded reset, then go back to `EVENT TIMELINE`.
6. Set the browser zoom so the city, the market panel and the timeline are all visible. Click once on the city in window A so the keyboard controls the avatar.
7. Optional 3D world: launch commands are in `.swarm/board/GODOT.md`.

## Script

| Time | Do | The audience sees | Say | Proves |
|---|---|---|---|---|
| 0:00 | Point at window A: the city, the eight labeled NPCs, the market panel, the notice about fictional credits | An original neon city, eight NPCs in four roles, one ticker for Ace | "Every outlaw is a stock. Every NPC decides for itself with Drex. Get caught and your stock goes to zero. All credits are fictional." | The concept and the roles |
| 0:35 | Move Rio in window B with W A S D | Rio moves in both windows | "Two real players, one authoritative server." | Synchronized multiplayer |
| 0:50 | In window A walk Ace to the job marker at the dock and press E | Job completes once; Ace's price rises; the witness at the dock gets a thinking indicator | "The job raised my notoriety and my reference value. One witness saw it. Nobody else knows yet." | Mission, price formula, private memory |
| 1:15 | Click the witness, Marisol Vega | Inspector: what she knows (direct observation), the options, probabilities, chosen action, `DREX · live`, latency, request id | "This is a real Drex call built only from what she saw. Here are the probabilities, the latency and the request id." | A real Drex decision with trace |
| 1:40 | Click a trader, for example Rook Halvorsen | Before the message arrives he has no memory of the job; after the bulletin or a relayed tip he has one, with its source | "The trader only learns through a message, and the memory names who told him." | Information spreads only by message |
| 2:00 | Watch the timeline and the market panel | Report to police, wanted bulletin, heat rises, price drops, traders buy, sell or hold | "The city found out. Risk went up, so the price fell before any capture. Traders with different personas decide differently." | Multi-agent causal chain, shared market |
| 2:30 | Click one decision in the timeline | Its cause and effects are highlighted | "Every step links to what caused it." | Causation is recorded |
| 2:45 | Keep Ace still, or walk Rio to Ace and press E once Ace is wanted | Police arrive after their dispatch delay and capture, or Rio captures and receives the bounty; the ticker shows V$0 and HALTED in both windows | "Captured. The ticker is exactly zero and trading is closed. The bounty grows the longer the outlaw survived." | Atomic capture, V$0, bounty rule |
| 3:30 | Press R in window A | A new character with a new ticker; the old ticker stays listed as halted with its history | "New life, new ticker. The old one stays on the record." | Respawn and history |
| 4:00 | In window A open `DEMO DIRECTOR · METRICS` and press the experiment button | A table with one row per mode fills in over about 20 seconds; the live metrics show the Drex and Meta comparison | "Same seed, three ways: scripted rules, a Meta LLM, and Drex. These numbers are measured in this run. One run per mode is a demonstration, not a benchmark." | Baseline comparison with measured numbers |
| 4:40 | If NDI is loaded, click a police NPC and show the citations | Policy facts with page numbers from the San Francisco Police Department's foot pursuit order | "Police decisions also see facts NDI extracted from a real public policy document, with citations." | NDI on a real document |

With an outlaw who stands still after the first job, capture came 25.6 to 28.4 seconds after the mission in the three measured runs. To hold the capture back, keep Ace moving: officers pursue at 7.5 m/s and a player moves at 9 m/s.

## When things go wrong

- **Drex is slow or unavailable.** The header badge changes to `DREX: FALLBACK` and affected decisions are labeled `FALLBACK rule` with an error type. The room keeps running. Say that this is a fallback; do not describe it as a Drex result.
- **You want a fully deterministic run.** In the director panel switch the mode to scripted. The badge reads `SCRIPTED` and decisions are labeled `SCRIPTED rule`.
- **No director controls.** Leave, then rejoin and enter the director secret in the join form (`DEMO_DIRECTOR_SECRET` in `.env`, or the per-run secret the server prints at boot).
- **The room is in a mess.** Press the seeded reset.
- **Nobody gets captured.** Complete a second job, or trigger an incident from the director panel.
- **The 3D view misbehaves.** Switch back with the 2D toggle in the header.
