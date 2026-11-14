# NDI (policy module) — status: DONE, real NDI job ran (12:47), 29 tests pass, typecheck clean

Owner of `apps/server/src/policy/**` (new). Also added the script `ndi:ingest` to `apps/server/package.json` and the root
`package.json` (additive). Nothing else was edited.

## What is real
- Document: **San Francisco Police Department, Department Notice 24-068 with Department General Order 5.25 "Foot Pursuits"
  attached** (Rev. 03/06/24, Eff. 05/08/24), 5 pages, fetched by the module from the publisher's own site:
  `https://www.sanfranciscopolice.org/sites/default/files/2024-06/SFPDDN_24_068_20240625.pdf`
  SHA-256 `95ce842aaa2a87c705406f033aae4f972fac3c7f26551fa3a72f702e0de38587`, 279,378 bytes, retrieved 2026-11-14T20:46:50Z.
  The PDF is in `data/ndi/` (git-ignored), not in the repo. The repo holds the URL, the hash and the short quotes below.
- A **real NDI run** produced the facts: upload, then Parse job `90745561-b5fa-4951-a6a5-b2d2286640f8` (3.6 s, $0.0175),
  then Extract job `8dc24341-ac0d-4ae3-99a9-4eea963cd919` (5.9 s, $0.0425) on that parse. 11.1 s in all, $0.06 once.
- NDI returned 9 of 9 policy fields as `found`, each with a page, a region box and confidence 0.89. All 9 quotes pass the
  module's word-for-word check against NDI's own parsed page text, and I checked them a second way: 9 of 9 appear exactly
  (after whitespace and quote-mark normalisation) in the page text macOS PDFKit reads from the same file, on the cited page.
- The raw jobs are cached in `data/ndi/policy-<sha256>.json`. A restart reads that file: no NDI call, nothing billed
  (measured 3 ms), and it still reports the original job id and the time the job ran.

## Integration (ENGINE: 3 lines in `apps/server/src/index.ts`; `createApp` already forwards `policy` to `createRoomFactory`)
```ts
import { createPolicy } from "./policy";

const policy = createPolicy(config); // returns at once; view() is null until real NDI facts are loaded
void policy.start();                 // cache hit: ~3 ms. Miss: runs the real NDI jobs in the background. Never throws.

const app = createApp({
  policy,
  // ...the existing options unchanged
});
```
That is all: `RoomEngine.snapshot()` calls `policy.view()` each time and `buildPlan` calls `policy.factsFor("POLICE")` on
every police decision, so facts that arrive after boot are picked up without a restart (covered by
`policy.integration.test.ts`, which runs the real room factory, engine and brains).

Optional, for the web (your files, your call):
- `app.get("/api/policy", (_req, res) => res.json(policy.status()))` — label source, job ids, timings, per-fact page,
  confidence and region boxes. To do this `AppOptions.policy` would be typed `PolicyService` (it extends `PolicyPort`).
- Emit `POLICY_INGESTED` (already in contracts) from `policy.start().then(() => policy.view())` if you want it in the feed.

## API (`import { createPolicy } from "./policy"`)
```ts
createPolicy(cfg?: { naceApiKey?: string | null } | null, opts?: PolicyOptions): PolicyService
interface PolicyService extends PolicyPort {          // PolicyPort = view() + factsFor(role)
  start(): Promise<void>;                             // idempotent, never rejects
  status(): PolicyStatus;
  regionsFor(field: string): PageRegion[];            // highlight boxes, normalised 0..1 page coordinates
}
```
- `view()` — `null` until loaded, then `{ documentTitle, sourceUrl, ingestedVia: "ndi", ndiJobId, facts: Citation[] }`.
  One `Citation` per fact: `documentId, documentTitle, sourceUrl, page, quote, extractedField, ndiJobId`.
- `factsFor("POLICE")` — the 9 citations. `WITNESS`, `INFORMANT`, `TRADER` get `[]`: the order governs officers only.
- `status()` — `state` (`idle | loading | ready | unavailable`), `reason` and `message` when the view is null,
  `source` (`"ndi_live"` = jobs ran in this process, `"ndi_cache"` = an earlier real job read from disk, `null` = no facts),
  `document` (title, publisher, url, sha256, pages, retrievedAt), `ndi` (`jobId`, `parseJobId`, `ranAt`, `elapsedMs`,
  `costUsd`, `cacheHit`, `cachePath`), `facts` (page, confidence, regions, how the game uses the rule), `rejected`, `identity`.
- Reasons the view stays null: `no_api_key`, `download_failed`, `document_hash_mismatch`, `document_not_pdf`,
  `ndi_auth`, `ndi_insufficient_credit`, `ndi_rate_limited`, `ndi_job_failed`, `ndi_timeout`, `ndi_network`,
  `no_verified_facts`. Nothing is hardcoded as a stand-in.
- Label rule for the UI: say "NDI (live job <id>)" only when `status().source === "ndi_live"`, and
  "NDI (cached result of job <id>, ran <ranAt>)" when it is `"ndi_cache"`.

## Script
`npm run ndi:ingest` (root or `apps/server`). Uses the cache when present; `-- --force` runs and pays for new jobs;
`-- --json` for machine output; `-- --no-color` for plain text. Prints document metadata, job ids, elapsed time, cost, a
page map of where each fact sits and the facts. Never prints the key.

## The 9 facts (quotes are NDI's output; SFPD DGO 5.25, pages are PDF pages of the notice file)
| field | page | quote |
|---|---|---|
| pursuit_may_start_when | 2 | "An officer may initiate a foot pursuit when they reasonably believe the person has committed an act that would justify a detention, custody, or arrest (See General Order 5.03, Investigative Detentions)." |
| keep_weighing_need_against_risk | 3 | "Officers initiating a foot pursuit or implementing containment procedures, shall act reasonably and shall continually assess and evaluate whether the need for apprehension justifies the safety risk based upon the evolving circumstances of the pursuit. Officers shall weigh the necessity of immediate apprehension (including, but not limited to, the severity of the crime) against the danger to the pursuing officer(s), the fleeing person and the public." |
| decide_on_facts_known_at_the_time | 3 | "When deciding to engage, not to engage, or discontinue a foot pursuit, the officer's decision must be evaluated based on the facts and totality of the circumstances known to the officer at the time the decision was made rather than evaluated using the benefit of hindsight." |
| if_sight_of_person_is_lost | 4 | "For example, when officers lose sight of a person, the danger increases significantly, and the threat of ambush becomes higher. When this occurs, officers should consider transitioning from 'pursuit to apprehend' to 'pursuit to contain.'" |
| unsure_of_location_is_a_safety_issue | 3 | "The officer becomes unsure of the person's location or direction of travel." |
| hold_position_where_last_seen | 4 | "Use protective cover or a position of advantage near where the person was last seen;" |
| broadcast_description_and_direction | 4 | "Broadcast the person's description and last direction of travel (or current location);" |
| safety_is_the_priority | 2 | "The priority for officers engaging in a foot pursuit is safety." |
| supervisor_must_monitor | 5 | "supervisors shall make every effort to monitor, respond to and continually assess the situation." |

## Honest limits
- The order does not use the words "second-hand report". The two rules the game maps to that question are
  `decide_on_facts_known_at_the_time` and `unsure_of_location_is_a_safety_issue`; the mapping is ours and is labelled as
  ours (`status().facts[].gameUse`), never shown as document text.
- The spec (FR-064, tech design 13) asked for a fictional PDF; this job replaced it with a real one for the bonus.
- The document hash is pinned. If SFPD replaces the file, a fresh ingestion is refused (`document_hash_mismatch`) until the
  pin in `apps/server/src/policy/document.ts` is updated on purpose. The cached result keeps working.
- The 9 facts add about 2.8 KB of JSON (`department_policy`) to every police Drex call.
- The web store sets `policy` only from a snapshot. With the cache on this machine the policy is ready 3 ms after boot,
  before anyone joins. On a machine without `data/ndi/`, run `npm run ndi:ingest` once before the demo.
