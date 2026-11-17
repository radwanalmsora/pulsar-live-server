'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const CLIENT = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.csv': 'text/csv; charset=utf-8'
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class LiveServer extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.clients = new Set();
    this.port = null;
    this.server = null;
  }

  get scheme() { return this.opts.https && this.opts.https.enable ? 'https' : 'http'; }

  async start() {
    const o = this.opts;
    const handler = (req, res) => this._handle(req, res);
    if (this.scheme === 'https') {
      const cred = { cert: fs.readFileSync(o.https.cert), key: fs.readFileSync(o.https.key) };
      if (o.https.passphrase) cred.passphrase = o.https.passphrase;
      this.server = https.createServer(cred, handler);
    } else {
      this.server = http.createServer(handler);
    }
    this.server.on('upgrade', (req, sock, head) => this._upgrade(req, sock, head));
    const base = o.port === 0 ? 0 : o.port;
    for (let i = 0; i < (base === 0 ? 1 : 25); i++) {
      try { this.port = await this._listen(base === 0 ? 0 : base + i); return this.port; }
      catch (e) { if (e.code !== 'EADDRINUSE' || base === 0) throw e; }
    }
    throw new Error('No free port found near ' + base);
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const onErr = e => { this.server.removeListener('listening', onOk); reject(e); };
      const onOk = () => { this.server.removeListener('error', onErr); resolve(this.server.address().port); };
      this.server.once('error', onErr);
      this.server.once('listening', onOk);
      this.server.listen(port, this.opts.host);
    });
  }

  stop() {
    for (const c of this.clients) { try { c.end(); } catch (e) {} }
    this.clients.clear();
    return new Promise(r => (this.server ? this.server.close(() => r()) : r()));
  }

  broadcast(msg) {
    const data = 'data: ' + JSON.stringify(msg) + '\n\n';
    for (const c of this.clients) { try { c.write(data); } catch (e) {} }
  }
  reload(file) { this.broadcast({ type: 'reload', file }); }
  css(file) { this.broadcast({ type: 'css', file }); }

  _headers(extra) {
    const h = Object.assign({ 'Cache-Control': 'no-store, must-revalidate' }, this.opts.headers || {}, extra || {});
    if (this.opts.cors) {
      h['Access-Control-Allow-Origin'] = '*';
      h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD';
      h['Access-Control-Allow-Headers'] = '*';
    }
    return h;
  }

  _send(res, code, type, body, extra) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(code, this._headers(Object.assign({ 'Content-Type': type, 'Content-Length': buf.length }, extra)));
    res.end(buf);
  }

  _inject(html) {
    const tag = '<script src="/__pulsar/client.js"></script>';
    const t = this.opts.injectTag || '</body>';
    const i = html.toLowerCase().lastIndexOf(t.toLowerCase());
    return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
  }

  _matchProxy(pathname) {
    return (this.opts.proxy || []).find(p => p.path && pathname.startsWith(p.path));
  }

  _handle(req, res) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { return this._send(res, 400, 'text/plain', 'Bad request'); }
    let pathname;
    try { pathname = decodeURIComponent(u.pathname); } catch (e) { return this._send(res, 400, 'text/plain', 'Bad request'); }

    if (pathname === '/__pulsar/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 800\n\n');
      this.clients.add(res);
      this.emit('clients', this.clients.size);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(ka); this.clients.delete(res); this.emit('clients', this.clients.size); });
      return;
    }
    if (pathname === '/__pulsar/client.js') return this._send(res, 200, 'text/javascript; charset=utf-8', CLIENT);

    if (req.method === 'OPTIONS' && this.opts.cors) { res.writeHead(204, this._headers()); return res.end(); }

    const rule = this._matchProxy(pathname);
    if (rule) return this._proxy(req, res, rule);

    if (req.method !== 'GET' && req.method !== 'HEAD') return this._send(res, 405, 'text/plain', 'Method not allowed');

    const root = path.resolve(this.opts.root);
    let abs = path.resolve(path.join(root, pathname));
    if (abs !== root && !abs.startsWith(root + path.sep)) return this._send(res, 403, 'text/plain', 'Forbidden');

    let stat = null;
    try { stat = fs.statSync(abs); } catch (e) {}

    if (stat && stat.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { Location: pathname + '/' + u.search }); return res.end(); }
      for (const idx of ['index.html', 'index.htm']) {
        const c = path.join(abs, idx);
        if (fs.existsSync(c)) { abs = c; stat = fs.statSync(c); break; }
      }
      if (stat.isDirectory()) return this._listing(res, abs, pathname);
    }

    if (!stat) {
      const spaOk = this.opts.spa && !path.extname(pathname);
      const fallback = path.join(root, 'index.html');
      if (spaOk && fs.existsSync(fallback)) { abs = fallback; stat = fs.statSync(abs); }
      else return this._notFound(res, pathname);
    }
    this._file(req, res, abs, stat);
  }

  _file(req, res, abs, stat) {
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html' || ext === '.htm' || ext === '.xhtml';
    if (isHtml) {
      const ov = this.opts.getOverride && this.opts.getOverride(abs);
      let html;
      try { html = ov !== undefined ? ov : fs.readFileSync(abs, 'utf8'); } catch (e) { return this._send(res, 500, 'text/plain', e.message); }
      return this._send(res, 200, type, req.method === 'HEAD' ? '' : this._inject(html));
    }
    if (ext === '.css' || ext === '.js') {
      const ov = this.opts.getOverride && this.opts.getOverride(abs);
      if (ov !== undefined) return this._send(res, 200, type, ov);
    }
    const size = stat.size, range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const s = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
        const e = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
        if (s >= size || e >= size || s > e) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
        res.writeHead(206, this._headers({ 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 }));
        return fs.createReadStream(abs, { start: s, end: e }).pipe(res);
      }
    }
    res.writeHead(200, this._headers({ 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }

  _page(title, body) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:dark light}body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
h1{background:linear-gradient(135deg,#8B5CF6,#22D3EE);-webkit-background-clip:text;color:transparent}a{text-decoration:none}li{padding:3px 0}code{opacity:.7}</style>${body}`;
  }

  _notFound(res, pathname) {
    this._send(res, 404, 'text/html; charset=utf-8',
      this._inject(this._page('404', `<h1>404 — Not found</h1><p><code>${esc(pathname)}</code></p><p><a href="/">← Home</a></p>`)));
  }

  _listing(res, dir, pathname) {
    if (!this.opts.directoryListing) return this._notFound(res, pathname);
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {}
    items.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const li = items.filter(d => !d.name.startsWith('.')).map(d => {
      const n = d.name + (d.isDirectory() ? '/' : '');
      return `<li>${d.isDirectory() ? '📁' : '📄'} <a href="${encodeURI(n)}">${esc(n)}</a></li>`;
    }).join('');
    const up = pathname !== '/' ? '<li>⬆️ <a href="../">..</a></li>' : '';
    this._send(res, 200, 'text/html; charset=utf-8', this._inject(this._page('Index of ' + pathname, `<h1>⚡ ${esc(pathname)}</h1><ul style="list-style:none;padding:0">${up}${li}</ul>`)));
  }

  _proxy(req, res, rule) {
    let t;
    try { t = new URL(rule.target); } catch (e) { return this._send(res, 502, 'text/plain', 'Invalid proxy target'); }
    const lib = t.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, req.headers, { host: t.host });
    const pr = lib.request({ hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80), method: req.method, path: req.url, headers, rejectUnauthorized: false }, up => {
      res.writeHead(up.statusCode, Object.assign({}, up.headers, this._headers()));
      up.pipe(res);
    });
    pr.on('error', e => this._send(res, 502, 'text/plain', 'Proxy error: ' + e.message));
    req.pipe(pr);
  }

  _upgrade(req, sock, head) {
    const rule = this._matchProxy(req.url.split('?')[0]);
    if (!rule) return sock.destroy();
    let t; try { t = new URL(rule.target); } catch (e) { return sock.destroy(); }
    const net = require('net'), tls = require('tls');
    const up = (t.protocol === 'https:' ? tls : net).connect({ host: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80), rejectUnauthorized: false }, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        raw += `${k}: ${k.toLowerCase() === 'host' ? t.host : req.rawHeaders[i + 1]}\r\n`;
      }
      up.write(raw + '\r\n'); if (head && head.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  }
}

module.exports = { LiveServer };
