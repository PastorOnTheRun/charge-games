/* Charge! Games embed: run a Charge game page on another site under that site's skin, from this one codebase.
   Host page (the whole file, one per game page; every game page on the host can be the same file):
     (optional robots meta: the host decides indexing; Charge pages carry no robots tag)
     <script src="../skin.js"></script>                          (sets window.ChargeSkin, see README "Skins")
     <script src="https://pastorontherun.github.io/charge-games/shared/charge-embed.js" data-mount="/games/"></script>
   The game page is the part of the host URL after data-mount: /x/games/sword-drills/controller/ -> <charge>/sword-drills/controller/.
   Or name it: data-page="sword-drills/table/".
   What it does: fetches the Charge page, copies its styles and markup into this document (relative URLs made absolute to the
   Charge site), adds the skin CSS last, then runs the page's scripts in order. location stays on the host, so QR codes and
   links between screen, remote and table pages stay on the host site too. */
(function () {
  "use strict";
  var me = document.currentScript, ROOT = me.src.replace(/shared\/charge-embed\.js(\?.*)?$/, "");
  var SK = window.ChargeSkin || {}, page = me.getAttribute("data-page");
  if (page == null) {
    var mount = me.getAttribute("data-mount") || "/games/", path = location.pathname, i = path.lastIndexOf(mount);
    page = i >= 0 ? path.slice(i + mount.length) : "";
  }
  page = page.replace(/^\/+/, "").replace(/index\.html$/, "");
  if (page && !/\/$/.test(page) && !/\.html$/.test(page)) page += "/";
  var url = ROOT + page, ver = "";
  window.ChargeEmbed = { root: ROOT, page: url };
  var html = document.documentElement;
  if (SK.id) html.setAttribute("data-cg-skin", SK.id);
  html.setAttribute("data-cg-embed", "");
  html.setAttribute("data-cg-page", page || "/");                  // lets a skin style one page (e.g. "sword-drills/controller/")
  var hide = document.createElement("style"); hide.textContent = "body { visibility: hidden; }"; document.head.appendChild(hide);
  function abs(u) { return new URL(u, url).href; }
  function bust(u) { return ver && u.indexOf(ROOT) === 0 ? u + (u.indexOf("?") < 0 ? "?" : "&") + "v=" + ver : u; }
  function show() { if (hide.parentNode) hide.parentNode.removeChild(hide); }
  function css(href, attr) {
    return new Promise(function (ok) {
      var l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; if (attr) l.setAttribute(attr, "");
      var t = setTimeout(ok, 4000); l.onload = l.onerror = function () { clearTimeout(t); ok(); };
      document.head.appendChild(l);
    });
  }
  function fail(code) {
    if (SK.css) css(SK.css, "data-cg-skin-css");
    var soon = code === 404, home = SK.home ? '<p><a href="' + SK.home.href + '" style="color:var(--cg-acc-dk,#0B6E99);font-weight:800">' + (SK.home.label || "Back") + "</a></p>" : "";
    document.body.innerHTML = '<main style="max-width:36rem;margin:16vh auto;padding:0 1.5rem;font:500 1.1rem/1.5 system-ui,-apple-system,sans-serif;text-align:center;color:var(--cg-ink,#0B1020)">' +
      (SK.logo && SK.logo.light ? '<img src="' + SK.logo.light + '" alt="" style="height:3.4rem;width:auto;margin-bottom:1.6rem">' : "") +
      '<h1 style="font:900 1.8rem/1.15 var(--cg-disp,system-ui,sans-serif);margin:0 0 .7rem">' + (soon ? "This game is coming soon" : "The game didn't load") + "</h1>" +
      "<p>" + (soon ? "It will show up here on its own as soon as it's released." : "Check the internet connection, then reload the page.") + "</p>" + home + "</main>";
    show();
  }
  fetch(url, { cache: "no-cache" }).then(function (r) {
    if (!r.ok) throw r.status;
    var lm = r.headers.get("last-modified") || r.headers.get("etag") || "";
    for (var h = 0, k = 0; k < lm.length; k++) h = (h * 31 + lm.charCodeAt(k)) | 0;
    ver = lm ? (h >>> 0).toString(36) : "";
    return r.text();
  }).then(build).catch(function (e) { if (window.console) console[e === 404 ? "info" : "error"]("[charge-embed]", url, e === 404 ? "not released yet" : e); fail(e); });

  function build(text) {
    var d = new DOMParser().parseFromString(text, "text/html"), head = document.head, waits = [];
    if (!SK.keepTitle) { var t = d.querySelector("title"); if (t) document.title = SK.brand ? t.textContent.replace("Charge! Games", SK.brand) : t.textContent; }
    var vp = d.querySelector('meta[name="viewport"]'); if (vp && !head.querySelector('meta[name="viewport"]')) head.appendChild(document.importNode(vp, true));
    var tc = d.querySelector('meta[name="theme-color"]'); if (tc && !head.querySelector('meta[name="theme-color"]')) head.appendChild(document.importNode(tc, true));
    [].forEach.call(d.head.querySelectorAll("link, style"), function (n) {
      if (n.tagName === "STYLE") { head.appendChild(document.importNode(n, true)); return; }
      var rel = (n.getAttribute("rel") || "").toLowerCase(), href = n.getAttribute("href");
      if (rel === "stylesheet") waits.push(css(bust(abs(href))));
      else if (rel === "preconnect") { var p = document.importNode(n, true); p.href = abs(href); head.appendChild(p); }
      // icons, canonical: the host page brings its own
    });
    if (SK.css) waits.push(css(SK.css, "data-cg-skin-css"));
    var scripts = [].slice.call(d.querySelectorAll("script"));
    scripts.forEach(function (s) { s.parentNode.removeChild(s); });
    [].forEach.call(d.body.querySelectorAll("[src], a[href]"), function (n) {
      var a = n.hasAttribute("src") ? "src" : "href", v = n.getAttribute(a);
      if (v && v.charAt(0) !== "#" && !/^(mailto|tel|javascript):/i.test(v)) n.setAttribute(a, abs(v));
    });
    [].forEach.call(d.body.attributes, function (a) { document.body.setAttribute(a.name, a.value); });
    var keep = [].filter.call(document.body.childNodes, function (n) { return n.tagName === "NOSCRIPT"; });
    document.body.innerHTML = ""; keep.forEach(function (n) { document.body.appendChild(n); });
    while (d.body.firstChild) document.body.appendChild(document.importNode(d.body.firstChild, true)), d.body.removeChild(d.body.firstChild);
    Promise.all(waits).then(function () {
      var i = 0;
      (function next() {
        if (i >= scripts.length) { show(); return; }
        var s = scripts[i++], n = document.createElement("script");
        if (s.getAttribute("src")) { n.src = bust(abs(s.getAttribute("src"))); n.onload = next; n.onerror = function () { if (window.console) console.error("[charge-embed] failed", n.src); next(); }; document.body.appendChild(n); }
        else { n.textContent = s.textContent; document.body.appendChild(n); next(); }
      })();
      setTimeout(show, 5000);
    });
  }
})();
