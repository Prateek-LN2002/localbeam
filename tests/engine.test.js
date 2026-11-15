'use strict';
// LocalBeam engine tests. Runs the real engine in a throwaway folder and talks to it over real HTTPS,
// verifying the certificate against LocalBeam's own CA. Works on Windows, macOS and Linux:
//   npm test

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startEngine } = require('../src/engine');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'localbeam-test-'));
const dataDir = path.join(work, 'data');
const recvDir = path.join(work, 'received');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => Buffer.from(JSON.stringify(o));

function request(target, method, urlPath, { headers = {}, body = null, abortAfter = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = target.ca ? https : http;
    const req = mod.request({ ...target, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text: buf.toString('utf8') });
      });
    });
    req.on('error', (e) => (abortAfter ? resolve({ status: 0, aborted: true }) : reject(e)));
    if (abortAfter && body) {
      req.write(body.subarray(0, abortAfter), () => setTimeout(() => req.destroy(), 150)); // drop the connection mid-chunk
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

(async () => {
  let engine = await startEngine({ dataDir });
  const L = { 'X-LocalBeam': '1' };
  const LJ = { ...L, 'Content-Type': 'application/json' };
  const local = () => ({ host: '127.0.0.1', port: engine.uiPort });
  const lan = () => ({ host: '127.0.0.1', port: engine.httpsPort, ca: fs.readFileSync(path.join(dataDir, 'tls', 'ca-cert.pem')) });

  const original = crypto.randomBytes(40 * 1024 * 1024 + 12345); // not a multiple of the chunk size
  const srcFile = path.join(work, 'source 40MB.bin');
  fs.writeFileSync(srcFile, original);

  console.log('Computer-side API');
  let r = await request(local(), 'POST', '/api/settings', { headers: LJ, body: J({ saveDir: recvDir }) });
  check('set save folder', r.status === 200, r.text);
  r = await request(local(), 'POST', '/api/note', { body: Buffer.from('x') });
  check('change without the app header is refused', r.status === 403);
  r = await request(local(), 'GET', '/api/state', { headers: { Host: 'evil.example' } });
  check('foreign Host header is refused', r.status === 403);
  r = await request(local(), 'GET', '/api/state');
  let code = r.json.pairing.code;
  check('state has a 6-digit pairing code', /^\d{6}$/.test(code));
  for (const p of ['/', '/desktop.css', '/desktop.js', '/icon.png']) {
    r = await request(local(), 'GET', p);
    check('computer screen file ' + p, r.status === 200 && r.buf.length > 100);
  }

  console.log('HTTPS, QR code and pairing');
  r = await request(lan(), 'GET', '/');
  check('certificate verifies against the LocalBeam CA; pairing page loads', r.status === 200 && r.text.includes('Pair this device'));
  for (const p of ['/phone.css', '/phone.js', '/icon-180.png', '/manifest.webmanifest']) {
    r = await request(lan(), 'GET', p);
    check('phone file ' + p, r.status === 200 && r.buf.length > 50);
  }
  r = await request(lan(), 'GET', '/api/state');
  check('computer API is not reachable from the network side', r.status === 404);
  r = await request(lan(), 'GET', '/d/state');
  check('unpaired device is refused', r.status === 401);
  r = await request(lan(), 'GET', '/pair?c=' + 'f'.repeat(32));
  check('wrong QR secret is refused', r.status === 302 && r.headers.location === '/?expired=1');

  r = await request(lan(), 'GET', '/localbeam-ca.crt');
  const caFingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(r.text).raw).digest();
  check('CA certificate is downloadable', r.status === 200 && r.text.includes('BEGIN CERTIFICATE'));

  const Jh = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
  r = await request(lan(), 'POST', '/pair-code', { headers: Jh, body: J({ code: code === '000000' ? '111111' : '000000' }) });
  check('wrong code is refused', r.status === 403);
  r = await request(lan(), 'POST', '/pair-code', { headers: Jh, body: J({ code }) });
  check('right code pairs', r.status === 200 && /^\/app\?d=/.test(r.json.url), r.text);
  const token = new URLSearchParams(r.json.url.split('?')[1]).get('d');
  check('pairing sets a Secure HttpOnly cookie', /lb=.*HttpOnly; Secure/.test(String(r.headers['set-cookie'])));
  r = await request(lan(), 'POST', '/pair-code', { headers: Jh, body: J({ code }) });
  check('the code only works once', r.status === 403);
  const D = { 'X-Device-Token': token };
  const DJ = { ...D, 'Content-Type': 'application/json' };
  r = await request(lan(), 'GET', '/d/state', { headers: D });
  check('paired device gets its state; named from its browser', r.status === 200 && r.json.device.name === 'iPhone', r.text);
  r = await request(lan(), 'GET', '/app', { headers: { Cookie: 'lb=' + token } });
  check('cookie alone opens the app page', r.status === 200 && r.text.includes('Choose files'));

  console.log('Pairing for the phone apps');
  // The apps read the pairing secret and the CA fingerprint out of the QR code. The QR text is not exposed
  // over the API, so decode what the engine would encode: fetch the SVG to make sure it renders, then pair
  // with the secret the same way the app does after scanning.
  r = await request(local(), 'GET', '/api/qr.svg?ip=' + encodeURIComponent((await request(local(), 'GET', '/api/state')).json.computer.addresses.map((a) => a.address)[0] || ''));
  check('QR code renders (when a network address exists)', r.status === 200 ? r.text.includes('<svg') : r.status === 404);
  r = await request(lan(), 'POST', '/pair-app', { headers: Jh, body: J({ secret: 'f'.repeat(32), name: 'Pixel 9' }) });
  check('app pairing with a wrong QR secret is refused', r.status === 403);
  code = (await request(local(), 'GET', '/api/state')).json.pairing.code;
  r = await request(lan(), 'POST', '/pair-app', { headers: Jh, body: J({ code, name: '  Pixel 9\u0007  ' }) });
  check('app pairing with the code returns a token and uses the phone\'s own name',
    r.status === 200 && typeof r.json.token === 'string' && r.json.device === 'Pixel 9' && !!r.json.computer, r.text);
  const appToken = r.json.token;
  r = await request(lan(), 'GET', '/d/state', { headers: { 'X-Device-Token': appToken } });
  check('app token is accepted', r.status === 200 && r.json.device.name === 'Pixel 9');
  check('CA fingerprint is a 32-byte SHA-256, as the apps expect', caFingerprint.length === 32);

  // The link inside the QR code: it must carry the pairing secret and the CA fingerprint, and the secret must pair.
  const firstIp = ((await request(local(), 'GET', '/api/state')).json.computer.addresses[0] || {}).address;
  if (firstIp) {
    r = await request(local(), 'GET', '/api/pair-link?ip=' + encodeURIComponent(firstIp));
    const link = new URL(r.json.link);
    check('QR link is https to this computer with a secret', link.protocol === 'https:' && link.hostname === firstIp && /^[0-9a-f]{32}$/.test(link.searchParams.get('c') || ''));
    check('QR link carries the CA fingerprint after #', link.hash === '#fp=' + caFingerprint.toString('base64url'), link.hash);
    r = await request(lan(), 'GET', '/api/pair-link?ip=' + encodeURIComponent(firstIp));
    check('the QR link cannot be read from the network side', r.status === 404);
    r = await request(lan(), 'POST', '/pair-app', { headers: Jh, body: J({ secret: link.searchParams.get('c'), name: 'QR phone' }) });
    check('app pairing with the QR secret works', r.status === 200 && r.json.device === 'QR phone', r.text);
    r = await request(lan(), 'POST', '/pair-app', { headers: Jh, body: J({ secret: link.searchParams.get('c'), name: 'QR phone' }) });
    check('the QR secret only works once', r.status === 403);
    const qrDevice = (await request(local(), 'GET', '/api/state')).json.devices.find((d) => d.name === 'QR phone');
    await request(local(), 'DELETE', '/api/device?id=' + qrDevice.id, { headers: L });
  }

  console.log('Upload from a device (resumable)');
  const meta = { name: '../..\\evil/../holiday video.bin', size: original.length, lastModified: 1700000000000 };
  r = await request(lan(), 'POST', '/d/upload/start', { headers: DJ, body: J(meta) });
  check('upload starts at 0', r.status === 200 && r.json.offset === 0, r.text);
  const id = r.json.id;
  const chunk = r.json.chunk;
  r = await request(lan(), 'PUT', `/d/upload/chunk?id=${id}&offset=0`, { headers: D, body: original.subarray(0, chunk) });
  check('first chunk accepted', r.status === 200 && r.json.offset === chunk, r.text);
  r = await request(lan(), 'PUT', `/d/upload/chunk?id=${id}&offset=5`, { headers: D, body: original.subarray(5, 10) });
  check('chunk at the wrong place is refused with the right offset', r.status === 409 && r.json.offset === chunk, r.text);
  r = await request(lan(), 'PUT', `/d/upload/chunk?id=${id}&offset=${chunk}`, {
    headers: { ...D, 'Content-Length': chunk }, body: original.subarray(chunk, chunk * 2), abortAfter: 5 * 1024 * 1024,
  });
  check('connection dropped mid-chunk', r.aborted === true);
  await sleep(600);
  r = await request(lan(), 'POST', '/d/upload/start', { headers: DJ, body: J(meta) });
  const resumeAt = r.json.offset;
  check('resume point is after the first chunk and not past the dropped data', resumeAt >= chunk && resumeAt <= chunk + 5 * 1024 * 1024, 'offset ' + resumeAt);
  let off = resumeAt;
  while (off < original.length) {
    r = await request(lan(), 'PUT', `/d/upload/chunk?id=${id}&offset=${off}`, { headers: D, body: original.subarray(off, Math.min(off + chunk, original.length)) });
    if (r.status !== 200) break;
    off = r.json.offset;
  }
  check('remaining chunks accepted', off === original.length, 'offset ' + off + ' status ' + r.status);
  r = await request(lan(), 'POST', `/d/upload/finish?id=${id}`, { headers: D });
  check('upload finishes; unsafe name is cleaned', r.status === 200 && r.json.name === 'holiday video.bin', r.text);
  const saved = path.join(recvDir, 'holiday video.bin');
  check('saved file is identical to the original', fs.existsSync(saved) && sha256(fs.readFileSync(saved)) === sha256(original));
  check('no partial file is left behind', fs.readdirSync(path.join(recvDir, '.localbeam-incoming')).length === 0);

  r = await request(lan(), 'POST', '/d/upload/start', { headers: DJ, body: J({ name: 'empty.txt', size: 0, lastModified: 1 }) });
  r = await request(lan(), 'POST', `/d/upload/finish?id=${r.json.id}`, { headers: D });
  check('empty file uploads', r.status === 200 && fs.statSync(path.join(recvDir, 'empty.txt')).size === 0, r.text);

  r = await request(lan(), 'POST', '/d/upload/start', { headers: DJ, body: J({ name: 'toobig.bin', size: 10, lastModified: 2 }) });
  r = await request(lan(), 'PUT', `/d/upload/chunk?id=${r.json.id}&offset=0`, { headers: D, body: Buffer.alloc(5000) }).catch(() => ({ status: 0 }));
  check('more data than announced is rejected', r.status === 400 || r.status === 0, 'status ' + r.status);
  check('rejected upload is not saved', !fs.existsSync(path.join(recvDir, 'toobig.bin')));
  await sleep(300);
  r = await request(local(), 'GET', '/api/state');
  check('rejected upload is shown as failed, not left waiting', r.json.transfers.some((t) => t.name === 'toobig.bin' && t.status === 'failed'), JSON.stringify(r.json.transfers.map((t) => [t.name, t.status])));

  r = await request(lan(), 'POST', '/d/text', { headers: { ...D, 'Content-Type': 'text/plain' }, body: Buffer.from('hello https://example.com') });
  check('text is accepted', r.status === 200);

  console.log('Download to a device');
  r = await request(local(), 'POST', '/api/share-paths', { headers: LJ, body: J({ paths: [srcFile, work] }) });
  check('file is shared in place; folder is skipped', r.json.added.length === 1 && r.json.skipped.length === 1, r.text);
  r = await request(lan(), 'GET', '/d/state', { headers: D });
  const shareId = r.json.files[0].id;
  check('device sees the shared file', r.json.files.length === 1 && r.json.files[0].size === original.length);
  r = await request(lan(), 'GET', '/d/file?id=' + shareId + '&d=' + encodeURIComponent(token));
  check('full download is identical', r.status === 200 && sha256(r.buf) === sha256(original));
  check('download offers resume', r.headers['accept-ranges'] === 'bytes' && !!r.headers.etag);
  r = await request(lan(), 'GET', '/d/file?id=' + shareId, { headers: { ...D, Range: 'bytes=100-199' } });
  check('range request returns exactly those bytes', r.status === 206 && r.buf.equals(original.subarray(100, 200)) && r.headers['content-range'] === `bytes 100-199/${original.length}`);
  r = await request(lan(), 'GET', '/d/file?id=' + shareId, { headers: { ...D, Range: `bytes=${original.length - 50}-` } });
  check('open-ended range (resume) works', r.status === 206 && r.buf.equals(original.subarray(original.length - 50)));
  r = await request(lan(), 'GET', '/d/file?id=' + shareId, { headers: { ...D, Range: `bytes=${original.length + 5}-` } });
  check('range past the end is refused', r.status === 416);
  r = await request(lan(), 'GET', '/d/file?id=' + shareId);
  check('download without pairing is refused', r.status === 401);
  r = await request(lan(), 'GET', '/d/file?id=nope', { headers: D });
  check('unknown file id is 404', r.status === 404);

  console.log('Computer state and storage');
  r = await request(local(), 'GET', '/api/state');
  let st = r.json;
  check('both devices listed as connected', st.devices.length === 2 && st.devices.every((d) => d.connected));
  check('history shows the file, the empty file and the text', st.received.filter((h) => h.type === 'file').length === 2 && st.received.some((h) => h.type === 'text'));
  check('transfers show the upload and the download as done',
    st.transfers.some((t) => t.dir === 'in' && t.status === 'done' && t.name === 'holiday video.bin') &&
    st.transfers.some((t) => t.dir === 'out' && t.status === 'done'));
  const stored = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  check('device tokens are not stored in readable form', !stored.includes(token) && !stored.includes(appToken));

  console.log('Restart');
  engine.stop();
  await sleep(500);
  engine = await startEngine({ dataDir });
  st = (await request(local(), 'GET', '/api/state')).json;
  check('paired devices are kept', st.devices.length === 2);
  check('Received list is kept', st.received.length === 3, 'entries ' + st.received.length);
  check('shared file and save folder are kept', st.shares.length === 1 && st.settings.saveDir === recvDir);
  r = await request(lan(), 'GET', '/d/state', { headers: D });
  check('the device is still recognised without pairing again', r.status === 200);

  engine.stop();
  await sleep(500);
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{ this is not valid json');
  engine = await startEngine({ dataDir });
  st = (await request(local(), 'GET', '/api/state')).json;
  check('a damaged settings file is recovered from the backup', st.devices.length === 2, 'devices ' + st.devices.length);

  console.log('Removing things');
  r = await request(local(), 'DELETE', '/api/share?id=' + st.shares[0].id, { headers: L });
  check('removing a share keeps the original file', fs.existsSync(srcFile));
  for (const d of st.devices) await request(local(), 'DELETE', '/api/device?id=' + d.id, { headers: L });
  r = await request(lan(), 'GET', '/d/state', { headers: D });
  check('a removed device can no longer connect', r.status === 401);

  engine.stop();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('Test crashed: ' + e.stack);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(2);
});
