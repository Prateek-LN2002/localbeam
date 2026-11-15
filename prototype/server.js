'use strict';
// Phone -> Laptop file transfer over the local Wi-Fi network. No dependencies.
// Laptop opens http://localhost:PORT (shows a QR code); phone scans it and uploads files.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8000;
const SAVE_DIR = process.env.SAVE_DIR || path.join(os.homedir(), 'Downloads', 'iPhone Transfer');
const TOKEN = crypto.randomBytes(6).toString('hex'); // new secret every start; only the QR carries it

const PAGES = {
  host: fs.readFileSync(path.join(__dirname, 'host.html')),
  phone: fs.readFileSync(path.join(__dirname, 'phone.html')),
};

fs.mkdirSync(SAVE_DIR, { recursive: true });
for (const f of fs.readdirSync(SAVE_DIR)) {
  if (f.startsWith('.incoming-')) fs.rmSync(path.join(SAVE_DIR, f), { force: true });
}

// Links and notes sent from the phone: kept in memory for the laptop page, and appended to a text file.
const NOTES_NAME = 'Links and notes.txt';
const NOTES_FILE = path.join(SAVE_DIR, NOTES_NAME);
const MESSAGES = [];
const MAX_TEXT = 100000;

// Laptop -> phone: files waiting in "To phone" (you can also drop files there in Explorer) and notes in memory.
const OUTBOX = path.join(SAVE_DIR, 'To phone');
fs.mkdirSync(OUTBOX, { recursive: true });
for (const f of fs.readdirSync(OUTBOX)) {
  if (f.startsWith('.incoming-')) fs.rmSync(path.join(OUTBOX, f), { force: true });
}
const OUT_NOTES = [];
let noteId = 0;

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.zip': 'application/zip',
};

// Laptop-only pages must come from this machine AND be addressed as localhost (blocks DNS-rebinding tricks).
const isLocal = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.push({ name, address: a.address });
      }
    }
  }
  const score = (n) =>
    /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier/i.test(n) ? 3
      : /wi-?fi|wlan|wireless/i.test(n) ? 0
      : /ethernet/i.test(n) ? 1 : 2;
  return out.sort((x, y) => score(x.name) - score(y.name));
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), 'application/json');

function fmt(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return (i ? bytes.toFixed(1) : bytes) + ' ' + u[i];
}

function safeName(raw) {
  let n = String(raw);
  try { n = decodeURIComponent(n); } catch { /* keep raw */ }
  n = path.basename(n.replace(/\\/g, '/'))
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

function listFiles(dir = SAVE_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && d.name !== NOTES_NAME)
    .map((d) => {
      const s = fs.statSync(path.join(dir, d.name));
      return { name: d.name, size: s.size, time: s.mtimeMs };
    })
    .sort((a, b) => b.time - a.time);
}

function handleUpload(req, res, dir = SAVE_DIR) {
  const name = safeName(req.headers['x-filename'] || 'upload');
  const tmp = path.join(dir, '.incoming-' + crypto.randomBytes(4).toString('hex') + '.part');
  pipeline(req, fs.createWriteStream(tmp), (err) => {
    if (err) {
      fs.rm(tmp, { force: true }, () => {});
      console.log(`Upload of ${name} was interrupted`);
      if (!res.headersSent && !res.destroyed) send(res, 500, 'Upload failed');
      return;
    }
    const dest = uniquePath(dir, name);
    fs.rename(tmp, dest, (e2) => {
      if (e2) {
        fs.rm(tmp, { force: true }, () => {});
        return send(res, 500, 'Could not save file');
      }
      const size = fs.statSync(dest).size;
      console.log(`${dir === OUTBOX ? 'Ready for phone' : 'Received'}: ${path.basename(dest)} (${fmt(size)})`);
      json(res, { name: path.basename(dest), size });
    });
  });
}

function readText(req, res, onText) {
  let body = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (!tooBig) body += chunk;
    if (body.length > MAX_TEXT) tooBig = true;
  });
  req.on('end', () => {
    if (tooBig) return send(res, 413, 'Text is too long');
    const text = body.trim();
    if (!text) return send(res, 400, 'Nothing to send');
    onText(text);
  });
}

function handleDownload(req, res, url) {
  let name;
  try { name = decodeURIComponent(url.pathname.slice('/download/'.length)); } catch { return send(res, 400, 'Bad file name'); }
  name = path.basename(name);
  const file = path.join(OUTBOX, name);
  if (!name || name.startsWith('.') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'That file is no longer available.');
  }
  const size = fs.statSync(file).size;
  const view = url.searchParams.get('view') === '1';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'Content-Disposition': `${view ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  if (req.method === 'HEAD') return res.end();
  if (!view) console.log(`Phone downloaded: ${name} (${fmt(size)})`);
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function handleText(req, res) {
  readText(req, res, (text) => {
    const msg = { text, time: Date.now() };
    MESSAGES.unshift(msg);
    fs.appendFile(NOTES_FILE, `[${new Date(msg.time).toLocaleString()}]\r\n${text}\r\n\r\n`, () => {});
    const preview = text.replace(/\s+/g, ' ');
    console.log(`Received text: ${preview.length > 80 ? preview.slice(0, 80) + '…' : preview}`);
    json(res, { ok: true });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const route = req.method + ' ' + url.pathname;
  const tokenOk = url.searchParams.get('k') === TOKEN;

  if (route === 'GET /') {
    if (isLocal(req)) return send(res, 200, PAGES.host, 'text/html; charset=utf-8');
    return send(res, 403, 'Scan the QR code shown on the laptop screen to open the upload page.');
  }
  if (route === 'GET /send') {
    if (!tokenOk) return send(res, 403, 'This link is no longer valid. Scan the QR code on the laptop again.');
    return send(res, 200, PAGES.phone, 'text/html; charset=utf-8');
  }
  if (route === 'POST /upload') {
    if (!tokenOk) return send(res, 403, 'This link is no longer valid. Scan the QR code on the laptop again.');
    return handleUpload(req, res);
  }
  if (route === 'POST /text') {
    if (!tokenOk) return send(res, 403, 'This link is no longer valid. Scan the QR code on the laptop again.');
    return handleText(req, res);
  }
  if (route === 'GET /inbox') {
    if (!tokenOk) return send(res, 403, 'This link is no longer valid. Scan the QR code on the laptop again.');
    return json(res, { files: listFiles(OUTBOX), notes: OUT_NOTES });
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/download/')) {
    if (!tokenOk) return send(res, 403, 'This link is no longer valid. Scan the QR code on the laptop again.');
    return handleDownload(req, res, url);
  }

  // Everything below is for the laptop page only.
  if (url.pathname.startsWith('/api/') && !isLocal(req)) return send(res, 403, 'Forbidden');
  // Changes need a custom header, which other websites open in the laptop's browser can't send.
  if (req.method !== 'GET' && req.headers['x-local'] !== '1') return send(res, 403, 'Forbidden');
  if (route === 'GET /api/outbox') return json(res, { files: listFiles(OUTBOX), notes: OUT_NOTES });
  if (route === 'POST /api/outbox') return handleUpload(req, res, OUTBOX);
  if (route === 'DELETE /api/outbox') {
    const name = path.basename(url.searchParams.get('name') || '');
    if (name && !name.startsWith('.')) fs.rmSync(path.join(OUTBOX, name), { force: true });
    return json(res, { ok: true });
  }
  if (route === 'POST /api/note') {
    return readText(req, res, (text) => {
      OUT_NOTES.unshift({ id: ++noteId, text, time: Date.now() });
      console.log('Text ready for phone');
      json(res, { ok: true });
    });
  }
  if (route === 'DELETE /api/note') {
    const i = OUT_NOTES.findIndex((n) => n.id === Number(url.searchParams.get('id')));
    if (i >= 0) OUT_NOTES.splice(i, 1);
    return json(res, { ok: true });
  }
  if (route === 'GET /api/info') {
    return json(res, { port: PORT, token: TOKEN, saveDir: SAVE_DIR, addresses: lanAddresses() });
  }
  if (route === 'GET /api/files') return json(res, listFiles());
  if (route === 'GET /api/messages') return json(res, MESSAGES);
  if (route === 'POST /api/open-folder') {
    spawn('explorer.exe', [SAVE_DIR], { detached: true, stdio: 'ignore' }).unref();
    return json(res, { ok: true });
  }
  send(res, 404, 'Not found');
});

server.requestTimeout = 0; // big files can take longer than Node's 5-minute default
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Laptop page (shows the QR code): http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  ${a.name}: http://${a.address}:${PORT}/send?k=${TOKEN}`);
  console.log(`Received files are saved to: ${SAVE_DIR}`);
});
