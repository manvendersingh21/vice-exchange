#!/usr/bin/env python3
"""Apply the VICE EXCHANGE bridge to a checkout of Open Theft Auto (idempotent).

Usage: python3 integrations/ota-bridge/apply.py [path-to-open-theft-auto]

It copies one new autoload script and makes five small, guarded edits to upstream files.
Every edit is a no-op unless the game is launched with `-- --vice`, so the upstream game
is unchanged for anyone who runs it normally.
"""
import pathlib
import shutil
import sys

here = pathlib.Path(__file__).resolve().parent
target = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else here.parent / "open-theft-auto"
if not (target / "project.godot").exists():
    sys.exit(f"not an Open Theft Auto checkout: {target}")

MARK = "# VICE"
changed = []


def patch(rel: str, old: str, new: str, label: str) -> None:
    path = target / rel
    text = path.read_text()
    if new in text:
        return  # already applied
    if old not in text:
        sys.exit(f"cannot apply '{label}': anchor not found in {rel} (upstream changed?)")
    path.write_text(text.replace(old, new, 1))
    changed.append(f"{rel}: {label}")


# 1. the new autoload
dest = target / "scripts" / "autoload" / "vice_bridge.gd"
src = here / "vice_bridge.gd"
if not dest.exists() or dest.read_text() != src.read_text():
    shutil.copyfile(src, dest)
    changed.append("scripts/autoload/vice_bridge.gd: copied")

patch("project.godot",
      'SaveGame="*res://scripts/autoload/save_game.gd"\n',
      'SaveGame="*res://scripts/autoload/save_game.gd"\nViceBridge="*res://scripts/autoload/vice_bridge.gd"\n',
      "register ViceBridge autoload")

# 2. keep a window (for capture and side-by-side demo) when asked
patch("scripts/game.gd",
      "\tDisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN)\n",
      f"\tif not ViceBridge.windowed:  {MARK}\n\t\tDisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN)\n",
      "optional windowed mode")

# 3. bridge mode uses the generic civilian rig for the local player
patch("scripts/game.gd",
      '\tplayer_node = Human.build_model("peter")',
      f'\tplayer_node = Human.build_model("nathan" if ViceBridge.active else "peter")  {MARK}\n\t#',
      "generic player rig in bridge mode")

# 4. the suit pickup is not part of the bridge demo
patch("scripts/game.gd",
      "func _handle_action(name: String) -> void:\n",
      f"func _handle_action(name: String) -> void:\n\tif ViceBridge.active and name == \"summon_suit\":  {MARK}\n\t\treturn\n",
      "no suit summon in bridge mode")

# 4b. the single-player hint toasts (which advertise content this demo does not use) stay off;
#     the bridge shows its own messages through the HUD directly
patch("scripts/game.gd",
      "func _show_objective(text: String, secs := 3.5) -> void:\n",
      f"func _show_objective(text: String, secs := 3.5) -> void:\n\tif ViceBridge.active:  {MARK}\n\t\treturn\n",
      "no single-player hint toasts in bridge mode")

# 5. bridge sessions never read or write the single-player save
patch("scripts/autoload/save_game.gd",
      "func has_save() -> bool:\n",
      f"func has_save() -> bool:\n\tif ViceBridge.active:  {MARK}\n\t\treturn false\n",
      "ignore saves in bridge mode")
patch("scripts/autoload/save_game.gd",
      "func save_now() -> void:\n",
      f"func save_now() -> void:\n\tif ViceBridge.active:  {MARK}\n\t\treturn\n",
      "do not save in bridge mode")

print("applied:" if changed else "already applied; nothing to do")
for c in changed:
    print("  -", c)
