# GODOT board — 3D world client (Open Theft Auto, Godot 4.7)

Address: a0e7dbb5b6c9ab618. Status: working end to end; art pass in progress until 13:50.

## Launch (server on port 3001 must be running: `npm run dev`)
One-time setup (already done on this Mac): `brew install --cask godot`, clone
https://github.com/mehulkapadia5/open-theft-auto into `integrations/open-theft-auto`, then
`python3 integrations/ota-bridge/apply.py` and `godot --headless --path integrations/open-theft-auto --import`.

Outlaw window (default room VICE-42):
```
cd "/Users/manubaba/Documents/vice city/vice-exchange-claude/integrations/open-theft-auto"
godot --path . -- --vice --vice-windowed --vice-size=1600x900 --vice-name=ACE --vice-role=OUTLAW --vice-room=VICE-42 --vice-url=ws://127.0.0.1:3001/bridge
```
Hunter window (second player, same room):
```
cd "/Users/manubaba/Documents/vice city/vice-exchange-claude/integrations/open-theft-auto"
godot --path . -- --vice --vice-windowed --vice-size=1600x900 --vice-name=VEX --vice-role=HUNTER --vice-room=VICE-42 --vice-url=ws://127.0.0.1:3001/bridge
```
Second laptop: replace 127.0.0.1 with this Mac's Wi-Fi address. Drop `--vice-windowed` for fullscreen.
Other flags: `--vice-time=18.3` (clock, default neon dusk; 17.2 golden hour; -1 lets it run), `--vice-look=plain`,
`--vice-keep-hud`, `--vice-no-ambient`, `--vice-room=NEW` (private room), `--vice-mode=scripted` (room creator only).

## Keys
WASD move, mouse look, Shift sprint, F enter/exit a car. **E** grab the job when the prompt shows (Outlaw) or capture a
WANTED outlaw within 2.5 m (Hunter). **R** respawn as a new character and ticker after capture. **]** buy 1 share,
**[** sell 1 share (own ticker for an outlaw, first active ticker for a hunter). Click the window once to capture the mouse.

## What the bridge is
- Server: `apps/server/src/bridge/index.ts`, plain WebSocket at `/bridge`, mounted by ENGINE in `transport/app.ts`.
  Same `clientCommandSchema` validation and `RoomEngine.dispatch` path as the browser; position comes in as `player.pose`.
- Godot: `integrations/ota-bridge/vice_bridge.gd` (autoload ViceBridge) + `apply.py` (six small guarded edits to
  upstream files, all no-ops without `-- --vice`). Upstream checkout is git-ignored.
- Mapping: city.x = 112 + (sim.x - 62) * 32/30, city.z = -16 + (sim.z - 28) * 32/26. Sim roads land on the city's
  road grid. Server perception and line of sight use the server's own map, not the city's buildings.

## Verified (real runs, two Godot clients, real E / R / ] keys)
join, 8 NPCs + remote player rendered, ticks, pose (0 rejections), buy (2000 -> 1903), job, witness report, wanted
(heat 42, level 2), capture by hunter (+V$100 bounty) and by Drex-driven police, listing HALTED_CAPTURED at 0,
banner, respawn to a new ticker (ACE-02) with the old one still halted. Drex mode shows real decisions in the HUD feed.
Verification commands: add `--vice-check` (headless ok), `--vice-hunt`, `--vice-shots=<dir>`, `--vice-record=<dir>`.

## Not verified / limits
- Manual play with a human at the keyboard (all runs were scripted through the real key path).
- FALLBACK and META decision popups were not captured on a frame (colours exist in code).
- A bridge client that created a private room loses it when the watch-mode server restarts (it then creates a new one).
- About 40 fps at 1280x720 while recording on this Mac with the neon look and background life.
- Frames and clip: `integrations/ota-bridge/frames/`.
