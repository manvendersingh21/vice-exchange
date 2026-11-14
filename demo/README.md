# VICE EXCHANGE demo videos

Two files, both cut from one real run recorded on 2026-11-14 (take 2): a real server on a spare port with a fresh
database, three headless Chrome browsers (Outlaw "Ace", Hunter "Rio", Spectator "Judge") driven in real time over the
Chrome DevTools Protocol, and real Nace Drex decisions. Nothing on screen is mocked or staged.

## What is real
- Every NPC decision in the browser footage is a live Drex call from that run: 10 decisions, 10 decided by Drex,
  0 low-confidence guardrail, 0 fallback (read from the run's own metrics panel, which is on screen at the end).
- Drex round trip in that run: median 389 ms, p95 537 ms over 10 calls. Live shadow comparison: 10 compared, 7 agreed,
  Meta median 988 ms. Experiment table on screen: Meta p50 774 ms / p95 1251 ms, Drex p50 323 ms / p95 565 ms, 8 calls each.
- Capture by Sgt. Imani Duarte (police NPC) 49 s after spawn; ACE-01 halted at exactly V$0; respawn as ACE-02.
- Replay check shown is the server's own `/replay/verify` response: ok, 88 events, 0 mismatches.
- The 3D segment is the Godot client's own recording (`integrations/ota-bridge/frames/vice_exchange_3d_full_chain.mp4`),
  sped up; it is a separate run against the same server code, in Drex mode.
- Title, track and "how it is built" cards are rendered HTML, not footage. The track text is quoted verbatim.
- Audio: narration is macOS `say`; the bed and effect cues (a tick per resolved decision, a low hit on capture) are
  generated with ffmpeg sine and noise sources. No music or samples from anywhere else.

## Not captured, and other limits
- A rejected buy on the halted ticker, and the provider-failure moment (badge DREX: FALLBACK), are not in the video.
  Both are covered by the end-to-end harness (`e2e/out/report.json`), not shown here.
- Traders took different positions on the same ticker (one bought, one held); no trader sold in this run, and the human
  hunter did not race the police, so the video does not claim either.
- The frame rate of the browser footage is low (about 3 to 6 frames per second): frames are CDP screenshots taken while
  three browsers ran at once. The capture cinematic is on screen for only a few frames because screenshots stalled
  while it played.
- During recording the Outlaw page stopped answering DevTools for about 54 s from the moment of capture (with the
  Agent Inspector open). The spectator page was fine, so the capture shot uses the spectator's view. Not reproduced
  outside this recording set-up.

## How to re-record
```
PORT=3771 DATABASE_URL=/tmp/vx-demo.sqlite WEB_ORIGIN=http://localhost:5771 npx tsx apps/server/src/index.ts
(cd apps/web && VICE_SERVER=http://localhost:3771 npx vite --port 5771 --strictPort)
OUT=/tmp/vx-take BASE=http://localhost:5771 API=http://localhost:3771 node demo/record.mjs
TESTS=<passing count> TAKE=/tmp/vx-take WORK=/tmp/vx-work node demo/assemble.mjs   # ONLY=main or ONLY=npcs for one file
```
Requires Google Chrome, ffmpeg and macOS `say`. Captions are rendered as PNGs by headless Chrome because this ffmpeg
build has no drawtext filter.

## Main demo: `demo/vice-exchange-demo.mp4` (180.4 s, 1920x1080 H.264 + AAC stereo)

| At | Length | Shot | Speed | Caption on screen |
|---|---|---|---|---|
| 0:00 | 8.6 s | title | 1x | (card) |
| 0:08 | 22.2 s | track | 1x | (card) |
| 0:30 | 23.9 s | how-built | 1x | (card) |
| 0:54 | 10.7 s | city | 1x | One live room: 8 NPCs (2 witnesses, 2 informants, 2 traders, 2 police), a shared market, header badge DREX: LIVE. |
| 1:05 | 7.0 s | two-players | 1.17x | Two human players, one authoritative server: Outlaw (left) and Hunter (right). |
| 1:12 | 11.0 s | job | 1x | The outlaw does a job. A witness saw it: her decision card shows options, probabilities, latency and request id. |
| 1:23 | 13.8 s | swarm-reacts | 1x | Witness to police to public bulletin: WANTED, price falls. Traders then decide on the same ticker, each from its own memory. |
| 1:37 | 13.4 s | inspector | 1x | Agent Inspector on a police officer: private memory with provenance, the decision trace, and cited policy facts. |
| 1:50 | 7.0 s | pursuit | 1.66x | Police set off after a dispatch delay and close in on foot (sped up). |
| 1:57 | 8.0 s | capture | 1.19x | Captured by Sgt. Imani Duarte: the ticker goes to exactly V$0 and trading is halted. |
| 2:05 | 6.0 s | respawn | 1.72x | Respawn: a new character and a new ticker. The old one stays listed, halted at V$0. |
| 2:11 | 20.0 s | world-3d | 2.14x | The same server driving a 3D city client (Godot, on the MIT-licensed Open Theft Auto). Sped up. |
| 2:31 | 18.1 s | experiment | 2.52x | This run's metrics panel: 10 NPC decisions: 10 decided by Drex, 0 low-confidence guardrail, 0 fallback. Then: scripted vs Meta LLM vs Drex on one seed (sped up). |
| 2:49 | 5.1 s | replay | 1x | Server response: the event log replayed with no model calls matches live state (ok=true, 88 events, 0 mismatches). |
| 2:54 | 5.6 s | end | 1x | (card) |

### Narration (407 words, macOS `say`, voice Samantha)

- **0:00 title**: Vice Exchange. Every outlaw is a stock, and every character decides for itself. V dollars are fictional game credits.
- **0:08 track**: The track is Swarm Intelligence: multi agent systems. Quote: Build systems where multiple agents coordinate, compete, or negotiate, with Drex making every agent's calls. Think traders in a simulated market, N P Cs that think for themselves, or a team of agents dividing up a research task. This project is the first two at once.
- **0:30 how-built**: How it is built. Each character has a role, a goal and a private memory. When it witnesses something or receives a message, the server makes one Drex call: a typed choice question built only from what that character knows. Drex returns a label with probabilities. The server checks it against the legal actions and applies it. The result is a message, a trade or a police move, which triggers the next agent.
- **0:54 city**: One live room, seen by a spectator. Eight characters: two witnesses, two informants, two traders and two police. The header badge reads Drex live.
- **1:05 two-players**: Two human players share it: an outlaw and a hunter. The server owns every position and price.
- **1:12 job**: The outlaw does a job and the price jumps. A witness saw it first hand. Her decision card shows the options, the probabilities, the latency and the request i d.
- **1:23 swarm-reacts**: Agents coordinate: the witness reports, police issue a public bulletin, the character is wanted, and the price falls before any capture. And they compete: each trader decides on the same ticker from its own memory.
- **1:37 inspector**: Inspect an officer: its private memory, where each fact came from, and its decision trace. Police decisions carry facts that N D I parsed from a real San Francisco Police Department foot pursuit order.
- **1:50 pursuit**: Officers close in. This part is sped up.
- **1:57 capture**: Captured. The ticker goes to exactly zero and trading is halted.
- **2:05 respawn**: The player respawns with a new ticker. The old one stays listed, halted.
- **2:11 world-3d**: The same server also drives a three D city client, with several characters in view and their decisions above their heads.
- **2:31 experiment**: In this run the metrics panel counts 10 decisions: 10 decided by Drex, 0 by the low confidence guardrail, and 0 by fallback. The demo director then runs one seeded scenario three ways: scripted, a Meta language model, and Drex, and reports measured latency.
- **2:49 replay**: The event log, replayed with no model calls, matches live state.
- **2:54 end**: Vice Exchange. A swarm that decides, and every decision on the record.

Effect cues placed from the run's event log: 15.

## NPC swarm cut: `demo/vice-exchange-npcs.mp4` (53.0 s, 1920x1080 H.264 + AAC stereo)

| At | Length | Shot | Speed | Caption on screen |
|---|---|---|---|---|
| 0:00 | 10.0 s | eight-npcs | 1x | Eight NPCs in one city: witnesses, informants, traders and police, each with private memory. |
| 0:10 | 18.0 s | swarm-decides | 1x | After a job, several NPCs decide at once. Every card in this run is a real Drex call: options, probabilities, latency. |
| 0:28 | 11.0 s | officers-converge | 1.83x | Both officers converge on the last known location while the market reprices (sped up). |
| 0:39 | 14.0 s | swarm-3d | 1.71x | The same swarm in the 3D city client: characters labelled by role, decisions above their heads (sped up). |

### Narration (93 words, macOS `say`, voice Samantha)

- **0:00 eight-npcs**: Eight characters share this city: witnesses, informants, traders and police. None of them can see what the others know.
- **0:10 swarm-decides**: When an outlaw does a job, only the characters who saw it react. The witness decides to report. Messages cross the swarm graph, a bulletin goes out, and traders and officers each make their own call, shown as live decision cards.
- **0:28 officers-converge**: Both officers converge on the last known location, while the market reprices around them.
- **0:39 swarm-3d**: And the same swarm inside the three D city, with each character's role and decision floating above its head.

Effect cues placed from the run's event log: 7.

