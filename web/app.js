(function () {
  'use strict';

  // LocalBeam in the browser.
  // Two devices open this page and connect straight to each other with WebRTC, which encrypts everything
  // between them. A public service (PeerJS) is used only to introduce the two browsers. Because that service
  // could in principle sit in the middle, each device proves to the other that it knows the secret from the
  // pairing code, tied to the fingerprints of this exact encrypted connection. A device in the middle fails.

  var $ = function (id) { return document.getElementById(id); };
  var CHUNK = 64 * 1024;                 // bytes per message
  var READ = 1024 * 1024;                // bytes read from disk at a time
  var HIGH_WATER = 8 * 1024 * 1024;      // pause sending above this much queued
  var LOW_WATER = 1024 * 1024;
  var PAIR_TTL = 10 * 60 * 1000;
  var ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // direct connections only, no relay

  // A second identity in the same browser, for testing two "devices" in two tabs: add ?profile=b
  var profile = new URLSearchParams(location.search).get('profile') || '';
  var STORE = 'localbeam.v1' + (profile ? '.' + profile : '');

  // ---------- small helpers ----------

  function hex(bytes) { return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function unhex(s) { var out = new Uint8Array(s.length / 2); for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out; }
  function randomHex(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function fmtSize(b) { var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + u[i]; }
  function initials(name) { var w = String(name).trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : String(name).slice(0, 2)).toUpperCase(); }
  function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function guessName() {
    var ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
    if (/Linux|X11/i.test(ua)) return 'Linux PC';
    return 'Device';
  }

  function linkify(target, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[.,;:!?)\]]+$/, '');
      target.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = el('a', null, url);
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      target.appendChild(a);
      last = m.index + url.length;
      re.lastIndex = last;
    }
    target.appendChild(document.createTextNode(text.slice(last)));
  }

  async function hmac(secretHex, text) {
    var key = await crypto.subtle.importKey('raw', unhex(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))));
  }

  // The fingerprint of each end of the encrypted connection, as written in its session description.
  function fingerprintOf(description) {
    var m = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec((description && description.sdp) || '');
    return m ? m[1].toUpperCase() : '';
  }

  // ---------- saved state ----------

  var store = (function () {
    try {
      var s = JSON.parse(localStorage.getItem(STORE));
      if (s && s.id && Array.isArray(s.peers)) return s;
    } catch (e) { /* first visit, or storage blocked */ }
    return { id: 'lb-' + randomHex(16), name: guessName(), peers: [] };
  })();
  function save() { try { localStorage.setItem(STORE, JSON.stringify(store)); } catch (e) { /* storage blocked */ } }
  save();
  function known(id) { return store.peers.filter(function (p) { return p.id === id; })[0]; }

  // ---------- where received files are kept ----------

  var sink = (function () {
    var worker = null, waiters = {}, rid = 0, mem = {};
    try {
      if (navigator.storage && navigator.storage.getDirectory && window.Worker) {
        worker = new Worker('opfs-worker.js');
        worker.onmessage = function (e) {
          var d = e.data;
          if (d.op === 'werror') { failIncoming(d.id, d.error); return; }
          var w = waiters[d.rid];
          if (!w) return;
          delete waiters[d.rid];
          if (d.error) w.reject(new Error(d.error)); else w.resolve(d);
        };
        worker.onerror = function () { worker = null; };
        worker.postMessage({ op: 'purge' }); // clear anything left from an earlier visit
      }
    } catch (e) { worker = null; }
    function call(msg) {
      return new Promise(function (resolve, reject) {
        if (!worker) return reject(new Error('no disk storage'));
        msg.rid = ++rid;
        waiters[msg.rid] = { resolve: resolve, reject: reject };
        worker.postMessage(msg);
      });
    }
    return {
      // Returns 'disk' when the file will be written to disk, 'memory' when it has to be held in memory.
      open: async function (id) {
        try { await call({ op: 'open', id: id }); return 'disk'; } catch (e) { mem[id] = []; return 'memory'; }
      },
      write: function (kind, id, buf) {
        if (kind === 'disk') worker.postMessage({ op: 'write', id: id, buf: buf }, [buf]);
        else if (mem[id]) mem[id].push(buf);
      },
      close: async function (kind, id, name, type) {
        if (kind === 'memory') { var parts = mem[id] || []; delete mem[id]; return new File(parts, name, { type: type || '' }); }
        await call({ op: 'close', id: id });
        var root = await navigator.storage.getDirectory();
        var dir = await root.getDirectoryHandle('localbeam-incoming');
        var onDisk = await (await dir.getFileHandle(id)).getFile();
        return new File([onDisk], name, { type: type || '' }); // refers to the file on disk; nothing is copied
      },
      remove: function (kind, id) {
        if (kind === 'disk' && worker) worker.postMessage({ op: 'remove', id: id });
        delete mem[id];
      },
    };
  })();

  // ---------- connections ----------

  var peer = null, online = false;
  var links = {};          // peer id -> link
  var pairing = null;      // { secret, expires }: what the QR code currently offers
  var pendingPair = null;  // { id, secret, name }: a code this device scanned and is acting on

  function setPill(text, cls) { var p = $('pill'); p.textContent = text; p.className = 'pill' + (cls ? ' ' + cls : ''); }
  function banner(text) { var b = $('banner'); b.hidden = !text; b.textContent = text || ''; }

  function refreshPill() {
    var connected = Object.keys(links).filter(function (id) { return links[id].state === 'connected'; }).length;
    if (!online) setPill('Connecting…', 'wait');
    else if (connected) setPill('Encrypted · Direct');
    else setPill('Ready', 'wait');
  }

  function startPeer() {
    if (typeof Peer === 'undefined' || !window.RTCPeerConnection) {
      banner('This browser cannot make direct connections. Try a current version of Safari, Chrome, Edge or Firefox.');
      setPill('Not supported', 'off');
      return;
    }
    peer = new Peer(store.id, { config: ICE, debug: 0 });
    peer.on('open', function () {
      online = true;
      banner('');
      refreshPill();
      if (pendingPair) dial(pendingPair, pendingPair.secret, 'pair');
      dialKnown();
    });
    peer.on('connection', function (conn) { attach(conn, 'answer', null, null); });
    peer.on('disconnected', function () {
      online = false;
      refreshPill();
      setTimeout(function () { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2500);
    });
    peer.on('error', function (err) {
      if (err.type === 'peer-unavailable') {
        // The other device does not have LocalBeam open right now.
        var m = /peer (\S+)/.exec(err.message || '');
        var id = m && m[1];
        if (id && links[id] && links[id].state !== 'connected') dropLink(links[id], false);
        if (pendingPair && pendingPair.id === id) {
          pairStatus('That device is not reachable. Open LocalBeam on it and scan its code again.', 'bad');
          pendingPair = null;
        }
      } else if (err.type === 'unavailable-id') {
        banner('LocalBeam is already open in another tab or window on this device. Use that one, or close it and reload this page.');
        setPill('Already open', 'off');
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        online = false;
        refreshPill();
        banner('Cannot reach the connection service. Check this device\'s internet connection.');
        setTimeout(function () { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 4000);
      } else if (err.type === 'browser-incompatible') {
        banner('This browser cannot make direct connections.');
      }
    });
  }

  // For paired devices, the one whose id sorts first calls the other. This avoids two connections at once.
  function dialKnown() {
    if (!online) return;
    store.peers.forEach(function (p) {
      if (!links[p.id] && store.id < p.id) dial(p, p.secret, 'known');
    });
  }
  setInterval(dialKnown, 6000);

  function dial(target, secret, mode) {
    if (!online || !peer) return;
    if (links[target.id]) { if (links[target.id].state === 'connected') return; dropLink(links[target.id], false); }
    var conn = peer.connect(target.id, { reliable: true, serialization: 'raw' });
    if (!conn) return;
    var link = attach(conn, 'dial', secret, mode);
    link.name = target.name || 'Device';
  }

  function attach(conn, role, secret, mode) {
    var id = conn.peer;
    if (links[id] && links[id].conn !== conn) dropLink(links[id], false);
    var link = {
      id: id, name: (known(id) || {}).name || 'Device', conn: conn, role: role, secret: secret, mode: mode,
      state: 'connecting', queue: [], sending: false, incoming: null, chain: Promise.resolve(), acks: {},
    };
    links[id] = link;
    link.timer = setTimeout(function () { if (link.state !== 'connected') dropLink(link, true); }, 15000);

    conn.on('open', function () {
      if (role === 'dial') sendHello(link).catch(function () { dropLink(link, true); });
      else link.state = 'verifying';
      render();
    });
    conn.on('data', function (data) {
      // Handle messages strictly one after another, so file pieces stay in order with their headers.
      link.chain = link.chain.then(function () { return onData(link, data); }).catch(function () { /* keep going */ });
    });
    conn.on('close', function () { dropLink(link, false); });
    conn.on('error', function () { dropLink(link, true); });
    render();
    return link;
  }

  function dropLink(link, failed) {
    if (links[link.id] !== link) return;
    delete links[link.id];
    clearTimeout(link.timer);
    try { link.conn.close(); } catch (e) { /* already closed */ }
    link.state = 'closed';
    link.queue.forEach(function (job) { if (job.state === 'sending' || job.state === 'waiting' || job.state === 'finishing') { job.state = 'failed'; job.note = 'Connection lost'; } });
    Object.keys(link.acks).forEach(function (k) { link.acks[k](false); });
    if (link.incoming) failIncoming(link.incoming.id, 'Connection lost');
    if (failed && pendingPair && pendingPair.id === link.id) {
      pairStatus('Could not connect directly to that device. Make sure both devices are on the same Wi-Fi, then scan the code again.', 'bad');
      pendingPair = null;
    }
    render();
  }

  function sendCtl(link, obj) {
    try { link.conn.send(JSON.stringify(obj)); } catch (e) { /* connection is closing */ }
  }

  function fingerprints(link) {
    var pc = link.conn.peerConnection;
    return { local: fingerprintOf(pc && pc.localDescription), remote: fingerprintOf(pc && pc.remoteDescription) };
  }

  // The caller proves it knows the secret, bound to both ends of this encrypted connection.
  async function sendHello(link) {
    link.state = 'verifying';
    var fp = fingerprints(link);
    if (!fp.local || !fp.remote) throw new Error('no fingerprints');
    sendCtl(link, {
      t: 'hello', mode: link.mode, name: store.name,
      mac: await hmac(link.secret, 'dial|' + fp.local + '|' + fp.remote),
    });
  }

  async function onHello(link, msg) {
    var fp = fingerprints(link);
    var secret = null;
    if (msg.mode === 'pair') {
      if (pairing && Date.now() < pairing.expires) secret = pairing.secret;
    } else {
      var k = known(link.id);
      if (k) secret = k.secret;
    }
    var ok = !!secret && !!fp.local && !!fp.remote &&
      msg.mac === await hmac(secret, 'dial|' + fp.remote + '|' + fp.local);
    if (!ok) { sendCtl(link, { t: 'reject' }); setTimeout(function () { dropLink(link, false); }, 300); return; }
    link.secret = secret;
    link.name = String(msg.name || 'Device').slice(0, 40);
    sendCtl(link, { t: 'welcome', name: store.name, mac: await hmac(secret, 'answer|' + fp.remote + '|' + fp.local) });
    if (msg.mode === 'pair') { pairing = null; rememberPeer(link); $('pairCard').hidden = true; }
    else known(link.id).name = link.name;
    connected(link);
  }

  async function onWelcome(link, msg) {
    var fp = fingerprints(link);
    var ok = msg.mac === await hmac(link.secret, 'answer|' + fp.local + '|' + fp.remote);
    if (!ok) {
      if (pendingPair && pendingPair.id === link.id) { pairStatus('That device could not prove it is the one you scanned. Pairing was stopped.', 'bad'); pendingPair = null; }
      dropLink(link, false);
      return;
    }
    link.name = String(msg.name || link.name || 'Device').slice(0, 40);
    if (link.mode === 'pair') {
      rememberPeer(link);
      pendingPair = null;
      pairStatus('Paired with ' + link.name + '.', 'good');
      $('pairCard').hidden = true;
    } else if (known(link.id)) known(link.id).name = link.name;
    connected(link);
  }

  function rememberPeer(link) {
    store.peers = store.peers.filter(function (p) { return p.id !== link.id; });
    store.peers.push({ id: link.id, name: link.name, secret: link.secret });
    save();
  }

  function connected(link) {
    clearTimeout(link.timer);
    link.state = 'connected';
    save();
    render();
  }

  // ---------- messages ----------

  async function onData(link, data) {
    if (typeof data !== 'string') { onChunk(link, data); return; }
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    if (link.state !== 'connected') {
      if (msg.t === 'hello' && link.role === 'answer') await onHello(link, msg);
      else if (msg.t === 'welcome' && link.role === 'dial') await onWelcome(link, msg);
      else if (msg.t === 'reject') {
        if (link.mode === 'known') forget(link.id, 'It no longer recognises this device. Pair again.');
        else if (pendingPair && pendingPair.id === link.id) { pairStatus('That pairing code is no longer valid. Scan the code again.', 'bad'); pendingPair = null; }
        dropLink(link, false);
      }
      return; // nothing else is accepted before the check has passed
    }

    if (msg.t === 'text') addReceived({ kind: 'text', text: String(msg.text || '').slice(0, 100000), from: link.name, time: Date.now() });
    else if (msg.t === 'name') { link.name = String(msg.name || 'Device').slice(0, 40); if (known(link.id)) { known(link.id).name = link.name; save(); } render(); }
    else if (msg.t === 'unpair') forget(link.id, null);
    else if (msg.t === 'file') await startIncoming(link, msg);
    else if (msg.t === 'end') await endIncoming(link, msg);
    else if (msg.t === 'abort') { if (link.incoming && link.incoming.id === msg.id) failIncoming(msg.id, 'Cancelled by ' + link.name); }
    else if (msg.t === 'cancel') { var job = link.queue.filter(function (j) { return j.id === msg.id; })[0]; if (job) { job.cancelled = true; job.note = 'Cancelled by ' + link.name; } }
    else if (msg.t === 'got') { if (link.acks[msg.id]) link.acks[msg.id](!!msg.ok); }
  }

  // ---------- receiving ----------

  var transfers = []; // newest first; both directions
  var received = [];

  async function startIncoming(link, msg) {
    if (link.incoming) failIncoming(link.incoming.id, 'Interrupted');
    var size = Number(msg.size);
    if (!msg.id || !isFinite(size) || size < 0) return;
    var rx = {
      id: String(msg.id), dir: 'in', name: String(msg.name || 'file').replace(/[\\/]/g, '_').slice(0, 200), size: size,
      type: String(msg.type || ''), done: 0, state: 'active', device: link.name, link: link, speed: 0, last: 0,
    };
    link.incoming = rx;
    transfers.unshift(rx);
    rx.kind = await sink.open(rx.id);
    if (rx.kind === 'memory' && size > 300 * 1024 * 1024) rx.warn = 'This browser has to hold the file in memory, so very large files may not fit.';
    render();
  }

  function onChunk(link, buf) {
    var rx = link.incoming;
    if (!rx || rx.state !== 'active') return;
    var bytes = buf.byteLength !== undefined ? buf.byteLength : buf.size;
    rx.done += bytes;
    if (rx.done > rx.size) { failIncoming(rx.id, 'More data arrived than expected'); sendCtl(link, { t: 'cancel', id: rx.id }); return; }
    sink.write(rx.kind, rx.id, buf);
  }

  async function endIncoming(link, msg) {
    var rx = link.incoming;
    if (!rx || rx.id !== msg.id || rx.state !== 'active') return;
    link.incoming = null;
    if (rx.done !== rx.size) { rx.state = 'failed'; rx.note = 'The file arrived incomplete'; sink.remove(rx.kind, rx.id); sendCtl(link, { t: 'got', id: rx.id, ok: false }); render(); return; }
    try {
      var file = await sink.close(rx.kind, rx.id, rx.name, rx.type);
      rx.state = 'done';
      addReceived({ kind: 'file', id: rx.id, store: rx.kind, name: rx.name, size: rx.size, file: file, from: rx.device, time: Date.now() });
      sendCtl(link, { t: 'got', id: rx.id, ok: true });
    } catch (e) {
      rx.state = 'failed'; rx.note = 'Could not store the file';
      sendCtl(link, { t: 'got', id: rx.id, ok: false });
    }
    render();
  }

  function failIncoming(id, why) {
    var rx = transfers.filter(function (t) { return t.id === id && t.dir === 'in'; })[0];
    if (!rx || rx.state !== 'active') return;
    rx.state = 'failed'; rx.note = why;
    if (rx.link && rx.link.incoming === rx) { rx.link.incoming = null; if (rx.link.state === 'connected') sendCtl(rx.link, { t: 'cancel', id: id }); }
    sink.remove(rx.kind, id);
    render();
  }

  function addReceived(item) { received.unshift(item); render(); }

  // ---------- sending ----------

  function currentTarget() {
    var up = Object.keys(links).map(function (id) { return links[id]; }).filter(function (l) { return l.state === 'connected'; });
    if (!up.length) return null;
    var chosen = $('target').value;
    return up.filter(function (l) { return l.id === chosen; })[0] || up[0];
  }

  function queueFiles(files) {
    var link = currentTarget();
    if (!link) return sendStatus('No device is connected yet.', 'bad');
    Array.prototype.forEach.call(files, function (file) {
      var job = { id: randomHex(8), dir: 'out', file: file, name: file.name, size: file.size, done: 0, state: 'waiting', device: link.name, link: link, speed: 0, last: 0 };
      link.queue.push(job);
      transfers.unshift(job);
    });
    sendStatus('', '');
    render();
    pump(link);
  }

  async function pump(link) {
    if (link.sending) return;
    link.sending = true;
    while (link.queue.length && link.state === 'connected') {
      var job = link.queue[0];
      if (job.state === 'waiting') {
        try { await sendFile(link, job); job.state = 'done'; job.done = job.size; }
        catch (e) { job.state = job.cancelled ? 'cancelled' : 'failed'; if (!job.note) job.note = job.cancelled ? 'Cancelled' : (e && e.message) || 'Failed'; }
      }
      link.queue.shift();
      render();
    }
    link.sending = false;
  }

  function roomToSend(dc) {
    if (dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise(function (resolve) {
      var timer = setInterval(check, 200);
      function check() { if (dc.readyState !== 'open' || dc.bufferedAmount <= LOW_WATER) done(); }
      function done() { clearInterval(timer); dc.removeEventListener('bufferedamountlow', done); resolve(); }
      dc.addEventListener('bufferedamountlow', done);
    });
  }

  async function sendFile(link, job) {
    var dc = link.conn.dataChannel;
    dc.bufferedAmountLowThreshold = LOW_WATER;
    job.state = 'sending';
    sendCtl(link, { t: 'file', id: job.id, name: job.name, size: job.size, type: job.file.type });
    var off = 0;
    while (off < job.size) {
      if (job.cancelled) { sendCtl(link, { t: 'abort', id: job.id }); throw new Error('Cancelled'); }
      if (link.state !== 'connected' || dc.readyState !== 'open') throw new Error('Connection lost');
      var buf = await job.file.slice(off, off + READ).arrayBuffer();
      for (var p = 0; p < buf.byteLength; p += CHUNK) {
        await roomToSend(dc);
        if (dc.readyState !== 'open') throw new Error('Connection lost');
        if (job.cancelled) { sendCtl(link, { t: 'abort', id: job.id }); throw new Error('Cancelled'); }
        dc.send(buf.slice(p, p + CHUNK));
      }
      off += buf.byteLength;
      job.done = Math.max(0, off - dc.bufferedAmount); // what has actually left this device
    }
    job.state = 'finishing';
    sendCtl(link, { t: 'end', id: job.id });
    var ok = await new Promise(function (resolve) { link.acks[job.id] = resolve; });
    delete link.acks[job.id];
    if (!ok) throw new Error(job.cancelled ? 'Cancelled' : 'The other device could not store the file');
  }

  function cancel(t) {
    if (t.dir === 'out') {
      t.cancelled = true;
      if (t.state === 'waiting') { t.state = 'cancelled'; t.note = 'Cancelled'; }
      if (t.link && t.link.acks[t.id]) t.link.acks[t.id](false);
    } else {
      failIncoming(t.id, 'Cancelled');
    }
    render();
  }

  function sendText() {
    var link = currentTarget();
    var text = $('text').value.trim();
    if (!link) return sendStatus('No device is connected yet.', 'bad');
    if (!text) return sendStatus('Type or paste something first.', 'bad');
    sendCtl(link, { t: 'text', text: text });
    $('text').value = '';
    sendStatus('Text sent to ' + link.name + '.', 'good');
  }

  // ---------- pairing ----------

  function pairStatus(text, cls) { var s = $('pairStatus'); s.textContent = text; s.className = 'status' + (cls ? ' ' + cls : ''); }
  function sendStatus(text, cls) { var s = $('sendStatus'); s.textContent = text; s.className = 'status' + (cls ? ' ' + cls : ''); }

  function pairLink() {
    if (!pairing || Date.now() >= pairing.expires) pairing = { secret: randomHex(16), expires: Date.now() + PAIR_TTL };
    return location.origin + location.pathname + '#p=' + store.id + '&s=' + pairing.secret + '&n=' + encodeURIComponent(store.name);
  }

  var shownLink = '';
  function renderPairCard() {
    if ($('pairCard').hidden) return;
    var link = pairLink();
    if (link !== shownLink) {
      shownLink = link;
      $('pairLink').value = link;
      QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }, function (err, svg) {
        if (!err) $('qr').innerHTML = svg; // markup generated by the QR library from our own link
      });
    }
    var mins = Math.max(1, Math.ceil((pairing.expires - Date.now()) / 60000));
    $('pairExpiry').textContent = 'This code works once and changes in ' + mins + (mins === 1 ? ' minute.' : ' minutes.');
  }

  function usePairLink(text) {
    var hash = String(text || '').split('#')[1] || '';
    var q = new URLSearchParams(hash);
    var id = q.get('p'), secret = q.get('s');
    if (!/^lb-[0-9a-f]{32}$/.test(id || '') || !/^[0-9a-f]{32}$/.test(secret || '')) return false;
    if (id === store.id) { showPair(); pairStatus('That is this device\'s own code. Open it on the other device.', 'bad'); return true; }
    pendingPair = { id: id, secret: secret, name: (q.get('n') || 'Device').slice(0, 40) };
    showPair();
    pairStatus('Connecting to ' + pendingPair.name + '…', '');
    if (online) dial(pendingPair, secret, 'pair');
    return true;
  }

  function showPair() { $('pairCard').hidden = false; shownLink = ''; renderPairCard(); }

  function forget(id, message) {
    var link = links[id];
    store.peers = store.peers.filter(function (p) { return p.id !== id; });
    save();
    if (link) dropLink(link, false);
    if (message) banner(message);
    render();
  }

  // ---------- drawing ----------

  function renderDevices() {
    var ul = $('devices');
    ul.innerHTML = '';
    store.peers.forEach(function (p) {
      var link = links[p.id];
      var li = el('li');
      li.appendChild(el('span', 'avatar', initials(p.name)));
      li.appendChild(el('span', 'dname', p.name));
      var on = link && link.state === 'connected';
      li.appendChild(el('span', 'dstate' + (on ? ' on' : ''), on ? 'Connected' : link ? 'Connecting…' : 'Not open on that device'));
      var rm = el('button', 'link danger', 'Remove');
      rm.type = 'button';
      rm.onclick = function () {
        if (!confirm('Remove "' + p.name + '"? You will have to pair it again to connect.')) return;
        if (links[p.id] && links[p.id].state === 'connected') sendCtl(links[p.id], { t: 'unpair' });
        setTimeout(function () { forget(p.id, null); }, 150);
      };
      li.appendChild(rm);
      ul.appendChild(li);
    });
    $('noDevices').hidden = store.peers.length > 0;
    if (!store.peers.length && $('pairCard').hidden && !pendingPair) showPair();
  }

  function renderTarget() {
    var up = Object.keys(links).map(function (id) { return links[id]; }).filter(function (l) { return l.state === 'connected'; });
    var sel = $('target'), keep = sel.value;
    sel.innerHTML = '';
    up.forEach(function (l) { var o = el('option', null, l.name); o.value = l.id; sel.appendChild(o); });
    if (up.some(function (l) { return l.id === keep; })) sel.value = keep;
    sel.hidden = up.length < 2;
    $('sendTitle').textContent = up.length === 1 ? 'Send to ' + up[0].name : 'Send';
    $('sendCard').classList.toggle('disabled', !up.length);
    if (!up.length) sendStatus(store.peers.length ? 'Open LocalBeam on your paired device to connect.' : 'Pair a device to start sending.', '');
    else if ($('sendStatus').textContent.indexOf('Open LocalBeam') === 0 || $('sendStatus').textContent.indexOf('Pair a device') === 0) sendStatus('', '');
  }

  var rows = {};
  function renderTransfers() {
    var ul = $('progress');
    var live = {};
    transfers.forEach(function (t, index) {
      live[t.id] = true;
      var r = rows[t.id];
      if (!r) {
        r = { li: el('li'), line: el('div', 'line'), sub: el('div', 'sub'), fill: el('i'), foot: el('div', 'foot') };
        var bar = el('div', 'bar'); bar.appendChild(r.fill);
        [r.line, r.sub, bar, r.foot].forEach(function (n) { r.li.appendChild(n); });
        r.line.appendChild(el('b', null, t.name));
        rows[t.id] = r;
      }
      if (ul.children[index] !== r.li) ul.insertBefore(r.li, ul.children[index] || null);
      var pct = t.size ? Math.min(100, Math.floor(t.done / t.size * 100)) : (t.state === 'done' ? 100 : 0);
      var active = t.state === 'active' || t.state === 'sending' || t.state === 'waiting' || t.state === 'finishing';
      r.sub.textContent = (t.dir === 'in' ? 'From ' : 'To ') + t.device + ' · ' + fmtSize(t.size) +
        (active && t.state !== 'waiting' ? ' · ' + pct + '%' + (t.speed > 0 ? ' · ' + fmtSize(t.speed) + '/s' : '') : '') +
        (t.warn && active ? ' · ' + t.warn : '');
      r.fill.style.width = (t.state === 'done' ? 100 : pct) + '%';
      r.li.className = t.state === 'done' ? 'done' : (t.state === 'failed' || t.state === 'cancelled') ? 'failed' : '';
      if (r.state !== t.state) {
        r.state = t.state;
        r.foot.innerHTML = '';
        if (active) {
          r.foot.appendChild(el('span', 'sub', t.state === 'waiting' ? 'Waiting' : t.state === 'finishing' ? 'Finishing…' : t.dir === 'in' ? 'Receiving…' : 'Sending…'));
          var c = el('button', 'btn2 quiet', 'Cancel'); c.type = 'button';
          c.onclick = function () { cancel(t); };
          r.foot.appendChild(c);
        } else if (t.state === 'done') {
          r.foot.appendChild(el('span', 'ok', t.dir === 'in' ? '✓ Received' : '✓ Sent'));
        } else {
          r.foot.appendChild(el('span', 'err', t.note || (t.state === 'cancelled' ? 'Cancelled' : 'Failed')));
        }
      }
    });
    Object.keys(rows).forEach(function (id) { if (!live[id]) { rows[id].li.remove(); delete rows[id]; } });
    $('progressCard').hidden = !transfers.length;
  }

  var receivedShown = -1;
  function renderReceived() {
    if (received.length === receivedShown) return;
    receivedShown = received.length;
    var ul = $('received');
    ul.innerHTML = '';
    received.forEach(function (item) {
      var li = el('li');
      var acts = el('div', 'acts');
      if (item.kind === 'text') {
        var note = el('div', 'note'); linkify(note, item.text);
        li.appendChild(note);
        li.appendChild(el('div', 'sub', 'From ' + item.from + ' · ' + fmtTime(item.time)));
        var copy = el('button', 'btn2', 'Copy'); copy.type = 'button';
        copy.onclick = function () {
          navigator.clipboard.writeText(item.text).then(function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); });
        };
        acts.appendChild(copy);
      } else {
        var line = el('div', 'line'); line.appendChild(el('b', null, item.name));
        li.appendChild(line);
        li.appendChild(el('div', 'sub', fmtSize(item.size) + ' · from ' + item.from + ' · ' + fmtTime(item.time)));
        var saveLink = el('a', 'btn2', 'Save');
        saveLink.href = item.url || (item.url = URL.createObjectURL(item.file));
        saveLink.download = item.name;
        acts.appendChild(saveLink);
        var shareable = false;
        try { shareable = !!navigator.canShare && navigator.canShare({ files: [item.file] }); } catch (e) { shareable = false; }
        if (shareable) {
          var share = el('button', 'btn2', 'Share…'); share.type = 'button';
          share.title = 'For example Save to Photos';
          share.onclick = function () { navigator.share({ files: [item.file] }).catch(function () { /* closed */ }); };
          acts.appendChild(share);
        }
      }
      var rm = el('button', 'btn2 quiet', 'Remove'); rm.type = 'button';
      rm.onclick = function () {
        received = received.filter(function (x) { return x !== item; });
        if (item.url) URL.revokeObjectURL(item.url);
        if (item.kind === 'file') sink.remove(item.store, item.id);
        render();
      };
      acts.appendChild(rm);
      li.appendChild(acts);
      ul.appendChild(li);
    });
    $('noReceived').hidden = received.length > 0;
  }

  function render() {
    refreshPill();
    renderDevices();
    renderTarget();
    renderPairCard();
    renderTransfers();
    renderReceived();
  }

  // Speeds, the countdown on the pairing code, and keeping the screen awake while files move.
  var wakeLock = null;
  setInterval(function () {
    var busy = false;
    transfers.forEach(function (t) {
      var active = t.state === 'active' || t.state === 'sending' || t.state === 'finishing';
      var delta = Math.max(0, t.done - t.last);
      t.last = t.done;
      t.speed = active ? Math.round(t.speed * 0.5 + delta * 0.5) : 0;
      if (active || t.state === 'waiting') busy = true;
    });
    if (busy && !wakeLock && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () { /* not allowed */ });
    if (!busy && wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    renderTransfers();
    renderPairCard();
  }, 1000);

  // ---------- wiring ----------

  $('myName').value = store.name;
  $('myName').onchange = function () {
    var name = $('myName').value.trim().slice(0, 40);
    if (!name) { $('myName').value = store.name; return; }
    store.name = name; save(); shownLink = '';
    Object.keys(links).forEach(function (id) { if (links[id].state === 'connected') sendCtl(links[id], { t: 'name', name: name }); });
    renderPairCard();
  };
  $('addBtn').onclick = function () { pairStatus('', ''); showPair(); $('pairCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('closePair').onclick = function () { $('pairCard').hidden = true; };
  $('copyLink').onclick = function () {
    navigator.clipboard.writeText($('pairLink').value).then(function () {
      $('copyLink').textContent = 'Copied'; setTimeout(function () { $('copyLink').textContent = 'Copy link'; }, 1500);
    }, function () { $('pairLink').select(); });
  };
  $('useLink').onclick = function () {
    if (!usePairLink($('pasteLink').value)) pairStatus('That does not look like a LocalBeam pairing link.', 'bad');
    else $('pasteLink').value = '';
  };

  var drop = $('drop');
  drop.onclick = function () { $('file').click(); };
  drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); queueFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  $('file').onchange = function () { queueFiles($('file').files); $('file').value = ''; };
  $('sendText').onclick = sendText;

  window.addEventListener('beforeunload', function (e) {
    var busy = transfers.some(function (t) { return t.state === 'active' || t.state === 'sending' || t.state === 'waiting' || t.state === 'finishing'; });
    var unsaved = received.some(function (r) { return r.kind === 'file'; });
    if (busy || unsaved) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && peer && !peer.destroyed && peer.disconnected) peer.reconnect();
  });

  // A pairing code in the address (from scanning the QR code): act on it, then tidy the address bar.
  var arrivedWithCode = location.hash.indexOf('p=') >= 0 && usePairLink(location.href);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  // Used by automated tests to inspect what happened.
  window.localbeamDebug = function () {
    return {
      id: store.id, online: online, peers: store.peers.map(function (p) { return p.name; }),
      links: Object.keys(links).map(function (id) { return { name: links[id].name, state: links[id].state }; }),
      transfers: transfers.map(function (t) { return { name: t.name, dir: t.dir, state: t.state, done: t.done, size: t.size, note: t.note || '' }; }),
      received: received.map(function (r) { return r.kind === 'text' ? { kind: 'text', text: r.text } : { kind: 'file', name: r.name, size: r.size, store: r.store }; }),
      pairLink: $('pairCard').hidden ? null : $('pairLink').value,
      arrivedWithCode: arrivedWithCode,
    };
  };
  window.localbeamReceivedFile = function (name) {
    var item = received.filter(function (r) { return r.kind === 'file' && r.name === name; })[0];
    return item ? item.file : null;
  };

  render();
  startPeer();
})();
