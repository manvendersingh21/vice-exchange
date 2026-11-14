extends Node
## VICE EXCHANGE world bridge (autoload "ViceBridge").
##
## Turns this city into a 3D world client of the VICE EXCHANGE server. The server stays
## authoritative for the swarm, the market and capture; this script only renders what the
## server says and sends the same validated commands a browser client sends.
##
## Inert unless the game is launched with user args:   godot --path . -- --vice [options]
##   --vice-url=ws://127.0.0.1:3001/bridge   --vice-room=VICE-42
##   --vice-name=ACE   --vice-role=OUTLAW|HUNTER|SPECTATOR
##   --vice-windowed            keep the window (no exclusive fullscreen)
##   --vice-shots=<dir>         verification: save PNG frames of the swarm in the city, then quit
##   --vice-check               verification (headless ok): join, receive ticks, walk to the mission, interact, quit

# ---------------------------------------------------------------- coordinates
# The server simulates a 120 x 80 m plane (x east, z south). Its road centres are at
# x = 32 / 62 / 92 and z = 28 / 54. This city's roads are on a 32 m grid, so one
# anisotropic affine transform lands sim roads on city roads and sim blocks on city blocks:
#     city.x = ANCHOR_CITY.x + (sim.x - ANCHOR_SIM.x) * SCALE.x
#     city.z = ANCHOR_CITY.y + (sim.z - ANCHOR_SIM.y) * SCALE.y
# (apps/server/src/bridge/README.md documents the same constants for the server side.)
const ANCHOR_SIM := Vector2(62.0, 28.0)
const ANCHOR_CITY := Vector2(112.0, -16.0)
const SCALE := Vector2(32.0 / 30.0, 32.0 / 26.0)
const SIM_MIN := Vector2(1.5, 1.5)      # just inside the server's walkable rectangle
const SIM_MAX := Vector2(118.5, 72.5)

const INTERACT_RADIUS := 2.5            # sim metres (server rule; the server re-checks)
const POSE_INTERVAL := 0.1
const ROLE_COLOR := {
	"WITNESS": Color("4ee1e6"), "INFORMANT": Color("b98cff"), "TRADER": Color("9be37a"),
	"POLICE": Color("6fa8ff"), "OUTLAW": Color("ff5fa8"), "HUNTER": Color("ffb347"),
}
const PINK := Color("ff4fa3")
const AQUA := Color("3fe0e6")
const TEXT := Color("f2eefc")
const DIM := Color("a79fc4")
const DANGER := Color("ff4d6d")
const GOOD := Color("7dffb0")

# ---------------------------------------------------------------- config / state
var active := false
var windowed := false
var url := "ws://127.0.0.1:3001/bridge"
var room_code := "VICE-42"
var nickname := "ACE"
var role := "OUTLAW"
var shots_dir := ""
var check_mode := false

var game = null                 # the upstream game node (scenes/main.tscn root)
var ws: WebSocketPeer = null
var ws_open := false
var joined := false
var session_token := ""
var my_player_id := ""
var my_character_id := ""
var my_role := ""
var state: Dictionary = {}
var have_state := false
var need_teleport := false
var ticks_seen := 0
var events_seen := 0
var pose_rejects := 0
var outside_sector := false

var _seq := 0
var _pending: Dictionary = {}   # n -> kind
var _reconnect_t := 0.0
var _pose_t := 0.0
var _last_pose := Vector2(-999, -999)
var _last_pose_sent_at := 0.0
var _prompt_action := ""        # "", "mission", "capture"
var _prompt_target := ""
var _notice := ""
var _notice_until := 0.0
var _banner_until := 0.0
var _feed: Array = []
var _prev_spot := -1
var _trend := ""
var _started_game := false
var _check_started_at := 0.0
var _check_stage := ""
var _shots_started := false

var entities: Dictionary = {}   # id -> { node, label, ring, pos, target, yaw, phase, kind, base, extra }
var beacons: Dictionary = {}    # mission id -> Node3D
var _free_cache: Dictionary = {}

var hud_layer: CanvasLayer
var hud_title: Label
var hud_main: Label
var hud_stats: Label
var hud_feed: Label
var hud_prompt: Label
var hud_prompt_panel: PanelContainer
var hud_banner: Label
var hud_banner_sub: Label
var hud_banner_box: Control


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for arg in OS.get_cmdline_user_args():
		if arg == "--vice": active = true
		elif arg == "--vice-windowed": windowed = true
		elif arg == "--vice-check": check_mode = true; active = true
		elif arg.begins_with("--vice-url="): url = arg.trim_prefix("--vice-url=")
		elif arg.begins_with("--vice-room="): room_code = arg.trim_prefix("--vice-room=").to_upper()
		elif arg.begins_with("--vice-name="): nickname = arg.trim_prefix("--vice-name=").substr(0, 16)
		elif arg.begins_with("--vice-role="): role = arg.trim_prefix("--vice-role=").to_upper()
		elif arg.begins_with("--vice-shots="):
			shots_dir = arg.trim_prefix("--vice-shots="); active = true; windowed = true
	if not active:
		set_process(false)
		set_process_input(false)
		return
	if not (role in ["OUTLAW", "HUNTER", "SPECTATOR"]): role = "OUTLAW"
	if shots_dir != "": DirAccess.make_dir_recursive_absolute(shots_dir)
	_build_hud()
	_check_started_at = _now()
	print("[vice] bridge active url=%s room=%s name=%s role=%s" % [url, room_code, nickname, role])


func _now() -> float:
	return Time.get_ticks_msec() / 1000.0


# ---------------------------------------------------------------- transform helpers
func sim_to_city(x: float, z: float) -> Vector2:
	return Vector2(ANCHOR_CITY.x + (x - ANCHOR_SIM.x) * SCALE.x, ANCHOR_CITY.y + (z - ANCHOR_SIM.y) * SCALE.y)

func city_to_sim(gx: float, gz: float) -> Vector2:
	return Vector2(ANCHOR_SIM.x + (gx - ANCHOR_CITY.x) / SCALE.x, ANCHOR_SIM.y + (gz - ANCHOR_CITY.y) / SCALE.y)

func _ground(gx: float, gz: float) -> float:
	if game == null or game.world == null: return 0.0
	return game.world.surface_height(gx, gz)

## Nearest spot to (gx, gz) that the city's own collision test says is walkable.
func _free_spot(gx: float, gz: float, radius := 0.6) -> Vector2:
	if game == null or game.world == null: return Vector2(gx, gz)
	var key := Vector2i(roundi(gx * 2.0), roundi(gz * 2.0))
	if _free_cache.has(key): return _free_cache[key]
	var out := Vector2(gx, gz)
	if game.world.collides_at(gx, gz, radius):
		var found := false
		for ring in range(1, 16):
			var n := 8 + ring * 2
			for i in n:
				var a := float(i) / float(n) * TAU
				var x := gx + cos(a) * ring
				var z := gz + sin(a) * ring
				if not game.world.collides_at(x, z, radius):
					out = Vector2(x, z); found = true
					break
			if found: break
	if _free_cache.size() > 4000: _free_cache.clear()
	_free_cache[key] = out
	return out

func my_sim_pos() -> Vector2:
	if game == null: return Vector2.ZERO
	var p: Vector3 = game.player_pos
	return city_to_sim(p.x, p.z)


# ---------------------------------------------------------------- main loop
func _process(dt: float) -> void:
	if game == null:
		var scene := get_tree().current_scene
		if scene != null and "player_pos" in scene and "world" in scene and scene.world != null:
			game = scene
			if not check_mode: _start_game()
		else:
			return
	_pump_socket(dt)
	if joined and have_state:
		if need_teleport: _teleport_to_server_position()
		_send_pose(dt)
		_update_entities(dt)
		_update_prompts()
	_update_hud()
	if check_mode: _run_check()
	elif shots_dir != "" and joined and have_state and not _shots_started and entities.size() >= 8:
		_shots_started = true
		_run_shots()


## Skip the upstream boot screen and start a fresh run with our overlay.
func _start_game() -> void:
	if _started_game: return
	_started_game = true
	if game.hud != null: game.hud.visible = false
	game._on_start()
	if game.hud != null: game.hud.visible = true
	# The upstream suit pickup is not part of this demo: park it out of the world.
	if game.suit_node != null:
		game.suit_armed = false
		game.suit_node.visible = false
		game.suit_node.position = Vector3(0, -800, 0)
	if game.hud != null:
		game.hud.show_objective("VICE EXCHANGE: every character is a ticker. Survive to grow your value. Witnesses, informants, traders and police decide for themselves.", 7.0)
	if shots_dir != "" or windowed:
		pass
	if shots_dir != "":
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


# ---------------------------------------------------------------- socket
func _pump_socket(dt: float) -> void:
	if ws == null:
		_reconnect_t -= dt
		if _reconnect_t > 0.0: return
		ws = WebSocketPeer.new()
		ws.inbound_buffer_size = 1 << 20
		ws.max_queued_packets = 4096
		var err := ws.connect_to_url(url)
		if err != OK:
			ws = null
			_reconnect_t = 2.0
		return
	ws.poll()
	var st := ws.get_ready_state()
	if st == WebSocketPeer.STATE_OPEN:
		if not ws_open:
			ws_open = true
			print("[vice] bridge connected")
			_send_join()
		while ws.get_available_packet_count() > 0:
			var pkt := ws.get_packet()
			if ws.was_string_packet():
				var msg = JSON.parse_string(pkt.get_string_from_utf8())
				if typeof(msg) == TYPE_DICTIONARY: _on_message(msg)
	elif st == WebSocketPeer.STATE_CLOSED:
		if ws_open: print("[vice] bridge disconnected (code %d)" % ws.get_close_code())
		ws = null
		ws_open = false
		joined = false
		_reconnect_t = 2.0
		_pending.clear()


func _send(cmd: Dictionary, kind := "") -> void:
	if ws == null or not ws_open: return
	_seq += 1
	if kind != "": _pending[_seq] = kind
	ws.send_text(JSON.stringify({"t": "cmd", "n": _seq, "cmd": cmd}))

func _cid(prefix: String) -> String:
	return "%s-%d-%d" % [prefix, Time.get_ticks_usec(), randi() % 100000]

func _send_join() -> void:
	# --vice-room=NEW creates a private room (used by the verification modes so they never touch the demo room).
	if room_code == "NEW":
		_send({"type": "room.create", "nickname": nickname, "role": role, "requestId": _cid("gjoin")}, "join")
		return
	var cmd := {"type": "room.join", "roomCode": room_code, "nickname": nickname, "role": role, "requestId": _cid("gjoin")}
	if session_token != "": cmd["sessionToken"] = session_token
	_send(cmd, "join")


func _on_message(msg: Dictionary) -> void:
	match str(msg.get("t", "")):
		"ack": _on_ack(msg)
		"tick": _on_tick(msg)
		"state": _on_state(msg)
		"event":
			var e = msg.get("e")
			if typeof(e) == TYPE_DICTIONARY: _on_event(e)


func _on_ack(msg: Dictionary) -> void:
	var n := int(msg.get("n", 0)) if msg.get("n") != null else 0
	var kind: String = _pending.get(n, "")
	_pending.erase(n)
	var ack: Dictionary = msg.get("ack", {})
	var ok: bool = bool(ack.get("ok", false))
	var err: Dictionary = ack.get("error", {}) if typeof(ack.get("error")) == TYPE_DICTIONARY else {}
	match kind:
		"join":
			if ok:
				var r: Dictionary = ack.get("result", {})
				joined = true
				session_token = str(r.get("sessionToken", ""))
				my_player_id = str(r.get("playerId", ""))
				my_character_id = str(r.get("characterId", "")) if r.get("characterId") != null else ""
				my_role = str(r.get("role", role))
				room_code = str(r.get("roomCode", room_code))
				need_teleport = true
				print("[vice] joined room=%s player=%s character=%s role=%s" % [str(r.get("roomCode", "")), my_player_id, my_character_id, my_role])
			else:
				_set_notice("JOIN FAILED: %s" % str(err.get("message", "?")), 6.0)
				print("[vice] join failed: ", err)
				if ws != null: ws.close()
		"pose":
			if not ok: pose_rejects += 1
		"mission":
			if ok:
				_set_notice("JOB DONE: notoriety up, heat up", 4.0)
				print("[vice] mission ack ok")
			else:
				_set_notice("MISSION: %s" % str(err.get("message", "rejected")), 3.0)
				print("[vice] mission rejected: ", err)
		"capture":
			if ok: _set_notice("CAPTURE CONFIRMED", 4.0)
			else: _set_notice("CAPTURE: %s" % str(err.get("reason", err.get("message", "rejected"))), 3.0)
		"respawn":
			if ok: need_teleport = true
			else: _set_notice("RESPAWN: %s" % str(err.get("message", "rejected")), 3.0)
		"trade":
			if ok: _set_notice("ORDER FILLED", 2.0)
			else: _set_notice("ORDER: %s" % str(err.get("reason", err.get("message", "rejected"))), 3.0)


func _on_state(msg: Dictionary) -> void:
	state = msg
	have_state = true
	var you = msg.get("you")
	if typeof(you) == TYPE_DICTIONARY:
		var cid := str(you.get("characterId", "")) if you.get("characterId") != null else ""
		if cid != my_character_id:
			my_character_id = cid
			need_teleport = true
		my_player_id = str(you.get("playerId", my_player_id))
		my_role = str(you.get("role", my_role))
	_sync_entities()
	_sync_beacons()
	var l := _my_listing()
	if not l.is_empty():
		var spot := int(l.get("spotPrice", 0))
		if _prev_spot >= 0 and spot != _prev_spot:
			_trend = "▲" if spot > _prev_spot else "▼"
		_prev_spot = spot


func _on_tick(msg: Dictionary) -> void:
	ticks_seen += 1
	for c in msg.get("characters", []):
		var id := str(c.get("id", ""))
		if entities.has(id):
			var e: Dictionary = entities[id]
			e.sim = Vector2(float(c.get("x", 0.0)), float(c.get("z", 0.0)))
			e.heat = float(c.get("heat", 0.0))
			e.status = str(c.get("status", ""))
	for n in msg.get("npcs", []):
		var nid := str(n.get("id", ""))
		if entities.has(nid):
			var en: Dictionary = entities[nid]
			en.sim = Vector2(float(n.get("x", 0.0)), float(n.get("z", 0.0)))
			en.activity = str(n.get("activity", ""))
			en.pending = bool(n.get("pending", false))


func _npc_name(id: String) -> String:
	for n in state.get("npcs", []):
		if str(n.get("id", "")) == id: return str(n.get("name", id))
	for p in state.get("players", []):
		if str(p.get("id", "")) == id: return str(p.get("nickname", id))
	return id

func _source_label(src) -> String:
	match str(src):
		"drex": return "DREX"
		"meta": return "META"
		"scripted": return "SCRIPTED"
		"fallback": return "FALLBACK"
		"drex_low_confidence_guardrail": return "DREX GUARDRAIL"
		"replay": return "REPLAY"
	return str(src).to_upper()

func _on_event(e: Dictionary) -> void:
	events_seen += 1
	var p: Dictionary = e.get("payload", {}) if typeof(e.get("payload")) == TYPE_DICTIONARY else {}
	var line := ""
	match str(e.get("type", "")):
		"MISSION_COMPLETED":
			line = "%s pulled a job (notoriety %d, heat %d)" % [str(p.get("ticker", "?")), int(p.get("notorietyPoints", 0)), int(p.get("heat", 0))]
		"NPC_OBSERVED":
			line = "%s saw: %s" % [_npc_name(str(p.get("npcId", ""))), str(p.get("summary", ""))]
		"AGENT_MESSAGE_SENT":
			line = "%s → %s  (%s)" % [_npc_name(str(p.get("senderId", ""))), _npc_name(str(p.get("recipientId", ""))), str(p.get("kind", ""))]
		"DECISION_RESOLVED":
			var conf = p.get("confidence")
			var conf_txt := (" %.2f" % float(conf)) if conf != null else ""
			var ms = p.get("latencyMs")
			var ms_txt := (" %d ms" % int(ms)) if ms != null else ""
			line = "%s chose %s  [%s%s%s]" % [_npc_name(str(p.get("agentId", ""))), str(p.get("chosenAction", "?")).to_upper(), _source_label(p.get("decisionSource")), conf_txt, ms_txt]
		"BULLETIN_PUBLISHED":
			line = "WANTED BULLETIN issued for %s" % str(p.get("ticker", "?"))
		"WANTED_STATUS_CHANGED":
			line = "%s is %s" % [str(p.get("ticker", "?")), "WANTED" if bool(p.get("wanted", false)) else "no longer wanted"]
		"TRADE_EXECUTED":
			line = "%s %s %s @ V$%d" % [str(p.get("actorName", "?")), str(p.get("side", "")), str(p.get("ticker", "")), int(p.get("executionPrice", 0))]
		"ESCAPE_SUCCEEDED":
			line = "%s escaped the heat" % str(p.get("ticker", "?"))
		"LISTING_OPENED":
			line = "%s listed at V$%d" % [str(p.get("ticker", "?")), int(p.get("spotPrice", 0))]
		"LISTING_HALTED":
			line = "%s HALTED at V$0" % str(p.get("ticker", "?"))
		"CAPTURE_SUCCEEDED":
			line = "%s CAPTURED %s (bounty V$%d)" % [str(p.get("captorName", "?")), str(p.get("ticker", "?")), int(p.get("bounty", 0))]
			var mine := str(p.get("characterId", "")) == my_character_id and my_character_id != ""
			_show_banner("%s  →  V$0" % str(p.get("ticker", "?")),
				("YOU WERE CAPTURED by %s. Press R for a new character and a new ticker." % str(p.get("captorName", "?"))) if mine
				else ("Captured by %s. Listing halted. Bounty V$%d." % [str(p.get("captorName", "?")), int(p.get("bounty", 0))]), 8.0)
		"ROOM_RESET":
			line = "ROOM RESET (seeded)"
			need_teleport = true
			_feed.clear()
	if line != "":
		_feed.append(line)
		while _feed.size() > 4: _feed.pop_front()


# ---------------------------------------------------------------- world entities
func _build_figure(kind: String, id: String) -> Node3D:
	# Uses the city's existing human rigs. Only the generic civilian / suit rigs are used here.
	var node: Node3D
	match kind:
		"POLICE": node = Human.build(0xf4c28a, 0x232f44, 0x14192a, 0x2a1a08, 0x14192a)
		"TRADER": node = Human.build_model("vip_suit")
		"INFORMANT": node = Human.build_model("guard_suit")
		"WITNESS":
			var alt := id.ends_with("2")
			node = Human.build(0xd99770 if alt else 0xf4c28a, 0x9c8a64 if alt else 0x47586a, 0x33384a, 0x222222 if alt else 0x4a2a1a, -1, not alt)
		"HUNTER": node = Human.build(0xa87657, 0x5a4c46, 0x2a2e36, 0x222222)
		_: node = Human.build_model("nathan")
	return node

func _ensure_entity(id: String, kind: String, sim: Vector2) -> Dictionary:
	if entities.has(id) and entities[id].kind == kind: return entities[id]
	if entities.has(id): _drop_entity(id)
	var node := _build_figure(kind, id)
	var color: Color = ROLE_COLOR.get(kind, TEXT)
	var label := Label3D.new()
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.no_depth_test = true
	label.pixel_size = 0.0042
	label.font_size = 72
	label.outline_size = 22
	label.outline_modulate = Color(0.03, 0.02, 0.08, 0.95)
	label.modulate = color
	label.position = Vector3(0, 2.75, 0)
	label.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	node.add_child(label)
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.72
	tm.outer_radius = 0.86
	ring.mesh = tm
	var rm := StandardMaterial3D.new()
	rm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	rm.albedo_color = color
	rm.emission_enabled = true
	rm.emission = color
	rm.emission_energy_multiplier = 2.0
	ring.material_override = rm
	ring.position = Vector3(0, 0.06, 0)
	node.add_child(ring)
	game.add_child(node)
	var g := sim_to_city(sim.x, sim.y)
	var f := _free_spot(g.x, g.y)
	var pos := Vector3(f.x, _ground(f.x, f.y), f.y)
	node.position = pos
	var e := {"node": node, "label": label, "ring": ring, "kind": kind, "sim": sim, "pos": pos, "yaw": 0.0, "phase": randf() * TAU,
		"base": "", "extra": "", "activity": "", "pending": false, "heat": 0.0, "status": "", "moving": false}
	entities[id] = e
	return e

func _drop_entity(id: String) -> void:
	if not entities.has(id): return
	var n = entities[id].node
	if is_instance_valid(n): n.queue_free()
	entities.erase(id)

func _sync_entities() -> void:
	if game == null: return
	var keep := {}
	for n in state.get("npcs", []):
		var id := str(n.get("id", ""))
		var e := _ensure_entity(id, str(n.get("role", "WITNESS")), Vector2(float(n.get("x", 0.0)), float(n.get("z", 0.0))))
		e.base = "%s\n%s" % [str(n.get("name", id)), str(n.get("role", ""))]
		e.activity = str(n.get("activity", ""))
		e.pending = bool(n.get("pending", false))
		var la = n.get("lastAction")
		e.extra = ("%s [%s]" % [str(la).to_upper(), _source_label(n.get("lastSource"))]) if la != null else ""
		keep[id] = true
	for c in state.get("characters", []):
		var cid := str(c.get("id", ""))
		var st := str(c.get("status", ""))
		if cid == my_character_id or st == "CAPTURED" or st == "ARCHIVED": continue
		var ce := _ensure_entity(cid, str(c.get("role", "OUTLAW")), Vector2(float(c.get("x", 0.0)), float(c.get("z", 0.0))))
		var tk = c.get("ticker")
		var price := ""
		if tk != null:
			for l in state.get("listings", []):
				if str(l.get("ticker", "")) == str(tk): price = "  V$%d" % int(l.get("spotPrice", 0))
		ce.base = "%s%s\n%s" % [str(c.get("nickname", cid)), ("  " + str(tk) + price) if tk != null else "", str(c.get("role", ""))]
		ce.extra = "WANTED" if bool(c.get("wanted", false)) else ""
		ce.heat = float(c.get("heat", 0.0))
		ce.status = st
		keep[cid] = true
	for id in entities.keys():
		if not keep.has(id): _drop_entity(id)

func _update_entities(dt: float) -> void:
	for id in entities.keys():
		var e: Dictionary = entities[id]
		var node: Node3D = e.node
		if not is_instance_valid(node): continue
		var g := sim_to_city(e.sim.x, e.sim.y)
		var f := _free_spot(g.x, g.y)
		var target := Vector3(f.x, _ground(f.x, f.y), f.y)
		var d: Vector3 = target - e.pos
		var dist := Vector2(d.x, d.z).length()
		if dist > 25.0:
			e.pos = target                       # teleport (respawn / reset)
		elif dist > 0.02:
			var step := minf(dist, maxf(2.0, dist * 6.0) * dt)
			e.pos += Vector3(d.x, 0, d.z).normalized() * step
			e.pos.y = lerpf(e.pos.y, target.y, clampf(dt * 10.0, 0.0, 1.0))
		e.moving = dist > 0.12
		if e.moving:
			e.yaw = lerp_angle(e.yaw, atan2(d.x, d.z), clampf(dt * 10.0, 0.0, 1.0))
			e.phase += dt * (9.0 if dist > 1.2 else 6.0)
		elif game != null and e.kind != "OUTLAW" and e.kind != "HUNTER":
			# idle NPCs glance at the local player when close
			var pp: Vector3 = game.player_pos
			if e.pos.distance_squared_to(pp) < 100.0:
				e.yaw = lerp_angle(e.yaw, atan2(pp.x - e.pos.x, pp.z - e.pos.z), clampf(dt * 3.0, 0.0, 1.0))
		node.position = e.pos
		node.rotation.y = e.yaw
		Human.animate(node, e.phase, e.moving, 0.55, 0.33)
		var txt: String = e.base
		if e.kind in ["WITNESS", "INFORMANT", "TRADER", "POLICE"]:
			if e.activity != "" and e.activity != "IDLE": txt += " · " + e.activity
			if e.pending: txt += "\n◆ DECIDING…"
			elif e.extra != "": txt += "\n→ " + e.extra
		else:
			if e.status == "WANTED" or e.extra == "WANTED": txt += " · WANTED"
		var lab: Label3D = e.label
		if lab.text != txt: lab.text = txt
		var ring: MeshInstance3D = e.ring
		var pulse := 1.0 + (0.25 * sin(_now() * 8.0) if e.pending else 0.0)
		ring.scale = Vector3(pulse, 1.0, pulse)


func _sync_beacons() -> void:
	if game == null: return
	var keep := {}
	for m in state.get("missions", []):
		var id := str(m.get("id", ""))
		if str(m.get("status", "")) != "AVAILABLE": continue
		keep[id] = true
		if beacons.has(id): continue
		var g := sim_to_city(float(m.get("x", 0.0)), float(m.get("z", 0.0)))
		var root := Node3D.new()
		var y := _ground(g.x, g.y)
		root.position = Vector3(g.x, y, g.y)
		var beam := MeshInstance3D.new()
		var cm := CylinderMesh.new()
		cm.top_radius = 0.45
		cm.bottom_radius = 0.45
		cm.height = 40.0
		beam.mesh = cm
		var bm := StandardMaterial3D.new()
		bm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		bm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		bm.albedo_color = Color(1.0, 0.31, 0.64, 0.38)
		bm.cull_mode = BaseMaterial3D.CULL_DISABLED
		beam.material_override = bm
		beam.position = Vector3(0, 20.0, 0)
		root.add_child(beam)
		var disc := MeshInstance3D.new()
		var dm := CylinderMesh.new()
		dm.top_radius = INTERACT_RADIUS * SCALE.x
		dm.bottom_radius = INTERACT_RADIUS * SCALE.x
		dm.height = 0.05
		disc.mesh = dm
		var dmat := StandardMaterial3D.new()
		dmat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		dmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		dmat.albedo_color = Color(1.0, 0.31, 0.64, 0.45)
		disc.material_override = dmat
		disc.position = Vector3(0, 0.1, 0)
		root.add_child(disc)
		var label := Label3D.new()
		label.text = "JOB\n%s" % str(m.get("label", "Mission"))
		label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		label.no_depth_test = true
		label.pixel_size = 0.006
		label.font_size = 72
		label.outline_size = 22
		label.outline_modulate = Color(0.03, 0.02, 0.08, 0.95)
		label.modulate = PINK
		label.position = Vector3(0, 4.2, 0)
		root.add_child(label)
		game.add_child(root)
		beacons[id] = root
	for id in beacons.keys():
		if not keep.has(id):
			if is_instance_valid(beacons[id]): beacons[id].queue_free()
			beacons.erase(id)


# ---------------------------------------------------------------- local player
func _my_character() -> Dictionary:
	for c in state.get("characters", []):
		if str(c.get("id", "")) == my_character_id: return c
	return {}

func _my_listing() -> Dictionary:
	var c := _my_character()
	if c.is_empty() or c.get("ticker") == null: return {}
	for l in state.get("listings", []):
		if str(l.get("ticker", "")) == str(c.get("ticker")): return l
	return {}

func _teleport_to_server_position() -> void:
	var c := _my_character()
	if c.is_empty():
		need_teleport = false
		return
	var g := sim_to_city(float(c.get("x", 60.0)), float(c.get("z", 40.0)))
	var f := _free_spot(g.x, g.y, 0.8)
	game.player_pos = Vector3(f.x, _ground(f.x, f.y), f.y)
	if game.player_node != null: game.player_node.position = game.player_pos
	_last_pose = Vector2(-999, -999)
	need_teleport = false
	print("[vice] local player placed at city (%.1f, %.1f) = sim (%.1f, %.1f)" % [f.x, f.y, float(c.get("x", 0.0)), float(c.get("z", 0.0))])

func _send_pose(dt: float) -> void:
	if my_character_id == "": return
	var c := _my_character()
	var st := str(c.get("status", ""))
	if st != "ACTIVE" and st != "WANTED": return
	_pose_t -= dt
	if _pose_t > 0.0: return
	_pose_t = POSE_INTERVAL
	var s := my_sim_pos()
	var clamped := Vector2(clampf(s.x, SIM_MIN.x, SIM_MAX.x), clampf(s.y, SIM_MIN.y, SIM_MAX.y))
	outside_sector = clamped.distance_to(s) > 0.75
	if clamped.distance_to(_last_pose) < 0.03 and _now() - _last_pose_sent_at < 1.0: return
	_last_pose = clamped
	_last_pose_sent_at = _now()
	_send({"type": "player.pose", "x": snappedf(clamped.x, 0.01), "z": snappedf(clamped.y, 0.01)}, "pose")

func _update_prompts() -> void:
	_prompt_action = ""
	_prompt_target = ""
	var c := _my_character()
	if c.is_empty(): return
	var st := str(c.get("status", ""))
	if st == "CAPTURED":
		_prompt_action = "respawn"
		return
	var s := my_sim_pos()
	if my_role == "OUTLAW":
		for m in state.get("missions", []):
			if str(m.get("status", "")) != "AVAILABLE": continue
			if s.distance_to(Vector2(float(m.get("x", 0.0)), float(m.get("z", 0.0)))) <= INTERACT_RADIUS:
				_prompt_action = "mission"
				_prompt_target = str(m.get("id", ""))
				return
	elif my_role == "HUNTER":
		for o in state.get("characters", []):
			if str(o.get("id", "")) == my_character_id or not bool(o.get("wanted", false)): continue
			if str(o.get("status", "")) != "WANTED": continue
			var id := str(o.get("id", ""))
			var os: Vector2 = entities[id].sim if entities.has(id) else Vector2(float(o.get("x", 0.0)), float(o.get("z", 0.0)))
			if s.distance_to(os) <= INTERACT_RADIUS:
				_prompt_action = "capture"
				_prompt_target = id
				return

func _input(event: InputEvent) -> void:
	if not active or not joined: return
	if not (event is InputEventKey) or not event.pressed or event.echo: return
	var key: int = event.physical_keycode if event.physical_keycode != 0 else event.keycode
	if key == KEY_E:
		if _prompt_action == "mission":
			_send({"type": "mission.interact", "missionId": _prompt_target, "commandId": _cid("gmis")}, "mission")
		elif _prompt_action == "capture":
			_send({"type": "capture.attempt", "targetCharacterId": _prompt_target, "commandId": _cid("gcap")}, "capture")
	elif key == KEY_R and _prompt_action == "respawn":
		_send({"type": "character.respawn", "commandId": _cid("grsp")}, "respawn")
	elif key == KEY_BRACKETRIGHT or key == KEY_BRACKETLEFT:
		var tk := _focus_ticker()
		if tk != "":
			_send({"type": "market.buy" if key == KEY_BRACKETRIGHT else "market.sell", "ticker": tk, "qty": 1, "commandId": _cid("gtrd")}, "trade")

func _focus_ticker() -> String:
	var l := _my_listing()
	if not l.is_empty(): return str(l.get("ticker", ""))
	for o in state.get("listings", []):
		if str(o.get("status", "")) == "ACTIVE": return str(o.get("ticker", ""))
	return ""

func _nearest_mission_dist() -> float:
	var s := my_sim_pos()
	var best := -1.0
	for m in state.get("missions", []):
		if str(m.get("status", "")) != "AVAILABLE": continue
		var d := s.distance_to(Vector2(float(m.get("x", 0.0)), float(m.get("z", 0.0))))
		if best < 0.0 or d < best: best = d
	return best


# ---------------------------------------------------------------- HUD
func _label(size: int, color: Color) -> Label:
	var l := Label.new()
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	l.add_theme_color_override("font_outline_color", Color(0.02, 0.01, 0.05, 0.9))
	l.add_theme_constant_override("outline_size", 6)
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

func _panel(border: Color) -> PanelContainer:
	var p := PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.05, 0.03, 0.10, 0.86)
	sb.border_color = border
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	sb.content_margin_left = 22
	sb.content_margin_right = 22
	sb.content_margin_top = 10
	sb.content_margin_bottom = 10
	p.add_theme_stylebox_override("panel", sb)
	p.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return p

func _build_hud() -> void:
	hud_layer = CanvasLayer.new()
	hud_layer.layer = 60
	add_child(hud_layer)
	var root := Control.new()
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hud_layer.add_child(root)

	var top := CenterContainer.new()
	top.set_anchors_preset(Control.PRESET_TOP_WIDE)
	top.offset_top = 14
	top.offset_bottom = 150
	top.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(top)
	var strip := _panel(PINK)
	top.add_child(strip)
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 2)
	vb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	strip.add_child(vb)
	hud_title = _label(17, AQUA)
	hud_main = _label(30, TEXT)
	hud_stats = _label(19, DIM)
	hud_feed = _label(16, Color("d7c8ff"))
	vb.add_child(hud_title)
	vb.add_child(hud_main)
	vb.add_child(hud_stats)
	vb.add_child(hud_feed)

	var bottom := CenterContainer.new()
	bottom.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	bottom.offset_top = -250
	bottom.offset_bottom = -190
	bottom.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(bottom)
	hud_prompt_panel = _panel(AQUA)
	bottom.add_child(hud_prompt_panel)
	hud_prompt = _label(24, TEXT)
	hud_prompt_panel.add_child(hud_prompt)
	hud_prompt_panel.visible = false

	var mid := CenterContainer.new()
	mid.set_anchors_preset(Control.PRESET_FULL_RECT)
	mid.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(mid)
	var bp := _panel(DANGER)
	mid.add_child(bp)
	var bvb := VBoxContainer.new()
	bvb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bp.add_child(bvb)
	hud_banner = _label(84, DANGER)
	hud_banner_sub = _label(26, TEXT)
	bvb.add_child(hud_banner)
	bvb.add_child(hud_banner_sub)
	hud_banner_box = bp
	bp.visible = false

func _set_notice(text: String, secs: float) -> void:
	_notice = text
	_notice_until = _now() + secs

func _show_banner(big: String, sub: String, secs: float) -> void:
	hud_banner.text = big
	hud_banner_sub.text = sub
	hud_banner_box.visible = true
	_banner_until = _now() + secs

func _stars(level: int) -> String:
	var s := ""
	for i in 5: s += "★" if i < level else "☆"
	return s

func _update_hud() -> void:
	if hud_layer == null: return
	if hud_banner_box.visible and _now() > _banner_until: hud_banner_box.visible = false
	if not ws_open:
		hud_title.text = "VICE EXCHANGE"
		hud_main.text = "CONNECTING TO THE EXCHANGE…"
		hud_stats.text = url
		hud_feed.text = ""
		hud_prompt_panel.visible = false
		return
	if not joined or not have_state:
		hud_title.text = "VICE EXCHANGE"
		hud_main.text = "JOINING ROOM %s…" % room_code
		hud_stats.text = ""
		hud_feed.text = ""
		return
	hud_title.text = "VICE EXCHANGE   ·   ROOM %s   ·   %s   ·   V$ ARE FICTIONAL GAME CREDITS" % [str(state.get("roomCode", room_code)), str(state.get("badge", ""))]
	var c := _my_character()
	var w = state.get("wallet")
	var wallet_txt := ("WALLET V$%d" % int(w.get("balanceCredits", 0))) if typeof(w) == TYPE_DICTIONARY else ""
	if c.is_empty():
		hud_main.text = "SPECTATING"
		hud_stats.text = "%d swarm agents live" % state.get("npcs", []).size()
	elif my_role == "OUTLAW":
		var l := _my_listing()
		var st := str(c.get("status", ""))
		if st == "CAPTURED" or l.is_empty() or str(l.get("status", "")) != "ACTIVE":
			hud_main.text = "%s   V$0   HALTED" % str(c.get("ticker", "?"))
			hud_main.add_theme_color_override("font_color", DANGER)
		else:
			hud_main.text = "%s   V$%d %s    BOUNTY ON YOU V$%d" % [str(l.get("ticker", "?")), int(l.get("spotPrice", 0)), _trend, int(l.get("currentBounty", 0))]
			hud_main.add_theme_color_override("font_color", GOOD if _trend == "▲" else (DANGER if _trend == "▼" else TEXT))
		var md := _nearest_mission_dist()
		hud_stats.text = "HEAT %d   WANTED %s   %s   %s%s" % [int(c.get("heat", 0)), _stars(int(c.get("wantedLevel", 0))), wallet_txt,
			("JOB %d m" % int(md)) if md >= 0.0 else "NO JOB YET", "   OUTSIDE CORAL BAY SECTOR" if outside_sector else ""]
	else:
		var tgt := ""
		for o in state.get("characters", []):
			if str(o.get("role", "")) != "OUTLAW" or str(o.get("status", "")) in ["CAPTURED", "ARCHIVED"]: continue
			var bounty := 0
			for l2 in state.get("listings", []):
				if str(l2.get("ticker", "")) == str(o.get("ticker", "")): bounty = int(l2.get("currentBounty", 0))
			var os: Vector2 = entities[str(o.get("id", ""))].sim if entities.has(str(o.get("id", ""))) else Vector2.ZERO
			tgt += "%s%s %s  bounty V$%d  %d m" % ["   |   " if tgt != "" else "", str(o.get("ticker", "?")), "WANTED" if bool(o.get("wanted", false)) else "not wanted", bounty, int(my_sim_pos().distance_to(os))]
		hud_main.text = "HUNTER   %s" % (tgt if tgt != "" else "no outlaws in the city")
		hud_main.add_theme_color_override("font_color", TEXT)
		hud_stats.text = "%s%s" % [wallet_txt, "   OUTSIDE CORAL BAY SECTOR" if outside_sector else ""]
	hud_feed.text = "\n".join(_feed)
	var prompt := ""
	match _prompt_action:
		"mission": prompt = "[E]  GRAB THE PACKAGE"
		"capture": prompt = "[E]  CAPTURE"
		"respawn": prompt = "[R]  RESPAWN AS A NEW CHARACTER (NEW TICKER)"
	if _now() < _notice_until: prompt = _notice
	hud_prompt.text = prompt
	hud_prompt_panel.visible = prompt != ""


# ---------------------------------------------------------------- verification modes
func _fail(reason: String) -> void:
	print("VICE_BRIDGE_FAIL ", reason)
	get_tree().quit(1)

func _run_check() -> void:
	var t := _now() - _check_started_at
	if _check_stage == "":
		if joined and have_state and ticks_seen >= 10:
			var npcs: Array = state.get("npcs", [])
			print("VICE_BRIDGE_JOINED npcs=%d ticks=%d entities=%d character=%s" % [npcs.size(), ticks_seen, entities.size(), my_character_id])
			for m in state.get("missions", []):
				var g := sim_to_city(float(m.get("x", 0.0)), float(m.get("z", 0.0)))
				print("VICE_MISSION %s sim=(%.1f,%.1f) city=(%.1f,%.1f) blocked_in_city=%s" % [str(m.get("id", "")), float(m.get("x", 0.0)), float(m.get("z", 0.0)), g.x, g.y, str(game.world.collides_at(g.x, g.y, 0.5))])
			for id in entities.keys():
				var e: Dictionary = entities[id]
				var gg := sim_to_city(e.sim.x, e.sim.y)
				print("VICE_ENTITY %s kind=%s sim=(%.1f,%.1f) city=(%.1f,%.1f) shown=(%.1f,%.1f)" % [id, e.kind, e.sim.x, e.sim.y, gg.x, gg.y, e.pos.x, e.pos.z])
			_check_stage = "walk" if my_role == "OUTLAW" else "done"
		elif t > 20.0:
			_fail("no join/state/ticks within 20 s (open=%s joined=%s state=%s ticks=%d)" % [str(ws_open), str(joined), str(have_state), ticks_seen])
	elif _check_stage == "walk":
		var target := Vector2(-1, -1)
		for m in state.get("missions", []):
			if str(m.get("status", "")) == "AVAILABLE": target = Vector2(float(m.get("x", 0.0)), float(m.get("z", 0.0)))
		if target.x < 0.0:
			print("VICE_BRIDGE_OK (no mission available to walk to)")
			get_tree().quit()
			return
		var s := my_sim_pos()
		if s.distance_to(target) <= 1.5:
			if _prompt_action == "mission":
				_send({"type": "mission.interact", "missionId": _prompt_target, "commandId": _cid("gmis")}, "mission")
				_check_stage = "await_mission"
				_check_started_at = _now()
		else:
			# Walk the local player straight at the job at 6 m/s (verification only; ignores city collision).
			var g := sim_to_city(target.x, target.y)
			var p: Vector3 = game.player_pos
			var d := Vector2(g.x - p.x, g.y - p.z)
			var step := minf(d.length(), 6.0 * get_process_delta_time())
			var nd := d.normalized() * step
			game.player_pos = Vector3(p.x + nd.x, p.y, p.z + nd.y)
		if t > 60.0: _fail("walk to mission timed out; pose_rejects=%d sim=(%.1f,%.1f)" % [pose_rejects, s.x, s.y])
	elif _check_stage == "await_mission":
		var done := false
		for line in _feed:
			if str(line).contains("pulled a job"): done = true
		if done:
			print("VICE_BRIDGE_MISSION_OK events=%d pose_rejects=%d feed=%s" % [events_seen, pose_rejects, str(_feed)])
			_check_stage = "linger"
			_check_started_at = _now()
		elif t > 8.0:
			_fail("mission.interact not confirmed by a MISSION_COMPLETED event")
	elif _check_stage == "linger":
		if t > 6.0:
			print("VICE_FEED ", str(_feed))
			_check_stage = "done"
	elif _check_stage == "done":
		print("VICE_BRIDGE_OK ticks=%d events=%d" % [ticks_seen, events_seen])
		get_tree().quit()
		_check_stage = "quit"


func _shot(name: String) -> void:
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	var path := shots_dir.path_join(name + ".png")
	img.save_png(path)
	print("VICE_SHOT ", path)

func _stand_near(id: String, d: float) -> void:
	var e: Dictionary = entities[id]
	var best := Vector2(e.pos.x, e.pos.z + d)
	for i in 12:
		var a := float(i) / 12.0 * TAU + PI * 0.5
		var x: float = e.pos.x + cos(a) * d
		var z: float = e.pos.z + sin(a) * d
		if not game.world.collides_at(x, z, 0.8):
			best = Vector2(x, z)
			break
	game.player_pos = Vector3(best.x, _ground(best.x, best.y), best.y)
	game.player_node.position = game.player_pos
	var dx: float = e.pos.x - best.x
	var dz: float = e.pos.z - best.y
	game.cam_yaw = atan2(-dx, -dz)
	game.cam_pitch = 0.12

func _run_shots() -> void:
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	await get_tree().create_timer(2.5).timeout
	await _shot("01_spawn")
	var i := 2
	for id in ["npc_p1", "npc_w1", "npc_t1", "npc_i1", "npc_t2", "npc_p2"]:
		if not entities.has(id): continue
		_stand_near(id, 4.5)
		await get_tree().create_timer(1.4).timeout
		await _shot("%02d_%s" % [i, id])
		i += 1
	var cam := Camera3D.new()
	cam.far = 3000.0
	game.add_child(cam)
	var c := sim_to_city(47.0, 46.0)
	cam.position = Vector3(c.x, 62.0, c.y + 58.0)
	cam.look_at(Vector3(c.x, 0.0, c.y - 6.0))
	cam.current = true
	await get_tree().create_timer(0.6).timeout
	await _shot("%02d_overview" % i)
	cam.queue_free()
	if game.camera != null: game.camera.current = true
	print("VICE_SHOTS_OK entities=%d ticks=%d" % [entities.size(), ticks_seen])
	get_tree().quit()
