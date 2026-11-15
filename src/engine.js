'use strict';
// LocalBeam engine.
//  - LAN side (HTTPS, all interfaces): pairing, the phone web app, and the device API.
//  - Local side (HTTP, 127.0.0.1 only): the computer's own screens and their API.
// Nothing here talks to the internet.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const certs = require('./certs');

const UI_DIR = path.join(__dirname, 'ui');
const MAX_TEXT = 100000;
const MAX_JSON = 1024 * 1024;
const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_MS = 9000;
const CHUNK_BYTES = 16 * 1024 * 1024;
const HISTORY_MAX = 500;
const STALE_PART_MS = 7 * 86400000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.zip': 'application/zip',
};

// Files each side is allowed to fetch (path on the wire -> file under src/ui).
const STATIC_LOCAL = {
  '/': 'desktop/index.html', '/desktop.css': 'desktop/desktop.css', '/desktop.js': 'desktop/desktop.js',
  '/icon.png': 'icons/icon-192.png',
};
const STATIC_LAN = {
  '/phone.css': 'phone/phone.css', '/phone.js': 'phone/phone.js',
  '/icon-180.png': 'icons/icon-180.png', '/icon-192.png': 'icons/icon-192.png', '/icon-512.png': 'icons/icon-512.png',
};

// ---------- small helpers ----------

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

function send(res, status, body, type = 'text/plain; charset=utf-8', extra) {
  if (res.headersSent) return;
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra));
  res.end(body);
}
const json = (res, obj, status = 200, extra) => send(res, status, JSON.stringify(obj), 'application/json', extra);
const redirect = (res, to, extra) => send(res, 302, '', 'text/plain', Object.assign({ Location: to }, extra));

function serveFile(res, rel) {
  const file = path.join(UI_DIR, rel);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    let over = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { if (!over) body += c; if (body.length > limit) over = true; });
    req.on('end', () => (over ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(body)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req, MAX_JSON);
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Settings and history are kept twice (file + .bak). If the main file is ever unreadable,
// the backup is used; a damaged file is set aside rather than silently replaced by an empty one.
function loadJson(file, fallback) {
  for (const candidate of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch { /* try the next one */ }
  }
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.damaged-${Date.now()}`);
  } catch { /* leave it where it is */ }
  return fallback;
}

function saveJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.copyFileSync(file, file + '.bak'); } catch { /* the main copy is saved; the backup is best effort */ }
}

function safeName(raw) {
  let n = path.basename(String(raw).replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = 'file_' + Date.now() + (n ? '_' + n : '');
  return n;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  const score = (n) =>
    /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier/i.test(n) ? 3
      : /wi-?fi|wlan|wireless|^en\d|^wl/i.test(n) ? 0
      : /ethernet|^eth/i.test(n) ? 1 : 2;
  return out.sort((x, y) => score(x.name) - score(y.name));
}

function guessDeviceName(ua) {
  ua = String(ua || '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux|X11/i.test(ua)) return 'Linux PC';
  return 'Device';
}

function defaultHooks() {
  const open = (target) => {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [target], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  };
  return {
    openPath: open,
    showItem: (file) => {
      if (process.platform === 'win32') {
        spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      } else open(path.dirname(file));
    },
    pickFiles: null,   // set by the desktop shell: () => Promise<string[]>
    pickFolder: null,  // set by the desktop shell: () => Promise<string|null>
    getAutoStart: () => null, // null = not supported here
    setAutoStart: () => {},
  };
}

// ---------- engine ----------

async function startEngine(opts) {
  const dataDir = opts.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const hooks = Object.assign(defaultHooks(), opts.hooks);
  const log = opts.log || (() => {});

  const cfgFile = path.join(dataDir, 'config.json');
  const histFile = path.join(dataDir, 'history.json');
  const outboxDir = path.join(dataDir, 'outbox');

  const cfg = loadJson(cfgFile, {});
  cfg.deviceName = cfg.deviceName || os.hostname() || 'My computer';
  cfg.saveDir = cfg.saveDir || path.join(os.homedir(), 'Downloads', 'LocalBeam');
  cfg.port = cfg.port || 53700;
  cfg.devices = Array.isArray(cfg.devices) ? cfg.devices : [];
  cfg.shares = Array.isArray(cfg.shares) ? cfg.shares : [];
  cfg.notes = Array.isArray(cfg.notes) ? cfg.notes : [];
  let history = loadJson(histFile, []);
  if (!Array.isArray(history)) history = [];

  const saveConfig = () => saveJson(cfgFile, cfg);
  const saveHistory = () => saveJson(histFile, history);
  saveConfig();

  function ensureSaveDir() {
    fs.mkdirSync(cfg.saveDir, { recursive: true });
    return cfg.saveDir;
  }
  function incomingDir() {
    const d = path.join(ensureSaveDir(), '.localbeam-incoming');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  // Drop half-finished uploads nobody came back for.
  try {
    const d = incomingDir();
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_PART_MS) fs.rmSync(p, { force: true });
    }
  } catch { /* save folder not reachable right now */ }

  function addHistory(item) {
    history.unshift(Object.assign({ id: newId(), time: Date.now() }, item));
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    saveHistory();
  }

  // ----- pairing -----
  let pair = null;
  const qrCache = new Map();
  const pairFails = new Map(); // ip -> { count, resetAt }

  function freshPair() {
    pair = {
      secret: crypto.randomBytes(16).toString('hex'),
      code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
      expires: Date.now() + PAIR_TTL_MS,
      fails: 0,
    };
    qrCache.clear();
  }
  function currentPair() {
    if (!pair || Date.now() > pair.expires) freshPair();
    return pair;
  }

  function uniqueDeviceName(base) {
    const names = new Set(cfg.devices.map((d) => d.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  function addDevice(req, givenName) {
    const token = crypto.randomBytes(24).toString('base64url');
    const clean = typeof givenName === 'string' ? givenName.replace(/[\x00-\x1f]/g, '').trim().slice(0, 40) : '';
    const dev = {
      id: newId(),
      name: uniqueDeviceName(clean || guessDeviceName(req.headers['user-agent'])),
      tokenHash: sha(token),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    cfg.devices.push(dev);
    saveConfig();
    freshPair(); // a pairing code works once
    log(`Paired: ${dev.name}`);
    return { dev, token };
  }

  function deviceFor(req, url) {
    const token = req.headers['x-device-token'] || url.searchParams.get('d') || cookie(req, 'lb');
    if (!token) return null;
    const h = sha(token);
    return cfg.devices.find((d) => d.tokenHash === h) || null;
  }

  function authCookie(req, token) {
    const secure = req.socket.encrypted ? ' Secure;' : '';
    return { 'Set-Cookie': `lb=${token}; Max-Age=315360000; Path=/; HttpOnly;${secure} SameSite=Lax` };
  }

  // ----- transfers shown on the computer's "In progress" list -----
  const transfers = new Map();
  function transfer(id, init) {
    let t = transfers.get(id);
    if (!t) {
      t = Object.assign({ id, done: 0, speed: 0, status: 'active', startedAt: Date.now(), _last: 0, streams: new Set() }, init);
      t._last = t.done;
      transfers.set(id, t);
    }
    t.updatedAt = Date.now();
    return t;
  }
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of transfers) {
      const delta = Math.max(0, t.done - t._last);
      t._last = t.done;
      t.speed = t.status === 'active' ? Math.round(t.speed * 0.5 + delta * 0.5) : 0;
      if (delta > 0) t.updatedAt = now;
      if (t.status !== 'active' && now - t.updatedAt > 10 * 60 * 1000) transfers.delete(id);
      if (t.status === 'active' && now - t.updatedAt > 24 * 3600 * 1000) transfers.delete(id);
    }
  }, 1000);
  ticker.unref();

  // ----- uploads from devices (resumable, in chunks) -----
  const uploads = new Map(); // id -> { id, deviceId, name, size, part, busy, cancelled }

  function dropUpload(u, status) {
    uploads.delete(u.id);
    if (!u.busy) fs.rm(u.part, { force: true }, () => {});
    const t = transfers.get('in:' + u.id);
    if (t) { t.status = status; t.updatedAt = Date.now(); }
  }

  async function uploadStart(req, res, dev) {
    const body = await readJson(req);
    const size = Number(body.size);
    if (typeof body.name !== 'string' || !body.name || !Number.isSafeInteger(size) || size < 0) {
      return send(res, 400, 'Bad upload request');
    }
    const id = sha([dev.id, body.name, size, Number(body.lastModified) || 0].join('|')).slice(0, 24);
    const part = path.join(incomingDir(), id + '.part');
    let offset = 0;
    try { offset = fs.statSync(part).size; } catch { fs.closeSync(fs.openSync(part, 'a')); }
    if (offset > size) { fs.truncateSync(part, 0); offset = 0; }
    // Keep the same record if this upload is being resumed: a chunk may still be finishing on it.
    const prev = uploads.get(id);
    if (prev) prev.cancelled = false;
    else uploads.set(id, { id, deviceId: dev.id, name: body.name, size, part, busy: false, cancelled: false });
    const t = transfer('in:' + id, { dir: 'in', name: safeName(body.name), size, device: dev.name });
    t.status = 'active';
    t.done = offset;
    t._last = offset;
    json(res, { id, offset, chunk: CHUNK_BYTES });
  }

  function uploadChunk(req, res, url, dev) {
    const u = uploads.get(url.searchParams.get('id'));
    if (!u || u.deviceId !== dev.id) return send(res, 404, 'Unknown upload');
    if (u.cancelled) { dropUpload(u, 'cancelled'); return send(res, 410, 'Cancelled'); }
    if (u.busy) return send(res, 409, 'Busy');
    let cur = 0;
    try { cur = fs.statSync(u.part).size; } catch { return send(res, 404, 'Unknown upload'); }
    if (Number(url.searchParams.get('offset')) !== cur) return json(res, { offset: cur }, 409);

    const t = transfer('in:' + u.id, { dir: 'in', name: safeName(u.name), size: u.size, device: dev.name });
    t.status = 'active';
    u.busy = true;
    let got = 0;
    let tooMuch = false;
    req.on('data', (c) => {
      got += c.length;
      t.done = Math.min(cur + got, u.size);
      if (cur + got > u.size && !tooMuch) { tooMuch = true; req.destroy(); } // more bytes than the file was said to have
    });
    pipeline(req, fs.createWriteStream(u.part, { flags: 'a' }), (err) => {
      u.busy = false;
      let now = cur;
      try { now = fs.statSync(u.part).size; } catch { /* removed */ }
      t.done = now;
      if (u.cancelled) { dropUpload(u, 'cancelled'); return send(res, 410, 'Cancelled'); }
      if (tooMuch || now > u.size) { dropUpload(u, 'failed'); return send(res, 400, 'Too much data'); }
      if (err) return send(res, 500, 'Chunk interrupted');
      json(res, { offset: now });
    });
  }

  function uploadFinish(req, res, url, dev) {
    const u = uploads.get(url.searchParams.get('id'));
    if (!u || u.deviceId !== dev.id) return send(res, 404, 'Unknown upload');
    if (u.busy) return send(res, 409, 'Busy');
    let cur = -1;
    try { cur = fs.statSync(u.part).size; } catch { /* missing */ }
    if (cur !== u.size) return json(res, { offset: Math.max(cur, 0) }, 409);
    const dest = uniquePath(ensureSaveDir(), safeName(u.name));
    try {
      try { fs.renameSync(u.part, dest); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(u.part, dest);
        fs.rmSync(u.part, { force: true });
      }
    } catch { return send(res, 500, 'Could not save the file'); }
    uploads.delete(u.id);
    const t = transfers.get('in:' + u.id);
    if (t) { t.status = 'done'; t.done = u.size; t.updatedAt = Date.now(); }
    addHistory({ type: 'file', name: path.basename(dest), size: u.size, path: dest, from: dev.name });
    log(`Received ${path.basename(dest)} from ${dev.name}`);
    json(res, { name: path.basename(dest) });
  }

  // ----- files offered to devices -----
  function listShares() {
    return cfg.shares.map((s) => {
      let ok = true;
      try { ok = fs.statSync(s.path).isFile(); } catch { ok = false; }
      return { id: s.id, name: s.name, size: s.size, missing: !ok, addedAt: s.addedAt };
    });
  }

  function addSharePaths(paths) {
    const added = [];
    const skipped = [];
    for (const p of paths || []) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      let st;
      try { st = fs.statSync(p); } catch { skipped.push(path.basename(p)); continue; }
      if (!st.isFile()) { skipped.push(path.basename(p)); continue; } // folders: zip them first
      if (cfg.shares.some((s) => s.path === p)) continue;
      const share = { id: newId(), path: p, name: path.basename(p), size: st.size, addedAt: Date.now(), temp: false };
      cfg.shares.unshift(share);
      added.push(share.name);
    }
    if (added.length) saveConfig();
    return { added, skipped };
  }

  function removeShare(id) {
    const i = cfg.shares.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = cfg.shares.splice(i, 1);
    if (s.temp) fs.rm(s.path, { force: true }, () => {}); // only copies LocalBeam made itself
    saveConfig();
    for (const [tid, t] of transfers) {
      if (tid.startsWith('out:' + id + ':')) { for (const r of t.streams) r.destroy(); transfers.delete(tid); }
    }
  }

  function sendShare(req, res, url, dev) {
    const share = cfg.shares.find((s) => s.id === url.searchParams.get('id'));
    if (!share) return send(res, 404, 'That file is no longer available.');
    let st;
    try { st = fs.statSync(share.path); } catch { return send(res, 404, 'That file is no longer available.'); }
    if (!st.isFile()) return send(res, 404, 'That file is no longer available.');

    const size = st.size;
    const etag = `"${size}-${Math.floor(st.mtimeMs)}"`;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (range && size > 0 && (!ifRange || ifRange === etag)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), size - 1);
        } else {
          start = Math.max(0, size - Number(m[2]));
        }
        if (start > end || start >= size) {
          return send(res, 416, '', 'text/plain', { 'Content-Range': `bytes */${size}` });
        }
        status = 206;
      }
    }

    const view = url.searchParams.get('view') === '1';
    const ascii = share.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const headers = {
      'Content-Type': MIME[path.extname(share.name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': size ? end - start + 1 : 0,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'Cache-Control': 'private, max-age=0',
      'Content-Disposition': `${view ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(share.name)}`,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();

    // Tiny range probes aren't worth showing; real downloads are.
    const track = !view && (end - start + 1 > 65536 || size <= 65536);
    let t = null;
    if (track) {
      t = transfer(`out:${share.id}:${dev.id}`, { dir: 'out', name: share.name, size, device: dev.name });
      if (t.status !== 'active' || start === 0) { t.status = 'active'; t.done = start; t._last = start; }
      t.streams.add(res);
    }
    let pos = start;
    const stream = fs.createReadStream(share.path, { start, end });
    stream.on('data', (c) => { pos += c.length; if (t && pos > t.done) t.done = pos; });
    stream.on('error', () => res.destroy());
    res.on('close', () => {
      stream.destroy();
      if (!t) return;
      t.streams.delete(res);
      if (pos >= size) { t.status = 'done'; t.done = size; log(`${dev.name} downloaded ${share.name}`); }
      t.updatedAt = Date.now();
    });
    stream.pipe(res);
  }

  // ----- network + certificate -----
  let tls = certs.ensure(dataDir, cfg.deviceName, lanAddresses().map((a) => a.address));
  let httpsServer = null;
  const ipWatch = setInterval(() => {
    try {
      const next = certs.ensure(dataDir, cfg.deviceName, lanAddresses().map((a) => a.address));
      if (next.regenerated && httpsServer) {
        httpsServer.setSecureContext({ key: next.key, cert: next.cert });
        qrCache.clear();
        log('Network changed: new certificate issued');
      }
      tls = next;
    } catch (e) { log('Certificate check failed: ' + e.message); }
  }, 10000);
  ipWatch.unref();

  let httpsPort = 0;
  // The part after # never leaves the phone. Browsers ignore it; the LocalBeam phone apps read the
  // CA fingerprint from it and pin the connection to this computer.
  const pairUrl = (address) =>
    `https://${address}:${httpsPort}/pair?c=${currentPair().secret}#fp=${Buffer.from(tls.caFingerprint, 'hex').toString('base64url')}`;

  // Checks a typed 6-digit code. Returns null when it is right, otherwise the refusal to send.
  function refusePairCode(req, raw) {
    const ip = req.socket.remoteAddress || '?';
    const now = Date.now();
    let f = pairFails.get(ip);
    if (!f || now > f.resetAt) { f = { count: 0, resetAt: now + 60000 }; pairFails.set(ip, f); }
    if (f.count >= 5) return { status: 429, message: 'Too many tries. Wait a minute and try again.' };
    const cur = currentPair();
    const given = String(raw || '').replace(/\D/g, '');
    if (given.length === 6 && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(cur.code))) return null;
    f.count++;
    if (++cur.fails >= 15) freshPair(); // someone is guessing: change the code
    return { status: 403, message: 'That code is not right. Check the code on the computer.' };
  }

  // ---------- LAN handler (phones and other devices) ----------
  async function lanHandler(req, res) {
    const url = new URL(req.url, 'https://lan');
    const p = url.pathname;
    const route = req.method + ' ' + p;
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'GET' && STATIC_LAN[p]) return serveFile(res, STATIC_LAN[p]);

    if (route === 'GET /localbeam-ca.crt') {
      return send(res, 200, tls.caCertPem, 'application/x-x509-ca-cert',
        { 'Content-Disposition': 'attachment; filename="LocalBeam-CA.crt"' });
    }

    if (route === 'GET /') {
      return deviceFor(req, url) ? redirect(res, '/app') : serveFile(res, 'phone/pair.html');
    }

    if (route === 'GET /pair') {
      const cur = currentPair();
      const given = String(url.searchParams.get('c') || '');
      const ok = given.length === cur.secret.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(cur.secret));
      if (!ok) return redirect(res, '/?expired=1');
      const { token } = addDevice(req);
      return redirect(res, '/app?d=' + token, authCookie(req, token));
    }

    if (route === 'POST /pair-code') {
      const body = await readJson(req);
      const refusal = refusePairCode(req, body.code);
      if (refusal) return send(res, refusal.status, refusal.message);
      const { token } = addDevice(req);
      return json(res, { url: '/app?d=' + token }, 200, authCookie(req, token));
    }

    // Pairing for the LocalBeam phone apps: the QR secret (scanned in the app) or the typed code.
    if (route === 'POST /pair-app') {
      const body = await readJson(req);
      if (typeof body.secret === 'string') {
        const cur = currentPair();
        const ok = body.secret.length === cur.secret.length &&
          crypto.timingSafeEqual(Buffer.from(body.secret), Buffer.from(cur.secret));
        if (!ok) return send(res, 403, 'That QR code is no longer valid. Scan the one on the computer again.');
      } else {
        const refusal = refusePairCode(req, body.code);
        if (refusal) return send(res, refusal.status, refusal.message);
      }
      const { dev, token } = addDevice(req, body.name);
      return json(res, { token, device: dev.name, computer: cfg.deviceName });
    }

    if (route === 'GET /app') {
      const dev = deviceFor(req, url);
      if (!dev) return redirect(res, '/');
      const d = url.searchParams.get('d');
      if (d && sha(d) === dev.tokenHash) res.setHeader('Set-Cookie', authCookie(req, d)['Set-Cookie']);
      return serveFile(res, 'phone/index.html');
    }

    if (route === 'GET /manifest.webmanifest') {
      const dev = deviceFor(req, url);
      const d = url.searchParams.get('d');
      return send(res, 200, JSON.stringify({
        name: 'LocalBeam',
        short_name: 'LocalBeam',
        start_url: dev && d && sha(d) === dev.tokenHash ? '/app?d=' + encodeURIComponent(d) : '/app',
        scope: '/',
        display: 'browser',
        background_color: '#F4F5F7',
        theme_color: '#F4F5F7',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      }), 'application/manifest+json');
    }

    if (!p.startsWith('/d/')) return send(res, 404, 'Not found');

    // Everything under /d/ needs a paired device.
    const dev = deviceFor(req, url);
    if (!dev) return send(res, 401, 'This device is not paired.');
    dev.lastSeen = Date.now();

    if (route === 'GET /d/state') {
      return json(res, {
        device: { name: dev.name },
        computer: { name: cfg.deviceName },
        files: listShares().filter((s) => !s.missing).map((s) => ({ id: s.id, name: s.name, size: s.size })),
        notes: cfg.notes,
        chunk: CHUNK_BYTES,
      });
    }
    if (route === 'POST /d/text') {
      const text = (await readBody(req, MAX_TEXT)).trim();
      if (!text) return send(res, 400, 'Nothing to send');
      addHistory({ type: 'text', text, from: dev.name });
      log(`Text received from ${dev.name}`);
      return json(res, { ok: true });
    }
    if (route === 'POST /d/upload/start') return uploadStart(req, res, dev);
    if (route === 'PUT /d/upload/chunk') return uploadChunk(req, res, url, dev);
    if (route === 'POST /d/upload/finish') return uploadFinish(req, res, url, dev);
    if (route === 'DELETE /d/upload') {
      const u = uploads.get(url.searchParams.get('id'));
      if (u && u.deviceId === dev.id) { u.cancelled = true; if (!u.busy) dropUpload(u, 'cancelled'); }
      return json(res, { ok: true });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/d/file') return sendShare(req, res, url, dev);
    send(res, 404, 'Not found');
  }

  // ---------- local handler (this computer's own screens) ----------
  const isLocalReq = (req) =>
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');

  function stateForDesktop() {
    const now = Date.now();
    const cur = currentPair();
    const addresses = lanAddresses();
    return {
      computer: { name: cfg.deviceName, addresses, port: httpsPort, shell: !!opts.shell, platform: process.platform },
      pairing: {
        code: cur.code,
        expires: cur.expires,
        key: cur.secret.slice(0, 8), // changes whenever the QR code changes
        manual: addresses.map((a) => `https://${a.address}:${httpsPort}`),
      },
      devices: cfg.devices.map((d) => ({ id: d.id, name: d.name, connected: now - d.lastSeen < ONLINE_MS, lastSeen: d.lastSeen })),
      shares: listShares(),
      notes: cfg.notes,
      transfers: [...transfers.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((t) => ({
          id: t.id, dir: t.dir, name: t.name, size: t.size, done: t.done, speed: t.speed, device: t.device,
          status: t.status === 'active' && now - t.updatedAt > 8000 ? 'waiting' : t.status,
        })),
      received: history.slice(0, 200).map((h) => ({
        id: h.id, type: h.type, name: h.name, size: h.size, text: h.text, from: h.from, time: h.time,
      })),
      settings: {
        deviceName: cfg.deviceName,
        saveDir: cfg.saveDir,
        autoStart: hooks.getAutoStart(),
        fingerprint: tls.fingerprint,
        canPick: typeof hooks.pickFiles === 'function',
      },
    };
  }

  async function localHandler(req, res) {
    if (!isLocalReq(req)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const route = req.method + ' ' + p;
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'GET' && STATIC_LOCAL[p]) return serveFile(res, STATIC_LOCAL[p]);
    if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
    // Changes need a custom header, which other websites open in a browser on this computer cannot send.
    if (req.method !== 'GET' && req.headers['x-localbeam'] !== '1') return send(res, 403, 'Forbidden');

    if (route === 'GET /api/state') return json(res, stateForDesktop());

    if (route === 'GET /api/qr.svg') {
      const ip = url.searchParams.get('ip');
      const addr = lanAddresses().find((a) => a.address === ip);
      if (!addr) return send(res, 404, 'No such address');
      const target = pairUrl(addr.address);
      if (!qrCache.has(target)) {
        qrCache.set(target, await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
      }
      return send(res, 200, qrCache.get(target), 'image/svg+xml');
    }

    // The same link the QR code holds, as text. Like the QR image, only this computer can ask for it.
    if (route === 'GET /api/pair-link') {
      const addr = lanAddresses().find((a) => a.address === url.searchParams.get('ip'));
      if (!addr) return send(res, 404, 'No such address');
      return json(res, { link: pairUrl(addr.address) });
    }

    if (route === 'POST /api/new-pair') { freshPair(); return json(res, { ok: true }); }

    if (route === 'POST /api/share-paths') {
      const body = await readJson(req);
      return json(res, addSharePaths(body.paths));
    }
    if (route === 'POST /api/pick-files') {
      if (typeof hooks.pickFiles !== 'function') return send(res, 501, 'Not available here');
      return json(res, addSharePaths(await hooks.pickFiles()));
    }
    if (route === 'POST /api/outbox-upload') {
      // Used when the screens run in an ordinary browser, which cannot tell us where a file lives on disk.
      fs.mkdirSync(outboxDir, { recursive: true });
      let name = 'file';
      try { name = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch { /* keep default */ }
      const tmp = path.join(outboxDir, '.incoming-' + newId() + '.part');
      return pipeline(req, fs.createWriteStream(tmp), (err) => {
        if (err) { fs.rm(tmp, { force: true }, () => {}); return send(res, 500, 'Upload failed'); }
        const dest = uniquePath(outboxDir, safeName(name));
        fs.renameSync(tmp, dest);
        cfg.shares.unshift({
          id: newId(), path: dest, name: path.basename(dest), size: fs.statSync(dest).size, addedAt: Date.now(), temp: true,
        });
        saveConfig();
        json(res, { added: [path.basename(dest)], skipped: [] });
      });
    }
    if (route === 'DELETE /api/share') { removeShare(url.searchParams.get('id')); return json(res, { ok: true }); }

    if (route === 'POST /api/note') {
      const text = (await readBody(req, MAX_TEXT)).trim();
      if (!text) return send(res, 400, 'Nothing to send');
      cfg.notes.unshift({ id: newId(), text, time: Date.now() });
      saveConfig();
      return json(res, { ok: true });
    }
    if (route === 'DELETE /api/note') {
      cfg.notes = cfg.notes.filter((n) => n.id !== url.searchParams.get('id'));
      saveConfig();
      return json(res, { ok: true });
    }

    if (route === 'DELETE /api/device') {
      cfg.devices = cfg.devices.filter((d) => d.id !== url.searchParams.get('id'));
      saveConfig();
      return json(res, { ok: true });
    }

    if (route === 'POST /api/settings') {
      const body = await readJson(req);
      if (typeof body.deviceName === 'string') {
        const name = body.deviceName.trim().slice(0, 40);
        if (!name) return send(res, 400, 'The name cannot be empty.');
        cfg.deviceName = name;
      }
      if (typeof body.saveDir === 'string') {
        const dir = body.saveDir.trim();
        if (!path.isAbsolute(dir)) return send(res, 400, 'Give the full path of a folder.');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { return send(res, 400, 'That folder cannot be used.'); }
        cfg.saveDir = dir;
      }
      if (typeof body.autoStart === 'boolean') hooks.setAutoStart(body.autoStart);
      saveConfig();
      return json(res, { ok: true });
    }
    if (route === 'POST /api/pick-save-folder') {
      if (typeof hooks.pickFolder !== 'function') return send(res, 501, 'Not available here');
      const dir = await hooks.pickFolder();
      if (dir) { cfg.saveDir = dir; saveConfig(); }
      return json(res, { saveDir: cfg.saveDir });
    }

    if (route === 'POST /api/open-folder') { hooks.openPath(ensureSaveDir()); return json(res, { ok: true }); }
    if (route === 'POST /api/open-item' || route === 'POST /api/show-item') {
      const item = history.find((h) => h.id === url.searchParams.get('id'));
      if (!item || item.type !== 'file' || !fs.existsSync(item.path)) {
        return send(res, 404, 'That file has been moved or deleted.');
      }
      if (route === 'POST /api/open-item') hooks.openPath(item.path); else hooks.showItem(item.path);
      return json(res, { ok: true });
    }
    if (route === 'POST /api/clear-history') { history = []; saveHistory(); return json(res, { ok: true }); }

    if (route === 'POST /api/transfer-cancel') {
      const id = String(url.searchParams.get('id') || '');
      const t = transfers.get(id);
      if (t && id.startsWith('in:')) {
        const u = uploads.get(id.slice(3));
        if (u) { u.cancelled = true; if (!u.busy) dropUpload(u, 'cancelled'); }
        t.status = 'cancelled';
      } else if (t) {
        for (const r of t.streams) r.destroy();
        t.status = 'cancelled';
      }
      if (t) t.updatedAt = Date.now();
      return json(res, { ok: true });
    }

    send(res, 404, 'Not found');
  }

  const guard = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!err.status) log('Request failed: ' + (err.stack || err.message));
      send(res, err.status || 500, err.status === 413 ? 'Too large' : err.status === 400 ? 'Bad request' : 'Something went wrong');
    });
  };

  function listen(server, port, host, tries) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const onError = (err) => {
          if (err.code === 'EADDRINUSE' && port !== 0 && n < tries) return attempt(n + 1);
          reject(err);
        };
        server.once('error', onError);
        server.listen(port === 0 ? 0 : port + n, host, () => {
          server.removeListener('error', onError);
          resolve(server.address().port);
        });
      };
      attempt(0);
    });
  }

  httpsServer = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, guard(lanHandler));
  httpsServer.requestTimeout = 0; // very large files take as long as they take
  httpsPort = await listen(httpsServer, cfg.port, '0.0.0.0', 20);

  const uiServer = http.createServer(guard(localHandler));
  uiServer.requestTimeout = 0;
  const uiPort = await listen(uiServer, opts.uiPort || 0, '127.0.0.1', 20);

  // Development only: the device pages over plain http on this computer, for testing without certificate prompts.
  let devServer = null;
  if (opts.devHttpPort) {
    devServer = http.createServer(guard(lanHandler));
    await listen(devServer, opts.devHttpPort, '127.0.0.1', 0);
  }

  const lastSeenSave = setInterval(saveConfig, 60000);
  lastSeenSave.unref();

  log(`LocalBeam engine ready. Screens: http://127.0.0.1:${uiPort}  Devices: https port ${httpsPort}`);

  return {
    uiUrl: `http://127.0.0.1:${uiPort}`,
    uiPort,
    httpsPort,
    stop() {
      clearInterval(ticker); clearInterval(ipWatch); clearInterval(lastSeenSave);
      try { saveConfig(); } catch { /* shutting down */ }
      httpsServer.close(); uiServer.close();
      if (devServer) devServer.close();
    },
  };
}

module.exports = { startEngine };
