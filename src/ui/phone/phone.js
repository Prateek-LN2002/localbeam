(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var IMAGE = /\.(jpe?g|png|gif|webp|heic)$/i;
  var chunkSize = 16 * 1024 * 1024;

  // ---------- pairing token ----------
  // It arrives once in the address (?d=...). We remember it, then tidy the address bar.
  var token = null;
  try { token = new URLSearchParams(location.search).get('d'); } catch (e) { /* very old browser */ }
  try {
    if (token) localStorage.setItem('lb-token', token);
    else token = localStorage.getItem('lb-token');
  } catch (e) { /* storage blocked: the cookie still identifies this device */ }
  if (token) {
    $('manifest').href = '/manifest.webmanifest?d=' + encodeURIComponent(token);
    if (location.search) history.replaceState(null, '', '/app');
  }
  var tokenQuery = token ? '&d=' + encodeURIComponent(token) : '';
  function headers(extra) {
    var h = extra || {};
    if (token) h['X-Device-Token'] = token;
    return h;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmtSize(b) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(1) : b) + ' ' + u[i];
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function call(method, path, body) {
    var opts = { method: method, headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var r = await fetch(path, opts);
    var data = null;
    try { data = await r.json(); } catch (e) { /* plain-text reply */ }
    if (!r.ok) {
      var err = new Error('HTTP ' + r.status);
      err.status = r.status; err.body = data;
      throw err;
    }
    return data;
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

  function copyText(text, btn) {
    function done() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }
    function fallback() {
      var ta = el('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
      document.body.appendChild(ta);
      ta.focus(); ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* not allowed */ }
      document.body.removeChild(ta);
      if (ok) done(); else btn.textContent = 'Hold the text to copy';
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // ---------- tabs ----------
  var currentTab = 'send';
  var inboxKey = '', inboxSeenKey = '';
  function showTab(name) {
    currentTab = name;
    ['send', 'inbox', 'progress'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    if (name === 'inbox') inboxSeenKey = inboxKey;
    paintDots();
    window.scrollTo(0, 0);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.onclick = function () { showTab(b.dataset.tab); };
  });

  function activeJobs() {
    return jobs.filter(function (j) { return j.state === 'waiting' || j.state === 'sending' || j.state === 'reconnecting'; }).length;
  }
  function paintDots() {
    $('inboxDot').hidden = currentTab === 'inbox' || !inboxKey || inboxKey === inboxSeenKey;
    $('progressDot').hidden = currentTab === 'progress' || !activeJobs();
  }

  // ---------- connection + "From computer" ----------
  function setConn(ok, name) {
    var c = $('conn');
    c.className = 'conn' + (ok ? '' : ' bad');
    c.textContent = ok ? 'Connected to ' + name : 'Cannot reach the computer. Retrying…';
  }

  var ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  var ICON_IMG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m4 17 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/></svg>';
  var ICON_LINK = '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function actionLink(label, href, download) {
    var a = el('a', 'btn2', label);
    a.href = href;
    if (download) a.setAttribute('download', '');
    else a.target = '_blank';
    return a;
  }

  function renderInbox(s) {
    var key = JSON.stringify([s.files, s.notes]);
    var empty = !s.files.length && !s.notes.length;
    if (key === inboxKey) return;
    inboxKey = empty ? '' : key;
    if (currentTab === 'inbox') inboxSeenKey = inboxKey;
    var ul = $('inbox');
    ul.innerHTML = '';
    s.notes.forEach(function (n) {
      var li = el('li');
      var item = el('div', 'item');
      var icon = el('span', 'ficon txt'); icon.innerHTML = ICON_LINK;
      var meta = el('div', 'meta');
      var text = el('div', 'ftext'); linkify(text, n.text);
      meta.appendChild(text);
      item.appendChild(icon); item.appendChild(meta);
      var acts = el('div', 'acts');
      var copy = el('button', 'btn2', 'Copy'); copy.type = 'button';
      copy.onclick = function () { copyText(n.text, copy); };
      acts.appendChild(copy);
      li.appendChild(item); li.appendChild(acts);
      ul.appendChild(li);
    });
    s.files.forEach(function (f) {
      var isImg = IMAGE.test(f.name);
      var li = el('li');
      var item = el('div', 'item');
      var icon = el('span', 'ficon' + (isImg ? ' img' : '')); icon.innerHTML = isImg ? ICON_IMG : ICON_FILE;
      var meta = el('div', 'meta');
      meta.appendChild(el('div', 'fname', f.name));
      meta.appendChild(el('div', 'fsize', fmtSize(f.size)));
      item.appendChild(icon); item.appendChild(meta);
      var href = '/d/file?id=' + encodeURIComponent(f.id) + tokenQuery;
      var acts = el('div', 'acts');
      if (isImg) acts.appendChild(actionLink('View', href + '&view=1', false));
      acts.appendChild(actionLink('Download', href, true));
      li.appendChild(item); li.appendChild(acts);
      ul.appendChild(li);
    });
    $('inboxEmpty').hidden = !empty;
    $('inboxTip').hidden = !s.files.length;
    paintDots();
  }

  async function poll() {
    try {
      var r = await fetch('/d/state', { headers: headers(), cache: 'no-store' });
      if (r.status === 401) { $('unpaired').hidden = false; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var s = await r.json();
      if (s.chunk) chunkSize = s.chunk;
      $('unpaired').hidden = true;
      setConn(true, s.computer.name);
      renderInbox(s);
    } catch (e) { setConn(false); }
  }

  // ---------- sending files (in chunks, resumable) ----------
  var jobs = [];
  var running = false;
  var wakeLock = null;

  function paint(job) {
    var size = job.file.size;
    var pct = size ? Math.min(100, Math.floor(job.sent / size * 100)) : (job.state === 'done' ? 100 : 0);
    job.line.innerHTML = '';
    job.line.appendChild(el('b', null, job.file.name));
    var tail = ' · ' + fmtSize(size);
    if (job.state === 'sending' || job.state === 'reconnecting') {
      tail += ' · ' + pct + '%';
      if (job.state === 'sending' && job.speed > 0) tail += ' · ' + fmtSize(job.speed) + '/s';
    }
    job.line.appendChild(document.createTextNode(tail));
    job.fill.style.width = (job.state === 'done' ? 100 : pct) + '%';
    job.li.className = job.state === 'done' ? 'done' : job.state === 'failed' ? 'failed' : '';

    if (job.painted === job.state) return;
    job.painted = job.state;
    job.foot.innerHTML = '';
    var label = {
      waiting: ['dim', 'Waiting'], sending: ['dim', 'Sending…'], reconnecting: ['err', 'Connection lost. Retrying…'],
      done: ['ok', '✓ Sent'], failed: ['err', 'Failed'], cancelled: ['dim', job.note || 'Cancelled'],
    }[job.state];
    job.foot.appendChild(el('span', label[0], label[1]));
    if (job.state === 'waiting' || job.state === 'sending' || job.state === 'reconnecting') {
      var c = el('button', 'btn2', 'Cancel'); c.type = 'button';
      c.onclick = function () { cancelJob(job); };
      job.foot.appendChild(c);
    } else if (job.state === 'failed' || job.state === 'cancelled') {
      var r = el('button', 'btn2 quiet', 'Try again'); r.type = 'button';
      r.onclick = function () { job.cancelled = false; job.note = ''; job.state = 'waiting'; paint(job); afterChange(); pump(); };
      job.foot.appendChild(r);
    }
  }

  function afterChange() {
    var n = activeJobs();
    $('keep').hidden = !n;
    $('uploadsEmpty').hidden = jobs.length > 0;
    paintDots();
    if (n && !wakeLock && navigator.wakeLock) {
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () { /* not allowed */ });
    } else if (!n && wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }

  function addJob(file) {
    var li = el('li');
    var job = {
      file: file, li: li, line: el('div', 'pline'), fill: el('i'), foot: el('div', 'pstate'),
      state: 'waiting', sent: 0, speed: 0, lastSent: 0, cancelled: false, id: null, xhr: null, note: '',
    };
    var bar = el('div', 'bar'); bar.appendChild(job.fill);
    li.appendChild(job.line); li.appendChild(bar); li.appendChild(job.foot);
    $('uploads').prepend(li);
    jobs.push(job);
    paint(job);
  }

  function cancelJob(job) {
    job.cancelled = true;
    if (job.state === 'waiting') { job.state = 'cancelled'; paint(job); afterChange(); return; }
    if (job.xhr) job.xhr.abort();
    if (job.id) call('DELETE', '/d/upload?id=' + job.id).catch(function () {});
  }

  function putChunk(job, start, end) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      job.xhr = xhr;
      xhr.open('PUT', '/d/upload/chunk?id=' + job.id + '&offset=' + start);
      if (token) xhr.setRequestHeader('X-Device-Token', token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = function (e) { job.sent = start + e.loaded; paint(job); };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* plain-text reply */ }
        if (xhr.status === 200 && data) return resolve(data);
        var err = new Error('HTTP ' + xhr.status);
        err.status = xhr.status; err.body = data;
        reject(err);
      };
      xhr.onerror = xhr.onabort = xhr.ontimeout = function () {
        var err = new Error('network'); err.status = 0; reject(err);
      };
      xhr.send(job.file.slice(start, end));
    });
  }

  function startInfo(job) {
    return call('POST', '/d/upload/start', { name: job.file.name, size: job.file.size, lastModified: job.file.lastModified || 0 });
  }

  async function runJob(job) {
    job.state = 'sending';
    paint(job);
    var fails = 0;
    try {
      var info = await startInfo(job);
      job.id = info.id; job.sent = info.offset; job.lastSent = info.offset;
      for (;;) {
        if (job.cancelled) throw new Error('cancelled');
        if (job.sent >= job.file.size) {
          try { await call('POST', '/d/upload/finish?id=' + job.id); break; } catch (e) {
            if (e.status === 409 && e.body && typeof e.body.offset === 'number') { job.sent = e.body.offset; continue; }
            throw e;
          }
        }
        var start = job.sent;
        try {
          var r = await putChunk(job, start, Math.min(start + chunkSize, job.file.size));
          job.sent = r.offset;
          fails = 0;
          job.state = 'sending';
        } catch (e) {
          if (job.cancelled) throw e;
          if (e.status === 410) { job.note = 'Cancelled on the computer'; job.cancelled = true; throw e; }
          if (e.status === 401) { $('unpaired').hidden = false; throw e; }
          if (e.status === 400 || e.status === 413) throw e;
          if (e.status === 409 && e.body && typeof e.body.offset === 'number') { job.sent = e.body.offset; continue; }
          // Connection dropped, or the computer restarted: wait, ask where to continue from, and carry on.
          if (++fails > 40) throw e;
          job.state = 'reconnecting';
          paint(job);
          await sleep(Math.min(1000 * fails, 5000));
          try {
            info = await startInfo(job);
            job.id = info.id; job.sent = info.offset;
          } catch (e2) {
            if (e2.status === 401) { $('unpaired').hidden = false; throw e2; }
          }
        }
        paint(job);
      }
      job.sent = job.file.size;
      job.state = 'done';
    } catch (e) {
      job.state = job.cancelled ? 'cancelled' : 'failed';
    }
    job.xhr = null;
    paint(job);
  }

  async function pump() {
    if (running) return;
    running = true;
    for (;;) {
      var job = jobs.filter(function (j) { return j.state === 'waiting'; })[0];
      if (!job) break;
      afterChange();
      await runJob(job);
      afterChange();
    }
    running = false;
    afterChange();
  }

  setInterval(function () {
    jobs.forEach(function (j) {
      if (j.state !== 'sending') { j.speed = 0; j.lastSent = j.sent; return; }
      var delta = Math.max(0, j.sent - j.lastSent);
      j.lastSent = j.sent;
      j.speed = Math.round(j.speed * 0.5 + delta * 0.5);
      paint(j);
    });
  }, 1000);

  $('file').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    files.forEach(addJob);
    showTab('progress');
    afterChange();
    pump();
  });

  window.addEventListener('beforeunload', function (e) {
    if (activeJobs()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- sending text ----------
  var msgBox = $('msg'), msgBtn = $('sendMsg'), msgState = $('msgState');
  function setMsg(cls, text) { msgState.className = 'msgstate' + (cls ? ' ' + cls : ''); msgState.textContent = text; }
  msgBox.addEventListener('input', function () { setMsg('', ''); });
  msgBtn.addEventListener('click', async function () {
    var text = msgBox.value.trim();
    if (!text) return setMsg('err', 'Type or paste something first');
    msgBtn.disabled = true;
    setMsg('', 'Sending…');
    try {
      var r = await fetch('/d/text', { method: 'POST', headers: headers({ 'Content-Type': 'text/plain; charset=utf-8' }), body: text });
      if (r.ok) { msgBox.value = ''; setMsg('ok', '✓ Sent'); }
      else if (r.status === 401) { $('unpaired').hidden = false; setMsg('err', 'This device is not paired'); }
      else setMsg('err', 'Could not send. Try again.');
    } catch (e) { setMsg('err', 'Cannot reach the computer'); }
    msgBtn.disabled = false;
  });

  // ---------- Home Screen tip ----------
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var helpHidden = false;
  try { helpHidden = localStorage.getItem('lb-help-hidden') === '1'; } catch (e) { /* storage blocked */ }
  var inApp = /LocalBeamApp/i.test(navigator.userAgent); // the native phone apps show these pages inside themselves
  if (!standalone && !helpHidden && !inApp && /iPhone|iPad|Android/i.test(navigator.userAgent)) $('homeHelp').hidden = false;
  $('homeHelpClose').onclick = function () {
    $('homeHelp').hidden = true;
    try { localStorage.setItem('lb-help-hidden', '1'); } catch (e) { /* storage blocked */ }
  };

  poll();
  setInterval(poll, 3000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
