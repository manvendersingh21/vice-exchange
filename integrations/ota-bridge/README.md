# VICE EXCHANGE 3D world client (Open Theft Auto bridge)

Runs the open-source Godot game [Open Theft Auto](https://github.com/mehulkapadia5/open-theft-auto) (MIT, Godot 4.7,
procedural city) as a 3D client of the VICE EXCHANGE server. The server stays authoritative for the swarm, the market
and capture; this client renders server state inside the city and sends the same validated commands as the browser.

The upstream game is not committed (437 MB of assets). This folder holds only what we add:

| File | Purpose |
|---|---|
| `vice_bridge.gd` | Autoload `ViceBridge`: WebSocket client, swarm NPCs and remote players, HUD, look, FX, verification modes |
| `apply.py` | Idempotent installer: copies the autoload and makes six small guarded edits to upstream files |
| `frames/` | Real captures from the running game, and the full-chain clip |

## Setup
```
brew install --cask godot
git clone --depth 1 https://github.com/mehulkapadia5/open-theft-auto.git integrations/open-theft-auto
python3 integrations/ota-bridge/apply.py
godot --headless --path integrations/open-theft-auto --import
```
Launch commands and keys: see `.swarm/board/GODOT.md`.

## What the edits to upstream do
All are no-ops unless the game is started with `-- --vice`: optional windowed mode, a generic civilian rig for the local
player, no suit summon, no single-player hint toasts, and no reading or writing of the single-player save. In bridge mode
the bridge also skips the upstream boot screen, hides the single-player HUD, pins the upstream wanted level to zero (the
only police are the swarm's), holds the clock at dusk and swaps unclothed pedestrian rigs for clothed ones.

## Coordinates
The server plane is 120 x 80 m. `city.x = 112 + (sim.x - 62) * 32/30`, `city.z = -16 + (sim.z - 28) * 32/26`, which puts
the server's road centres on the city's 32 m road grid. The client reports its position with `player.pose`; the server
checks bounds and speed. **Perception and line of sight are computed by the server on its own map**, not on the city's
buildings, so what an NPC "sees" follows the server's blocks, which only roughly match the city's.

## Honesty rules kept
Decision popups and the HUD feed print the real `decisionSource`: the word DREX appears only when Drex decided;
guardrail, fallback, scripted and meta are labelled as such and coloured differently. Confidence and latency are shown
only when the server supplied them.

## Verification modes
`--vice-check` (works headless): join, ticks, buy with `]`, walk to the job, press `E`, wait for capture, press `R`.
`--vice-hunt` with role HUNTER shadows the outlaw and captures with `E`. `--vice-shots=<dir>` saves PNG frames.
`--vice-record=<dir>` saves real-time JPEG frames plus `frames.txt`; build the clip with
`ffmpeg -f concat -safe 0 -i frames.txt -vf fps=24,format=yuv420p -c:v libx264 out.mp4`.

## Credits and limits
Upstream game: MIT, copyright mehulkapadia5. Human rigs used for our figures are upstream's CC-BY models (Renderpeople
"Nathan" and the two suit models; see each `license.txt` upstream). The bridge does not use upstream's boot-screen
branding, its superhero-suit content or its "peter" player model. Known limits are listed on the board.
