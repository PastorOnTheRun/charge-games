/* Sword Drills: phone <-> screen link (shared by both pages).
   Primary: PeerJS (WebRTC data channel via the free PeerJS cloud broker), vendored in ./vendor/.
   Backup: public MQTT brokers over secure WebSockets (EMQX + HiveMQ, both at once; messages are de-duplicated),
   used whenever WebRTC can't connect (e.g. phone on cellular, strict Wi-Fi). A tiny MQTT 3.1.1 client is below.
   Peer ids/topics come from the 4-letter room code. Only table numbers, scores and references are sent:
   no names, no sign-in, nothing personal. */
(function () {
  "use strict";
  var SD = window.SD = {};
  SD.PREFIX = "chargegames-sworddrills-";
  SD.ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ";            // no I / O
  SD.BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt"];
  SD.newCode = function () {
    var s = "", a = new Uint32Array(4); crypto.getRandomValues(a);
    for (var i = 0; i < 4; i++) s += SD.ALPHA[a[i] % SD.ALPHA.length];
    return s;
  };
  SD.normCode = function (s) {
    s = String(s || "").toUpperCase().replace(/[^A-Z]/g, "").replace(/[OI]/g, "");
    return s.length === 4 ? s : "";
  };
  SD.peerId = function (code) { return SD.PREFIX + code.toLowerCase(); };
  SD.topic = function (code, kind) { return "chargegames/sworddrills/" + code.toLowerCase() + "/" + kind; };
  SD.uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };
  SD.hasPeer = function () { return typeof window.Peer === "function" && !/[?&]relay=mqtt\b/.test(location.search); };

  /* ---- minimal MQTT 3.1.1 over WebSocket (QoS 0 only) ---- */
  var te = new TextEncoder(), td = new TextDecoder();
  function str(s) { var b = te.encode(s); return [b.length >> 8, b.length & 255].concat(Array.from(b)); }
  function packet(type, body) {
    var len = body.length, hdr = [type];
    do { var d = len % 128; len = Math.floor(len / 128); hdr.push(len > 0 ? d | 128 : d); } while (len > 0);
    return new Uint8Array(hdr.concat(body));
  }
  function mqtt(url, subTopic, onMsg, onOpen) {
    var ws = null, up = false, closed = false, wait = 2000, ping = null, buf = new Uint8Array(0);
    function connect() {
      if (closed) return;
      try { ws = new WebSocket(url, "mqtt"); } catch (e) { retry(); return; }
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        var id = "cg-sd-" + Math.random().toString(36).slice(2, 12);
        ws.send(packet(0x10, str("MQTT").concat([4, 2, 0, 30], str(id))));          // CONNECT, clean session, keepalive 30 s
      };
      ws.onmessage = function (ev) {
        var n = new Uint8Array(ev.data), m = new Uint8Array(buf.length + n.length); m.set(buf); m.set(n, buf.length); buf = m;
        for (;;) {
          if (buf.length < 2) return;
          var mul = 1, len = 0, i = 1, d;
          do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mul; mul *= 128; } while (d & 128);
          if (buf.length < i + len) return;
          var type = buf[0] >> 4, qos = (buf[0] >> 1) & 3, body = buf.subarray(i, i + len);
          buf = buf.slice(i + len);
          if (type === 2 && body[1] === 0) {                                          // CONNACK ok
            up = true; wait = 2000;
            ws.send(packet(0x82, [0, 1].concat(str(subTopic), [0])));                  // SUBSCRIBE qos 0
            clearInterval(ping); ping = setInterval(function () { if (ws && ws.readyState === 1) ws.send(new Uint8Array([0xC0, 0])); }, 20000);
            if (onOpen) onOpen();
          } else if (type === 3) {                                                    // PUBLISH
            var tl = (body[0] << 8) | body[1], off = 2 + tl + (qos ? 2 : 0), msg;
            try { msg = JSON.parse(td.decode(body.subarray(off))); } catch (e) { continue; }
            onMsg(msg);
          }
        }
      };
      ws.onclose = function () { up = false; clearInterval(ping); ws = null; buf = new Uint8Array(0); retry(); };
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
  // Connect to every broker at once; publish to all that are up. Receivers de-duplicate (command ids / state rev).
  SD.relay = function (subTopic, onMsg, onOpen) {
    var cs = SD.BROKERS.map(function (u) { return mqtt(u, subTopic, onMsg, onOpen); });
    return {
      up: function () { return cs.some(function (c) { return c.up(); }); },
      pub: function (topic, obj) { var ok = false; cs.forEach(function (c) { ok = c.pub(topic, obj) || ok; }); return ok; },
      close: function () { cs.forEach(function (c) { c.close(); }); }
    };
  };
})();
