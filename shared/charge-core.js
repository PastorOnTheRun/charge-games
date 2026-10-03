/* Charge! Games core (shared by every game).
   One concept for every game: the TV/screen is the game (the HOST, it owns all state) and the leader's phone is the
   remote (the REMOTE, it only sends commands). A future large-event mode adds PLAYER devices (role "player").

   What lives here:
     Charge.link      transports: PeerJS/WebRTC (primary) + public MQTT over WebSocket (backup), pluggable
     Charge.host()    screen side: room code, connection, command de-dup, state broadcast
     Charge.remote()  phone side: join by code/QR, reconnect, send commands, receive state
     Charge.core()    team model (2-50 teams, names, scores), buzz-in (Correct/Wrong + lockout), undo history
     Charge.board()   screen scoreboard that scales from 2 to 50 teams (dense grid, paging)
     Charge.picker()  phone team picker (big tiles for small groups, searchable grid for big ones)
     Charge.buzzPanel(), Charge.coreSheet(), Charge.qr()   shared phone/screen UI pieces
   Protocol and API: see README.md. No names or accounts are sent; team names are whatever the leader types. */
(function () {
  "use strict";
  var C = window.Charge = { PROTOCOL: 1, NS: "chargegames", MAX_TEAMS: 50, MIN_TEAMS: 2 };

  /* ---------------- skins ----------------
     Another site can run these exact game pages under its own brand (see README "Skins" and shared/charge-embed.js).
     window.ChargeSkin = { id, ns, brand, css, logo: { dark, light }, home: { href, label } }, set before this file loads.
     ns also names the rooms (peer ids, relay topics) and the saved-state keys, so a skinned site never shares rooms or saves. */
  var SK = C.skin = window.ChargeSkin || null;
  if (SK && /^[a-z][a-z0-9]{1,23}$/.test(SK.ns || "")) C.NS = SK.ns;
  C.applySkin = function () {
    if (!SK) return;
    var html = document.documentElement;
    if (SK.id) html.setAttribute("data-cg-skin", SK.id);
    if (SK.css && !document.querySelector("link[data-cg-skin-css]")) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = SK.css; l.setAttribute("data-cg-skin-css", ""); document.head.appendChild(l); }
    [].forEach.call(document.querySelectorAll("[data-cg-logo]"), function (el) {
      var v = el.getAttribute("data-cg-logo"), src = SK.logo && SK.logo[v]; if (!src || el.tagName === "IMG") return;
      var img = document.createElement("img"); img.src = src; img.alt = SK.brand || ""; img.setAttribute("data-cg-logo", v);
      img.className = (el.getAttribute("class") || "") + " cg-skin-logo"; el.parentNode.replaceChild(img, el);
    });
    if (SK.brand) [].forEach.call(document.querySelectorAll("[data-cg-brand]"), function (el) { el.textContent = SK.brand; });
    [].forEach.call(document.querySelectorAll("[data-cg-home], [data-cg-home-mark]"), function (el) {
      if (!SK.home) { if (el.hasAttribute("data-cg-home")) el.hidden = true; else el.removeAttribute("href"); return; }
      el.href = SK.home.href;
      if (el.hasAttribute("data-cg-home")) el.textContent = SK.home.label || SK.brand; else el.setAttribute("aria-label", (SK.brand || "") + " home");
    });
    if (SK.brand) document.title = document.title.replace("Charge! Games", SK.brand);
  };
  if (document.body) C.applySkin(); else document.addEventListener("DOMContentLoaded", C.applySkin);
  C.BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt"];
  C.ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ";            // no I / O
  C.newCode = function () { var s = "", a = new Uint32Array(4); crypto.getRandomValues(a); for (var i = 0; i < 4; i++) s += C.ALPHA[a[i] % C.ALPHA.length]; return s; };
  C.normCode = function (s) { s = String(s || "").toUpperCase().replace(/[^A-Z]/g, "").replace(/[OI]/g, ""); return s.length === 4 ? s : ""; };
  C.uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };
  C.NAME_MAX = 20;
  // team names: strip tags/control characters, collapse spaces, cap the length (they are always escaped on output too)
  C.cleanName = function (s) { return String(s == null ? "" : s).replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, "").replace(/<[^>]*>?/g, "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, C.NAME_MAX).trim(); };
  C.esc = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
  C.peerId = function (game, code) { return C.NS + "-" + game + "-" + code.toLowerCase(); };
  // topics: <ns>/<game>/<code>/h = host -> everyone, /r = remotes -> host, /p = players -> host (reserved)
  C.topic = function (game, code, ch) { return C.NS + "/" + game + "/" + code.toLowerCase() + "/" + ch; };
  C.hasPeer = function () { return typeof window.Peer === "function" && !/[?&]relay=mqtt\b/.test(location.search); };
  var CLIENT = C.uid();
  C.debug = /[?&]cgdebug\b/.test(location.search);
  // Every message: { p: 1, t: type, role: "host"|"remote"|"player", from: clientId, id, at, ...body }
  C.msg = function (t, role, body) { var m = { p: C.PROTOCOL, t: t, role: role, from: CLIENT, id: C.uid(), at: Date.now() }; for (var k in body || {}) m[k] = body[k]; return m; };

  /* ---------------- transport: minimal MQTT 3.1.1 over WebSocket (QoS 0) ---------------- */
  var te = new TextEncoder(), td = new TextDecoder();
  function str(s) { var b = te.encode(s); return [b.length >> 8, b.length & 255].concat(Array.from(b)); }
  function packet(type, body) { var len = body.length, hdr = [type]; do { var d = len % 128; len = Math.floor(len / 128); hdr.push(len > 0 ? d | 128 : d); } while (len > 0); return new Uint8Array(hdr.concat(body)); }
  function mqtt(url, subTopic, onMsg, onOpen) {
    var ws = null, up = false, closed = false, wait = 2000, ping = null, buf = new Uint8Array(0);
    function connect() {
      if (closed) return;
      try { ws = new WebSocket(url, "mqtt"); } catch (e) { retry(); return; }
      ws.binaryType = "arraybuffer";
      ws.onopen = function () { ws.send(packet(0x10, str("MQTT").concat([4, 2, 0, 30], str("cg-" + Math.random().toString(36).slice(2, 12))))); };
      ws.onmessage = function (ev) {
        var n = new Uint8Array(ev.data), m = new Uint8Array(buf.length + n.length); m.set(buf); m.set(n, buf.length); buf = m;
        for (;;) {
          if (buf.length < 2) return;
          var mul = 1, len = 0, i = 1, d;
          do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mul; mul *= 128; } while (d & 128);
          if (buf.length < i + len) return;
          var type = buf[0] >> 4, qos = (buf[0] >> 1) & 3, body = buf.subarray(i, i + len);
          buf = buf.slice(i + len);
          if (type === 2 && body[1] === 0) {
            up = true; wait = 2000;
            ws.send(packet(0x82, [0, 1].concat(str(subTopic), [0])));
            clearInterval(ping); ping = setInterval(function () { if (ws && ws.readyState === 1) ws.send(new Uint8Array([0xC0, 0])); }, 20000);
            if (onOpen) onOpen();
          } else if (type === 3) {
            var tl = (body[0] << 8) | body[1], off = 2 + tl + (qos ? 2 : 0), msg;
            try { msg = JSON.parse(td.decode(body.subarray(off))); } catch (e) { continue; }
            onMsg(msg);
          }
        }
      };
      ws.onclose = function (ev) { if (C.debug) console.log("[cg mqtt] close", url, ev.code, ev.reason); up = false; clearInterval(ping); ws = null; buf = new Uint8Array(0); retry(); };
      ws.onerror = function () {};
    }
    function retry() { if (!closed) { setTimeout(connect, wait); wait = Math.min(15000, wait * 1.6); } }
    connect();
    return {
      up: function () { return up; },
      pub: function (topic, obj) { if (up && ws && ws.readyState === 1) { ws.send(packet(0x30, str(topic).concat(Array.from(te.encode(JSON.stringify(obj)))))); return true; } return false; },
      close: function () { closed = true; up = false; clearInterval(ping); if (ws) try { ws.close(); } catch (e) {} ws = null; }
    };
  }
  // Relay adapter interface (swap this for Ably / Supabase Realtime / PartyKit later, same shape):
  //   relay(subTopic, onMsg, onOpen) -> { up(), pub(topic, obj), close() }
  C.link = {
    relay: function (subTopic, onMsg, onOpen) {
      var cs = C.BROKERS.map(function (u) { return mqtt(u, subTopic, onMsg, onOpen); });
      return { up: function () { return cs.some(function (c) { return c.up(); }); },
               pub: function (topic, obj) { var ok = false; cs.forEach(function (c) { ok = c.pub(topic, obj) || ok; }); return ok; },
               close: function () { cs.forEach(function (c) { c.close(); }); } };
    }
  };

  /* ---------------- host (screen) ---------------- */
  // opts: { game, code, getState() -> public state object, onCommand(a, msg), onCode(newCode), onInput(msg) [future players], onLink() }
  C.host = function (opts) {
    var code = opts.code || C.newCode(), peer = null, conns = [], tries = 0, relayUntil = 0, relayPUntil = 0, relaySeen = 0, seen = [], relay = null, bt = null, rev = 0;
    // Each role gets its own view of the state: the leader remote sees everything (e.g. pending name requests),
    // table/player devices only see public state. Relay channels: h = to remotes, t = to tables/players.
    function state(role) { rev++; var m = C.msg("state", "host", { game: opts.game, code: code, rev: rev, to: role }); m.s = opts.getState(role); return m; }
    function sendState() {
      var full = state("remote"), pub = state("player");
      conns.forEach(function (c) { if (c.open && c.role) try { c.send(c.role === "remote" ? full : pub); } catch (e) {} });
      if (relay && Date.now() < relayUntil) {   // backup relay only while some device uses it
        var liveR = conns.some(function (c) { return c.open && c.role === "remote" && Date.now() - c.lastSeen < 10000; });
        if (!liveR) relay.pub(C.topic(opts.game, code, "h"), full);
        if (Date.now() < relayPUntil) relay.pub(C.topic(opts.game, code, "t"), pub);
      }
      if (opts.onLink) opts.onLink(api.status());
    }
    function broadcast() { clearTimeout(bt); bt = setTimeout(sendState, 30); }
    function handle(m, via, c) {
      if (!m || typeof m !== "object" || m.role === "host") return;
      if (C.debug) console.log("[cg host]", via, m.t, m.a || m.kind || "", m.id || "", Date.now() - (m.at || 0) + "ms");
      if (m.t === "ping") return "pong";
      if (c && (m.role === "remote" || m.role === "player")) c.role = m.role;
      if (via === "relay") { relayUntil = Date.now() + 3 * 3600e3; if (m.role === "player") relayPUntil = relayUntil; else relaySeen = Date.now(); }
      if (m.t === "hello") { if (c) try { c.send(state(c.role || "player")); } catch (e) {} broadcast(); return; }
      if (!m.id || seen.indexOf(m.id) >= 0) return;
      seen.push(m.id); if (seen.length > 500) seen.shift();
      if (m.t === "cmd" && m.role === "remote") { opts.onCommand(m.a, m); broadcast(); }
      else if (m.t === "input" && m.role === "player" && opts.onInput) { opts.onInput(m.kind, m); broadcast(); }   // table devices now; player phones later
    }
    function startPeer() {
      if (!C.hasPeer()) return;
      if (peer) try { peer.destroy(); } catch (e) {}
      var p = peer = new Peer(C.peerId(opts.game, code), { debug: 0 });
      p.on("open", function () { tries = 0; if (opts.onLink) opts.onLink(api.status()); });
      p.on("connection", function (c) {
        c.lastSeen = Date.now();
        c.on("open", function () { conns.push(c); if (opts.onLink) opts.onLink(api.status()); });      // state goes out after its hello (we learn its role)
        c.on("data", function (m) { c.lastSeen = Date.now(); if (handle(m, "peer", c) === "pong") try { c.send({ p: C.PROTOCOL, t: "pong" }); } catch (e) {} });
        c.on("close", function () { conns = conns.filter(function (x) { return x !== c; }); if (opts.onLink) opts.onLink(api.status()); });
        c.on("error", function () {});
      });
      p.on("disconnected", function () { setTimeout(function () { if (p === peer && !p.destroyed && p.disconnected) try { p.reconnect(); } catch (e) {} }, 1500); });
      p.on("error", function (e) {
        if (p !== peer || e.type === "peer-unavailable") return;
        if (e.type === "unavailable-id") { tries++; if (tries > 6) { tries = 0; api.setCode(C.newCode()); return; } }
        setTimeout(function () { if (p === peer) startPeer(); }, Math.min(15000, 2500 * Math.max(1, tries)));
      });
    }
    function restartRelay() { if (relay) relay.close(); relay = C.link.relay(C.topic(opts.game, code, "+"), function (m) { handle(m, "relay"); }); }   // subscribes to r (remotes) and p (players)
    setInterval(function () {
      conns.forEach(function (c) { if (Date.now() - c.lastSeen > 15000) try { c.close(); } catch (e) {} });
      if (peer && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch (e) {}
      if (opts.onLink) opts.onLink(api.status());
    }, 5000);
    var api = {
      code: function () { return code; },
      setCode: function (c) { code = c; startPeer(); restartRelay(); if (opts.onCode) opts.onCode(c); broadcast(); },
      broadcast: broadcast,
      remoteUrl: function (path) { return new URL((path || "controller/") + "?room=" + code, location.href.split("#")[0].split("?")[0]).href; },
      // "on" = a phone is connected, "wait" = ready for a phone, "off" = still connecting
      status: function () { return conns.some(function (c) { return c.open && c.role === "remote"; }) || Date.now() - relaySeen < 90000 ? "on" : peer && peer.open ? "wait" : "off"; },
      tables: function () { return conns.filter(function (c) { return c.open && c.role === "player"; }).length; }
    };
    startPeer(); restartRelay();
    return api;
  };

  /* ---------------- remote (phone) ---------------- */
  // opts: { game, role: "remote" (leader phone, default) | "player" (table device), onState(state, msg), onStatus(kind, text), onNotFound() }
  C.remote = function (opts) {
    var ROLE = opts.role || "remote", IN = ROLE === "remote" ? "h" : "t", OUT = ROLE === "remote" ? "r" : "p";
    var room = "", peer = null, conn = null, lastSeen = 0, openAt = 0, dialT = null, lastDial = 0, startAt = 0, relay = null, viaRelay = false, relaySeen = 0, rev = -1, hostFrom = null, st = null;
    // "fresh" = the screen has actually sent us something over WebRTC lately. An open channel alone is not enough:
    // a half-open WebRTC link (open here, nothing arriving) must not hold back the relay backup.
    function fresh() { return !!(conn && conn.open && Date.now() - lastSeen < 10000); }
    function ok() { return fresh() || (viaRelay && !!relay && relay.up() && Date.now() - relaySeen < 120000); }
    function status() {
      if (!opts.onStatus) return;
      if (!room) opts.onStatus("none", "Not joined");
      else if (fresh()) opts.onStatus("on", "● Live");
      else if (viaRelay && ok()) opts.onStatus("backup", "● Backup");
      else opts.onStatus("off", "Connecting…");
    }
    function onMsg(m) {
      if (!m || m.t !== "state" || m.role !== "host" || (m.to && m.to !== ROLE)) return;
      if (m.from !== hostFrom) { hostFrom = m.from; rev = -1; }        // screen reloaded: accept its new numbering
      if (m.rev <= rev) return;
      rev = m.rev; st = m.s; status(); opts.onState(st, m);
    }
    function startPeer() {
      if (peer) try { peer.destroy(); } catch (e) {}
      var p = peer = new Peer({ debug: 0 });
      p.on("open", dial);
      p.on("disconnected", function () { setTimeout(function () { if (p === peer && !p.destroyed && p.disconnected) try { p.reconnect(); } catch (e) {} }, 1000); });
      p.on("error", function (e) {
        if (p !== peer) return;
        if (e.type === "peer-unavailable") { if (opts.onNotFound) opts.onNotFound(); redial(3000); return; }
        if (["network", "server-error", "socket-error", "socket-closed", "browser-incompatible"].indexOf(e.type) >= 0 || p.destroyed) setTimeout(function () { if (p === peer && room) startPeer(); }, 3000);
      });
    }
    function dial() {
      if (!peer || !peer.open || !room) return;
      if (conn) try { conn.close(); } catch (e) {}
      var c = conn = peer.connect(C.peerId(opts.game, room), { reliable: true, serialization: "json" });
      c.on("open", function () { openAt = Date.now(); c.send(C.msg("hello", ROLE)); status(); });
      c.on("data", function (m) { if (c !== conn) return; lastSeen = Date.now(); onMsg(m); });
      c.on("close", function () { if (c === conn) { status(); redial(1500); } });
      c.on("error", function () { if (c === conn) redial(2000); });
    }
    function redial(ms) { clearTimeout(dialT); dialT = setTimeout(function () { dialT = null; lastDial = Date.now(); if (!room) return; if (!peer || peer.destroyed) startPeer(); else if (peer.disconnected) { try { peer.reconnect(); } catch (e) { startPeer(); } } else dial(); }, ms); }
    function startRelay() {
      if (relay || !room) return;
      var r = relay = C.link.relay(C.topic(opts.game, room, IN), function (m) { if (r !== relay) return; viaRelay = true; relaySeen = Date.now(); onMsg(m); },
        function () { r.pub(C.topic(opts.game, room, OUT), C.msg("hello", ROLE)); });
    }
    function stopAll() { clearTimeout(dialT); if (conn) try { conn.close(); } catch (e) {} conn = null; if (peer) try { peer.destroy(); } catch (e) {} peer = null; if (relay) relay.close(); relay = null; viaRelay = false; }
    setInterval(function () {
      if (!room) return;
      if (conn && conn.open) { try { conn.send({ p: C.PROTOCOL, t: "ping" }); } catch (e) {} if (Date.now() - Math.max(lastSeen, openAt) > 10000) { try { conn.close(); } catch (e) {} redial(200); } }
      else if (!dialT && peer && peer.open && Date.now() - lastDial > 12000) redial(100);
      if (!fresh() && Date.now() - startAt > 6000) startRelay();                                   // WebRTC not getting through: add the backup relay
      if (relay && !fresh() && Date.now() - relaySeen > 45000) relay.pub(C.topic(opts.game, room, OUT), C.msg("hello", ROLE));
      if (fresh() && relay && Date.now() - startAt > 60000) { relay.close(); relay = null; viaRelay = false; }   // WebRTC healthy: drop the backup
      status();
    }, 3000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && room) { if (!(conn && conn.open)) redial(100); else try { conn.send(C.msg("hello", ROLE)); } catch (e) {} } });
    window.addEventListener("online", function () { if (room) redial(100); });
    return {
      join: function (code) { room = code; st = null; rev = -1; hostFrom = null; startAt = Date.now(); stopAll(); if (C.hasPeer()) startPeer(); else startRelay(); status(); },
      leave: function () { room = ""; stopAll(); st = null; status(); },
      room: function () { return room; },
      state: function () { return st; },
      ok: ok,
      via: function () { return fresh() ? "peer" : viaRelay ? "mqtt" : "none"; },
      // send a command: a = "core.*" for shared features, "<game>.*" for game features
      send: function (a, x) {
        var m = ROLE === "remote" ? C.msg("cmd", "remote", { a: a }) : C.msg("input", "player", { kind: a }); for (var k in x || {}) m[k] = x[k];
        if (conn && conn.open) try { conn.send(m); } catch (e) {}
        var sent = !fresh() && relay ? relay.pub(C.topic(opts.game, room, OUT), m) : null;   // the host ignores duplicates by id
        if (C.debug) console.log("[cg " + ROLE + "] send", a, m.id, "peer:" + fresh(), "relay:" + sent);
        if (navigator.vibrate) navigator.vibrate(15);
        return m.id;
      }
    };
  };

  /* ---------------- core model: teams, buzz-in, undo (runs on the host) ---------------- */
  // data lives inside the game's saved state: S.core = Charge.core.fresh(n). opts:
  //   word: "Table" | "Team"   default team label
  //   question(slot) -> key string of the open question for that slot, or null if nothing can be answered now
  //   onCorrect(team, slot, buzz) -> points awarded (the game marks its own question answered and returns pts, or 0 to refuse)
  //   onUndo(entry)  game reverts its own bits for an undone award (e.g. clear "answered by")
  //   isOpen(question key) -> true if that question is still the current one (so undo can put the buzz back)
  //   onChange()     save + render
  C.core = function (data, opts) {
    var D = data, word = opts.word || "Table";
    var api = {
      data: D,
      label: function (i) { return (D.names[i] || "").trim() || word + " " + (i + 1); },
      setCount: function (n) { n = Math.max(C.MIN_TEAMS, Math.min(C.MAX_TEAMS, n | 0)); if (n === D.n) return; D.n = n; while (D.scores.length < n) D.scores.push(0); while (D.names.length < n) D.names.push(""); if (D.buzz.team !== null && D.buzz.team >= n) D.buzz.team = null; opts.onChange(); },
      // the leader renames directly; a name sent from a table device waits in D.requests until the leader approves it
      rename: function (i, name) { if (i < 0 || i >= C.MAX_TEAMS) return; D.names[i] = C.cleanName(name); delete D.nameState[i]; D.requests = D.requests.filter(function (r) { return r.team !== i; }); opts.onChange(); },
      requestName: function (team, name, from) {
        team = team | 0; name = C.cleanName(name); if (team < 0 || team >= D.n || !name) return false;
        D.requests = D.requests.filter(function (r) { return r.team !== team; });           // one pending request per table: newest wins
        D.requests.push({ id: C.uid(), team: team, name: name, at: Date.now(), from: String(from || "").slice(0, 40) });
        D.nameState[team] = "pending"; opts.onChange(); return true;
      },
      approveName: function (id, edited) {
        var r = D.requests.filter(function (x) { return x.id === id; })[0]; if (!r) return false;
        var nm = edited != null ? C.cleanName(edited) : r.name; if (!nm) return false;
        D.names[r.team] = nm; delete D.nameState[r.team]; D.requests = D.requests.filter(function (x) { return x.id !== id; }); opts.onChange(); return true;
      },
      rejectName: function (id) {
        var r = D.requests.filter(function (x) { return x.id === id; })[0]; if (!r) return false;
        D.nameState[r.team] = "rejected"; D.requests = D.requests.filter(function (x) { return x.id !== id; }); opts.onChange(); return true;
      },
      award: function (team, pts, meta) { D.scores[team] += pts; D.history.push({ k: "award", t: team, pts: pts, meta: meta || null, buzz: meta && meta.buzz || null }); },
      // buzz-in: a table (or, later, a player device) claims the open question
      buzz: function (team, slot, src) {
        var q = opts.question(slot); if (!q || team < 0 || team >= D.n) return false;
        var B = D.buzz, locked = D.locked[q] || [];
        if (locked.indexOf(team) >= 0) return false;
        if (B.team !== null && B.q === q && src !== "remote") return false;   // players: first one wins; the leader can change a mis-tap
        D.buzz = { q: q, slot: slot == null ? null : slot, team: team, at: Date.now() };
        opts.onChange(); return true;
      },
      clearBuzz: function () { D.buzz = { q: D.buzz.q, slot: D.buzz.slot, team: null, at: 0 }; },
      // Correct: the open question's points go to the buzzed table automatically
      correct: function (q, team) {
        var B = D.buzz; if (B.team === null || B.q !== q || B.team !== team || opts.question(B.slot) !== q) return false;
        var snap = { q: B.q, slot: B.slot, team: B.team, locked: (D.locked[q] || []).slice() };
        var pts = opts.onCorrect(B.team, B.slot, snap); if (!pts) return false;
        D.scores[B.team] += pts; D.history.push({ k: "award", t: B.team, pts: pts, slot: B.slot, buzz: snap, meta: snap.meta || null });
        api.clearBuzz(); opts.onChange(); return pts;
      },
      // Wrong: reopen the buzzers for everyone else; optionally lock the wrong table out of this question
      wrong: function (q, team) {
        var B = D.buzz; if (B.team === null || B.q !== q || B.team !== team) return false;
        var snap = { q: B.q, slot: B.slot, team: B.team, locked: (D.locked[q] || []).slice() };
        if (D.lockout) { D.locked[q] = (D.locked[q] || []).concat([team]); }
        D.history.push({ k: "wrong", t: team, pts: 0, slot: B.slot, buzz: snap });
        api.clearBuzz(); opts.onChange(); return true;
      },
      setLockout: function (on) { D.lockout = !!on; opts.onChange(); },
      newQuestionSet: function () { D.locked = {}; D.buzz = { q: null, slot: null, team: null, at: 0 }; },      // call when a new spin/round starts
      lockedFor: function (q) { return q ? (D.locked[q] || []) : []; },
      // Undo the last scoring event. An undone auto-award (or Wrong) puts that table back in the "buzzed in" state.
      undo: function () {
        var h = D.history.pop(); if (!h) return null;
        if (h.k === "award") { D.scores[h.t] -= h.pts; if (opts.onUndo) opts.onUndo(h); }
        if (h.buzz && opts.isOpen(h.buzz.q)) { D.locked[h.buzz.q] = h.buzz.locked.slice(); D.buzz = { q: h.buzz.q, slot: h.buzz.slot, team: h.buzz.team, at: Date.now() }; }
        opts.onChange(); return h;
      },
      reset: function () { for (var i = 0; i < D.scores.length; i++) D.scores[i] = 0; D.history = []; api.newQuestionSet(); },
      // public part for the state message
      // public part for the state message. Only approved names are ever in "names"; the pending request text
      // goes to the leader remote only (role "remote"); tables just see that their request is pending/rejected.
      pub: function (role) {
        var q = D.buzz.q, ns = {};
        for (var k in D.nameState) if (+k < D.n) ns[k] = D.nameState[k];
        var o = { n: D.n, names: D.names.slice(0, D.n), scores: D.scores.slice(0, D.n), word: word, lockout: D.lockout,
                  buzz: { q: q, slot: D.buzz.slot, team: D.buzz.team }, locked: D.locked, canUndo: D.history.length > 0,
                  last: D.history.length ? D.history[D.history.length - 1] : null, nameState: ns };
        if (role === "remote") o.requests = D.requests.filter(function (r) { return r.team < D.n; }).map(function (r) { return { id: r.id, team: r.team, name: r.name, at: r.at }; });
        return o;
      },
      // input from table devices: { kind: "name", team, name } | { kind: "buzz", team, slot }
      input: function (kind, m, slotFor) {
        if (kind === "name") return api.requestName(m.team, m.name, m.from);
        if (kind === "buzz") return api.buzz(m.team | 0, slotFor ? slotFor(m) : null, "player");
        return false;
      },
      // core commands from the remote; returns true if handled
      command: function (a, m) {
        if (a === "core.teams") api.setCount(m.d ? D.n + (m.d | 0) : m.n);
        else if (a === "core.rename") api.rename(m.i | 0, m.name);
        else if (a === "core.approve") api.approveName(m.id, m.name);
        else if (a === "core.reject") api.rejectName(m.id);
        else if (a === "core.buzz") api.buzz(m.team | 0, m.slot == null ? null : m.slot | 0, "remote");
        else if (a === "core.correct") api.correct(m.q, m.team | 0);
        else if (a === "core.wrong") api.wrong(m.q, m.team | 0);
        else if (a === "core.clearbuzz") { api.clearBuzz(); opts.onChange(); }
        else if (a === "core.lockout") api.setLockout(m.on);
        else if (a === "core.undo") api.undo();
        else return false;                       // "core.reset" is left to the game: it resets its own state, then calls reset()
        return true;
      }
    };
    return api;
  };
  C.core.fresh = function (n) { var d = { n: n || 6, names: [], scores: [], history: [], lockout: true, locked: {}, buzz: { q: null, slot: null, team: null, at: 0 }, requests: [], nameState: {} }; for (var i = 0; i < C.MAX_TEAMS; i++) { d.names.push(""); d.scores.push(0); } return d; };
  C.core.upgrade = function (d, n) { var f = C.core.fresh(n); if (!d || typeof d !== "object") return f; for (var k in f) if (!(k in d)) d[k] = f[k]; while (d.scores.length < C.MAX_TEAMS) d.scores.push(0); while (d.names.length < C.MAX_TEAMS) d.names.push(""); return d; };
  C.label = function (T, i) { return ((T.names && T.names[i]) || "").trim() || (T.word || "Table") + " " + (i + 1); };

  /* ---------------- screen scoreboard: 2 to 50 teams ---------------- */
  // Charge.board(el, { mode: "strip" | "full" }) -> { render(T, extra), show(team) }
  //   strip: the band under the game. 1 row up to 6, 2 rows up to 12, 3 dense rows up to 30, then pages that rotate every 7 s.
  //   full: the scoreboard view. Fits every team on one screen (up to 50); sorted by score when there are more than 12.
  //   extra: { finished, buzz: team|null, locked: [teams], hit: team }
  C.board = function (el, o) {
    var mode = o.mode || "strip", page = 0, pages = 1, timer = null, lastT = null, lastX = {}, hold = 0;
    el.classList.add("cg-board", "cg-" + mode);
    function per() { var n = lastT.n; if (mode === "full" || n <= 30) return n; return Math.ceil(n / Math.ceil(n / 30)); }   // even pages: 40 -> 2 x 20, 50 -> 2 x 25
    function rotate() { clearInterval(timer); timer = null; if (pages > 1) timer = setInterval(function () { if (Date.now() < hold) return; page = (page + 1) % pages; draw(); }, 7000); }
    function draw() {
      var T = lastT, X = lastX, n = T.n, max = Math.max.apply(null, T.scores.concat([0])), idx = [];
      for (var i = 0; i < n; i++) idx.push(i);
      if (mode === "full" && n > 12) idx.sort(function (a, b) { return T.scores[b] - T.scores[a] || a - b; });
      var pp = per(); pages = Math.ceil(n / pp); if (page >= pages) page = 0;
      var show = idx.slice(page * pp, page * pp + pp), cnt = show.length;
      var rows, cols;
      if (mode === "full") { var W = el.clientWidth || 1600, H = el.clientHeight || 700; cols = Math.max(1, Math.round(Math.sqrt(cnt * W / H * 0.62))); cols = Math.min(cols, cnt); rows = Math.ceil(cnt / cols); if (cnt > 4 && rows === 1) { rows = 2; cols = Math.ceil(cnt / 2); } }
      else { rows = n <= 6 ? 1 : n <= 12 ? 2 : 3; cols = Math.ceil(pp / rows); }   // same grid on every page
      el.style.setProperty("--cols", cols); el.style.setProperty("--rows", rows);
      el.className = el.className.replace(/\bcg-d\d\b/g, "").trim() + " cg-d" + (mode === "full" ? (cnt <= 4 ? 1 : cnt <= 12 ? 2 : cnt <= 24 ? 3 : 4) : rows);
      var locked = X.locked || [], h = "";
      show.forEach(function (i, k) {
        var sc = T.scores[i], lead = max > 0 && sc === max, rank = mode === "full" && n > 12 ? '<span class="cg-rk">' + (page * pp + k + 1) + "</span>" : "";
        h += '<div class="cg-tb' + (lead ? " lead" : "") + (X.buzz === i ? " buzz" : "") + (locked.indexOf(i) >= 0 ? " out" : "") + '" data-t="' + i + '">' + rank +
          '<div class="cg-nm">' + C.esc(C.label(T, i)) + '</div><div class="cg-sc">' + sc + "</div>" +
          (mode === "full" && cnt <= 12 ? '<div class="cg-cr">' + (lead ? (X.finished ? "Winner" : "Leading") : "") + "</div>" : "") + "</div>";
      });
      if (pages > 1) { h += '<div class="cg-pg">' + T.word + "s " + (page * pp + 1) + "–" + Math.min(n, page * pp + pp) + " of " + n + " · page " + (page + 1) + "/" + pages + "</div>"; }
      el.innerHTML = h;
      if (X.hit != null) { var e = el.querySelector('.cg-tb[data-t="' + X.hit + '"]'); if (e) { e.classList.remove("hit"); void e.offsetWidth; e.classList.add("hit"); } }
    }
    return {
      render: function (T, extra) { var oldPages = pages; lastT = T; lastX = extra || {}; draw(); if (pages !== oldPages || (pages > 1 && !timer)) rotate(); if (pages <= 1) { clearInterval(timer); timer = null; } },
      // jump to the page that holds this team (e.g. it just buzzed in) and keep it there for a while
      show: function (team) { if (!lastT || pages <= 1 || team == null) return; var pp = per(), p = Math.floor(team / pp); if (mode === "full") return; hold = Date.now() + 15000; if (p !== page) { page = p; draw(); } },
      page: function () { return { page: page, pages: pages }; }
    };
  };

  /* ---------------- QR ---------------- */
  C.qr = function (el, url) { try { var q = qrcode(0, "M"); q.addData(url); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 8, margin: 0, scalable: true }); } catch (e) { el.textContent = ""; } };

  /* ---------------- phone: team picker ---------------- */
  // Charge.picker(el, { onPick(team) }) -> { render(T, { disabled, locked: [], buzz: team, badge(i) -> html }) }
  // Up to 12 teams: big tiles. More: a search box (number or name) and a compact, scrollable grid.
  C.picker = function (el, o) {
    el.classList.add("cg-picker");
    el.innerHTML = '<div class="cg-find" hidden><input type="search" inputmode="search" enterkeyhint="go" placeholder="Find a table: number or name" aria-label="Find a table"><button type="button" class="cg-clr" aria-label="Clear search">×</button></div><div class="cg-tiles"></div><div class="cg-none" hidden>No match. Clear the search to see every table.</div>';
    var find = el.querySelector(".cg-find"), inp = find.querySelector("input"), tiles = el.querySelector(".cg-tiles"), none = el.querySelector(".cg-none"), last = null, lastX = {};
    function match(T, i, q) { if (!q) return true; if (/^\d+$/.test(q)) return String(i + 1).indexOf(q) === 0; return C.label(T, i).toLowerCase().indexOf(q.toLowerCase()) >= 0; }
    function draw() {
      var T = last, X = lastX; if (!T) return;
      var n = T.n, big = n > 12, q = big ? inp.value.trim() : "", max = Math.max.apply(null, T.scores.concat([0])), h = "", shown = 0;
      find.hidden = !big;
      for (var i = 0; i < n; i++) {
        if (!match(T, i, q)) continue; shown++;
        var out = (X.locked || []).indexOf(i) >= 0, cls = "cg-tile" + (X.buzz === i ? " buzz" : max > 0 && T.scores[i] === max ? " lead" : "") + (out ? " out" : "");
        h += '<button type="button" class="' + cls + '" data-t="' + i + '"' + (X.disabled || out ? " disabled" : "") + '><b>' + C.esc(C.label(T, i)) + "</b><span>" + T.scores[i] + " pts" + (out ? " · out" : "") + "</span>" + (X.badge ? X.badge(i) : "") + "</button>";
      }
      tiles.className = "cg-tiles " + (big ? "dense" : n <= 4 ? "c2" : "c3");
      if (tiles.getAttribute("data-h") !== h) { tiles.innerHTML = h; tiles.setAttribute("data-h", h); }   // never rebuild under a finger
      none.hidden = shown > 0;
    }
    inp.addEventListener("input", draw);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); var b = tiles.querySelectorAll(".cg-tile:not(:disabled)"); if (b.length === 1) b[0].click(); inp.blur(); } });
    find.querySelector(".cg-clr").addEventListener("click", function () { inp.value = ""; draw(); });
    tiles.addEventListener("click", function (e) { var b = e.target.closest(".cg-tile"); if (!b || b.disabled) return; o.onPick(+b.getAttribute("data-t")); if (inp.value) { inp.value = ""; draw(); } });
    return { render: function (T, X) { last = T; lastX = X || {}; draw(); }, clear: function () { inp.value = ""; draw(); } };
  };

  /* ---------------- phone: buzz-in panel (Correct / Wrong) ---------------- */
  // Charge.buzzPanel(el, remote) -> { render(T, { open: question key|null, pts, what }) }
  C.buzzPanel = function (el, R) {
    el.classList.add("cg-buzz");
    var last = null;
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b || b.disabled || !last) return;
      var B = last.buzz; if (B.team === null) return;
      b.disabled = true;                                                           // one tap = one judgment
      R.send(b.getAttribute("data-j") === "ok" ? "core.correct" : "core.wrong", { q: B.q, team: B.team });
    });
    return {
      render: function (T, X) {
        last = T; X = X || {};
        var B = T.buzz, h;
        if (B.team !== null && X.open && B.q === X.open) {
          h = '<div class="cg-bz-t"><b>' + C.esc(C.label(T, B.team)) + "</b> buzzed in" + (X.what ? " · " + C.esc(X.what) : "") + '</div><div class="cg-bz-h">Tapped the wrong table? Tap the right one below.</div>' +
              '<div class="cg-bz-b"><button type="button" class="ok" data-j="ok">✓ Correct <small>+' + X.pts + " to " + C.esc(C.label(T, B.team)) + '</small></button><button type="button" class="no" data-j="no">✕ Wrong <small>' + (T.lockout ? "lock out, reopen" : "reopen buzzers") + "</small></button></div>";
        } else if (X.open) {
          var L = (T.locked && T.locked[X.open]) || [];
          h = '<div class="cg-bz-t">Buzzers open' + (X.what ? " · " + C.esc(X.what) : "") + '</div><div class="cg-bz-h">Tap the table that buzzed in first, then judge the answer.' + (L.length ? " Locked out: " + L.map(function (i) { return C.esc(C.label(T, i)); }).join(", ") + "." : "") + "</div>";
        } else h = "";
        if (el.getAttribute("data-h") !== h) { el.innerHTML = h; el.setAttribute("data-h", h); }
        el.hidden = !h;
      }
    };
  };

  /* ---------------- phone: shared settings rows (teams, names, lockout, reset, leave) ---------------- */
  // Charge.coreSheet(el, remote, { onLeave }) -> { render(T) }
  C.coreSheet = function (el, R, o) {
    el.innerHTML =
      '<div class="sr"><div class="n">Tables</div><div class="h">2 to ' + C.MAX_TEAMS + '. Big group? Jump by 5.</div>' +
      '<div class="cg-step"><button type="button" data-d="-5" aria-label="5 fewer">−5</button><button type="button" data-d="-1" aria-label="One fewer">−</button><b class="cg-n">6</b><button type="button" data-d="1" aria-label="One more">+</button><button type="button" data-d="5" aria-label="5 more">+5</button></div></div>' +
      '<div class="sr"><div class="n">Table names</div><div class="h">Optional. Leave blank to keep “Table 7”.</div><button type="button" class="cg-names-btn">Rename tables</button><div class="cg-names" hidden></div></div>' +
      '<div class="sr"><div class="n">Wrong answer locks that table out</div><div class="h">For the rest of that question. Off: everyone can buzz again.</div><div class="seg cg-lock"><button type="button" data-v="1">On</button><button type="button" data-v="0">Off</button></div></div>' +
      '<div class="sr"><div class="n">Reset scores</div><div class="h">Clears every table and the current question. Names stay.</div><button type="button" class="danger cg-reset">Reset scores</button></div>' +
      '<div class="sr"><button type="button" class="link cg-leave">Leave this room</button></div>';
    var names = el.querySelector(".cg-names"), armT, last = null;
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-d")) R.send("core.teams", { d: +b.getAttribute("data-d") });
      else if (b.parentNode.classList.contains("cg-lock")) R.send("core.lockout", { on: b.getAttribute("data-v") === "1" });
      else if (b.classList.contains("cg-names-btn")) { names.hidden = !names.hidden; b.textContent = names.hidden ? "Rename tables" : "Done renaming"; drawNames(); }
      else if (b.classList.contains("cg-reset")) {
        if (b.classList.contains("arm")) { R.send("core.reset"); b.classList.remove("arm"); b.textContent = "Reset scores"; if (o.onReset) o.onReset(); return; }
        b.classList.add("arm"); b.textContent = "Tap again to reset"; clearTimeout(armT); armT = setTimeout(function () { b.classList.remove("arm"); b.textContent = "Reset scores"; }, 3500);
      } else if (b.classList.contains("cg-leave")) o.onLeave();
    });
    function commit(inp) { var i = +inp.getAttribute("data-i"), v = inp.value.replace(/\s+/g, " ").trim(); if (last && v === ((last.names[i] || "").trim())) return; R.send("core.rename", { i: i, name: v }); }
    names.addEventListener("change", function (e) { if (e.target.matches("input")) commit(e.target); });
    names.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); commit(e.target); var nx = names.querySelector('input[data-i="' + (+e.target.getAttribute("data-i") + 1) + '"]'); if (nx) nx.focus(); else e.target.blur(); } });
    function drawNames() {
      if (names.hidden || !last) return;
      var have = names.querySelectorAll("input").length;
      if (have !== last.n) { var h = ""; for (var i = 0; i < last.n; i++) h += '<label><span>' + (i + 1) + '</span><input data-i="' + i + '" maxlength="20" autocomplete="off" placeholder="' + (last.word || "Table") + " " + (i + 1) + '"></label>'; names.innerHTML = h; }
      [].forEach.call(names.querySelectorAll("input"), function (inp) { if (document.activeElement !== inp) inp.value = last.names[+inp.getAttribute("data-i")] || ""; });
    }
    return {
      render: function (T, linkOk) {
        last = T;
        el.querySelector(".cg-n").textContent = T.n;
        [].forEach.call(el.querySelectorAll("[data-d]"), function (b) { var d = +b.getAttribute("data-d"); b.disabled = !linkOk || (d < 0 ? T.n <= C.MIN_TEAMS : T.n >= C.MAX_TEAMS); });
        [].forEach.call(el.querySelectorAll(".cg-lock button"), function (b) { b.classList.toggle("sel", (b.getAttribute("data-v") === "1") === !!T.lockout); b.disabled = !linkOk; });
        drawNames();
      }
    };
  };

  /* ---------------- phone: misc ---------------- */
  var wl = null;
  C.wake = function () { try { if (navigator.wakeLock && !wl) navigator.wakeLock.request("screen").then(function (l) { wl = l; l.addEventListener("release", function () { wl = null; }); }).catch(function () {}); } catch (e) {} };
})();
