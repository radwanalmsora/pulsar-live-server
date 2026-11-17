'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { LiveServer } = require('../src/server');

const get = (port, p) => new Promise((res, rej) => http.get({ port, path: p, host: '127.0.0.1' }, r => {
  let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
}).on('error', rej));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>Hi</h1></body></html>');
  fs.writeFileSync(path.join(dir, 'a.css'), 'body{color:red}');
  const srv = new LiveServer({ root: dir, host: '127.0.0.1', port: 0, cors: true, spa: true, directoryListing: true });
  const port = await srv.start();

  let r = await get(port, '/');
  assert.strictEqual(r.status, 200);
  assert(r.body.includes('/__pulsar/client.js'), 'client script injected');
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');

  r = await get(port, '/a.css'); assert.strictEqual(r.status, 200); assert(!r.body.includes('pulsar'));
  r = await get(port, '/%2e%2e/%2e%2e/etc/passwd'); assert(!r.body.includes('root:'), 'no traversal');
  r = await get(port, '/some/route'); assert.strictEqual(r.status, 200, 'SPA fallback');
  r = await get(port, '/missing.png'); assert.strictEqual(r.status, 404);
  r = await get(port, '/__pulsar/client.js'); assert.strictEqual(r.status, 200);

  // SSE broadcast
  const got = await new Promise(resolve => {
    http.get({ port, host: '127.0.0.1', path: '/__pulsar/events' }, res => {
      res.on('data', d => { const s = d.toString(); if (s.includes('"type":"css"')) { resolve(s); res.destroy(); } });
      setTimeout(() => srv.css('/a.css'), 100);
    });
  });
  assert(got.includes('/a.css'));
  await srv.stop();
  console.log('✔ all smoke tests passed');
})().catch(e => { console.error(e); process.exit(1); });
