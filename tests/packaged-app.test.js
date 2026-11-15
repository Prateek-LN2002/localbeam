'use strict';
// Checks a RUNNING LocalBeam desktop app (installed or unpacked build): its screens load from the package,
// HTTPS verifies against its CA, and a paired device can upload and download. Removes everything it creates.
//
//   node tests/packaged-app.test.js <ui-port> <lan-ip> <path-to-ca-cert.pem> [https-port]
//
// Start the app with its own data folder so real pairings and history are never touched:
//   LocalBeam.exe --user-data-dir=<empty folder>

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const [, , uiPort, lanIp, caPath, httpsPort] = process.argv;
if (!uiPort || !lanIp || !caPath) {
  console.error('usage: node tests/packaged-app.test.js <ui-port> <lan-ip> <ca-cert.pem> [https-port]');
  process.exit(2);
}
const LOCAL = { host: '127.0.0.1', port: Number(uiPort) };
const LAN = { host: lanIp, port: Number(httpsPort) || 53700, ca: fs.readFileSync(caPath) };
const L = { 'X-LocalBeam': '1' };
const TEST_DEVICE = 'LocalBeam self-test';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function request(target, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = (target.ca ? https : http).request({ ...target, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const J = (o) => Buffer.from(JSON.stringify(o));

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'localbeam-app-test-'));
  const original = crypto.randomBytes(20 * 1024 * 1024 + 777); // needs two chunks
  const srcFile = path.join(work, 'localbeam-selftest-source.bin');
  fs.writeFileSync(srcFile, original);
  let shareId = null;
  let savedPath = null;

  try {
    console.log('Screens served from the package');
    for (const p of ['/', '/desktop.css', '/desktop.js', '/icon.png']) {
      const r = await request(LOCAL, 'GET', p);
      check('computer screen file ' + p, r.status === 200 && r.buf.length > 100, 'status ' + r.status);
    }
    let r = await request(LOCAL, 'GET', '/api/state');
    const st = r.json;
    check('running inside the desktop app, with file pickers', st.computer.shell === true && st.settings.canPick === true);
    check('start-at-login setting is available', typeof st.settings.autoStart === 'boolean');
    check('network address found', st.computer.addresses.some((a) => a.address === lanIp), JSON.stringify(st.computer.addresses));
    r = await request(LOCAL, 'GET', '/api/qr.svg?ip=' + lanIp);
    check('QR code is generated', r.status === 200 && r.text.includes('<svg'));
    r = await request(LOCAL, 'GET', '/api/pair-link?ip=' + lanIp);
    const caFp = crypto.createHash('sha256').update(new crypto.X509Certificate(LAN.ca).raw).digest('base64url');
    check('QR link carries this computer\'s certificate fingerprint', r.status === 200 && r.json.link.endsWith('#fp=' + caFp));

    console.log('HTTPS on the network address');
    r = await request(LAN, 'GET', '/');
    check('certificate verifies against the app CA; pairing page loads', r.status === 200 && r.text.includes('Pair this device'));
    for (const p of ['/phone.css', '/phone.js', '/icon-180.png', '/manifest.webmanifest']) {
      r = await request(LAN, 'GET', p);
      check('phone file ' + p, r.status === 200 && r.buf.length > 50, 'status ' + r.status);
    }
    r = await request(LAN, 'GET', '/d/state');
    check('unpaired device is refused', r.status === 401);

    console.log('Pair, upload, download');
    r = await request(LAN, 'POST', '/pair-app', { headers: { 'Content-Type': 'application/json' }, body: J({ code: st.pairing.code, name: TEST_DEVICE }) });
    check('app pairing with the code works', r.status === 200 && !!(r.json && r.json.token), r.text);
    const D = { 'X-Device-Token': r.json.token };
    r = await request(LAN, 'GET', '/app?d=' + encodeURIComponent(D['X-Device-Token']));
    check('phone app page loads', r.status === 200 && r.text.includes('Choose files'));

    r = await request(LAN, 'POST', '/d/upload/start', { headers: { ...D, 'Content-Type': 'application/json' }, body: J({ name: 'localbeam-selftest-upload.bin', size: original.length, lastModified: 1 }) });
    const id = r.json.id;
    const chunk = r.json.chunk;
    let off = r.json.offset;
    while (off < original.length) {
      r = await request(LAN, 'PUT', `/d/upload/chunk?id=${id}&offset=${off}`, { headers: D, body: original.subarray(off, Math.min(off + chunk, original.length)) });
      if (r.status !== 200) break;
      off = r.json.offset;
    }
    check('upload sent in chunks', off === original.length, 'offset ' + off + ' status ' + r.status);
    r = await request(LAN, 'POST', `/d/upload/finish?id=${id}`, { headers: D });
    check('upload finished', r.status === 200, r.text);
    savedPath = path.join(st.settings.saveDir, r.json ? r.json.name : 'localbeam-selftest-upload.bin');
    check('received file is identical and in the save folder', fs.existsSync(savedPath) && sha256(fs.readFileSync(savedPath)) === sha256(original), savedPath);

    r = await request(LOCAL, 'POST', '/api/share-paths', { headers: { ...L, 'Content-Type': 'application/json' }, body: J({ paths: [srcFile] }) });
    check('computer offers a file', !!r.json && r.json.added.length === 1, r.text);
    r = await request(LAN, 'GET', '/d/state', { headers: D });
    shareId = (r.json.files.find((f) => f.name === path.basename(srcFile)) || {}).id;
    r = await request(LAN, 'GET', '/d/file?id=' + shareId, { headers: D });
    check('download is identical', r.status === 200 && sha256(r.buf) === sha256(original));
    r = await request(LAN, 'GET', '/d/file?id=' + shareId, { headers: { ...D, Range: 'bytes=1000-1999' } });
    check('download can resume (range request)', r.status === 206 && r.buf.equals(original.subarray(1000, 2000)));
  } finally {
    console.log('Cleaning up (only what this test created)');
    if (shareId) await request(LOCAL, 'DELETE', '/api/share?id=' + shareId, { headers: L }).catch(() => {});
    const s = await request(LOCAL, 'GET', '/api/state').catch(() => null);
    if (s && s.json) {
      for (const d of s.json.devices.filter((x) => x.name.startsWith(TEST_DEVICE))) {
        await request(LOCAL, 'DELETE', '/api/device?id=' + d.id, { headers: L }).catch(() => {});
      }
    }
    if (savedPath) fs.rmSync(savedPath, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
    const after = await request(LOCAL, 'GET', '/api/state').catch(() => null);
    if (after && after.json) {
      check('test device and share removed', !after.json.devices.some((d) => d.name.startsWith(TEST_DEVICE)) && !after.json.shares.some((x) => x.id === shareId));
    }
    check('test file removed from the save folder', !savedPath || !fs.existsSync(savedPath));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Test crashed: ' + e.stack); process.exit(2); });
