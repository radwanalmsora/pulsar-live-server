(function () {
  if (window.__pulsar) return;
  window.__pulsar = true;
  var KEY = '__pulsar_scroll', wasDown = false;
  try {
    var s = sessionStorage.getItem(KEY);
    if (s) {
      var p = JSON.parse(s);
      sessionStorage.removeItem(KEY);
      if (p.u === location.href) addEventListener('load', function () { scrollTo(p.x, p.y); });
    }
  } catch (e) {}

  var box;
  function toast(msg, bad) {
    if (!document.body) return;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:80vw;padding:8px 12px;border-radius:10px;font:600 12px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .4s;pointer-events:none';
      document.body.appendChild(box);
    }
    box.style.background = bad ? '#c62828' : 'linear-gradient(135deg,#6C3CE9,#14B8E6)';
    box.textContent = msg; box.style.opacity = '1';
    clearTimeout(box._t); box._t = setTimeout(function () { box.style.opacity = '0'; }, bad ? 6000 : 1800);
  }
  function reload() {
    try { sessionStorage.setItem(KEY, JSON.stringify({ u: location.href, x: scrollX, y: scrollY })); } catch (e) {}
    location.reload();
  }
  function refreshCss(file) {
    var links = document.querySelectorAll('link[rel~="stylesheet"]'), hit = false;
    for (var i = 0; i < links.length; i++) {
      var l = links[i], u;
      try { u = new URL(l.href, location.href); } catch (e) { continue; }
      if (u.origin === location.origin && decodeURIComponent(u.pathname) === file) {
        hit = true;
        var n = l.cloneNode();
        u.searchParams.set('__pulsar', Date.now());
        n.href = u.toString();
        (function (old) { n.onload = function () { old.remove(); }; })(l);
        l.parentNode.insertBefore(n, l.nextSibling);
      }
    }
    return hit;
  }
  var es = new EventSource('/__pulsar/events');
  es.onopen = function () { if (wasDown) { wasDown = false; reload(); } else toast('\u26A1 Pulsar connected'); };
  es.onerror = function () { wasDown = true; };
  es.onmessage = function (e) {
    var m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.type === 'css' && refreshCss(m.file)) { toast('\uD83C\uDFA8 CSS updated'); return; }
    if (m.type === 'reload' || m.type === 'css') reload();
  };
  addEventListener('error', function (ev) { toast('JS error: ' + ev.message, true); });
  addEventListener('unhandledrejection', function (ev) { toast('Promise rejected: ' + (ev.reason && ev.reason.message || ev.reason), true); });
})();
