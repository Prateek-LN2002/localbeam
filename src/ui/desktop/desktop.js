(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var shell = window.localbeam || null; // provided by the desktop app; missing in an ordinary browser
  var state = null;
  var seen = {};
  var selectedIp = null;
  var currentView = 'home';

  // ---------- helpers ----------

  async function api(method, path, body, asText) {
    var opts = { method: method, headers: { 'X-LocalBeam': '1' } };
    if (body !== undefined) {
      opts.body = asText ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = asText ? 'text/plain; charset=utf-8' : 'application/json';
    }
    var r = await fetch(path, opts);
    if (!r.ok) throw new Error((await r.text()) || 'Something went wrong');
    return r.json();
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 6000 : 3000);
  }
  function fail(err) { toast(err.message || String(err), true); }

  function changed(key, value) {
    var s = JSON.stringify(value);
    if (seen[key] === s) return false;
    seen[key] = s;
    return true;
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
  function fmtSpeed(b) { return b > 0 ? fmtSize(b) + '/s' : ''; }
  function fmtTime(t) {
    var d = new Date(t), now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (t >= today) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (t >= today - 86400000) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function lastSeenText(t) {
    var m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'Last seen just now';
    if (m < 60) return 'Last seen ' + m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return 'Last seen ' + h + (h === 1 ? ' hour ago' : ' hours ago');
    if (h < 48) return 'Last seen yesterday';
    return 'Last seen ' + new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function initials(name) {
    var words = String(name).trim().split(/\s+/);
    var s = words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 2);
    return s.toUpperCase();
  }

  // Plain text with clickable links, built from DOM nodes so pasted text can never inject markup.
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

  // ---------- navigation ----------

  function show(view) {
    if (!$('view-' + view)) view = 'home';
    currentView = view;
    ['home', 'transfer', 'received', 'settings'].forEach(function (v) { $('view-' + v).hidden = v !== view; });
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      a.classList.toggle('on', a.dataset.view === view);
    });
    if (view === 'received') markReceivedSeen();
    renderBadges();
  }
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });

  function receivedSeenAt() {
    try { return Number(localStorage.getItem('lb-received-seen')) || 0; } catch (e) { return 0; }
  }
  function markReceivedSeen() {
    try { localStorage.setItem('lb-received-seen', String(Date.now())); } catch (e) { /* private window */ }
  }

  function renderBadges() {
    if (!state) return;
    var active = state.transfers.filter(function (t) { return t.status === 'active' || t.status === 'waiting'; }).length;
    var tb = $('navTransferBadge');
    tb.hidden = !active; tb.textContent = active;
    var since = receivedSeenAt();
    var fresh = currentView === 'received' ? 0 : state.received.filter(function (r) { return r.time > since; }).length;
    var rb = $('navReceivedBadge');
    rb.hidden = !fresh; rb.textContent = fresh;
    if (currentView === 'received' && state.received.length) markReceivedSeen();
  }

  // ---------- Home ----------

  function deviceRow(d, withRemove) {
    var li = el('li');
    li.appendChild(el('span', 'avatar', initials(d.name)));
    li.appendChild(el('span', 'name', d.name));
    li.appendChild(el('span', 'state' + (d.connected ? ' on' : ''), d.connected ? 'Connected' : lastSeenText(d.lastSeen)));
    if (withRemove) {
      var b = el('button', 'link danger', 'Remove');
      b.onclick = function () {
        if (!confirm('Remove "' + d.name + '"? It will have to be paired again to connect.')) return;
        api('DELETE', '/api/device?id=' + encodeURIComponent(d.id)).then(refresh).catch(fail);
      };
      li.appendChild(b);
    }
    return li;
  }

  function renderHome() {
    var addrs = state.computer.addresses;
    if (changed('addrs', addrs)) {
      var sel = $('addr');
      sel.innerHTML = '';
      addrs.forEach(function (a) {
        var o = el('option', null, a.address + '  (' + a.name + ')');
        o.value = a.address;
        sel.appendChild(o);
      });
      if (!addrs.some(function (a) { return a.address === selectedIp; })) selectedIp = addrs.length ? addrs[0].address : null;
      if (selectedIp) sel.value = selectedIp;
      $('addrWrap').hidden = addrs.length < 2;
      $('noNet').hidden = addrs.length > 0;
    }
    if (changed('qr', [selectedIp, state.pairing.key, state.computer.port])) {
      var img = $('qr');
      if (selectedIp) {
        img.src = '/api/qr.svg?ip=' + encodeURIComponent(selectedIp) + '&k=' + state.pairing.key;
        img.hidden = false;
      } else img.hidden = true;
      $('manualUrl').textContent = selectedIp ? 'https://' + selectedIp + ':' + state.computer.port : '(no network)';
      $('pairCode').textContent = state.pairing.code.slice(0, 3) + ' ' + state.pairing.code.slice(3);
    }
    var devs = state.devices.map(function (d) {
      return { id: d.id, name: d.name, connected: d.connected, bucket: d.connected ? 0 : Math.floor((Date.now() - d.lastSeen) / 60000) };
    });
    if (changed('devices', devs)) {
      var ul = $('devices'), ul2 = $('settingsDevices');
      ul.innerHTML = ''; ul2.innerHTML = '';
      state.devices.forEach(function (d) { ul.appendChild(deviceRow(d, false)); ul2.appendChild(deviceRow(d, true)); });
      $('devicesEmpty').hidden = state.devices.length > 0;
    }
    if (changed('foot', [state.computer.name, selectedIp])) {
      $('sideFoot').textContent = 'This computer: ' + state.computer.name + (selectedIp ? ' · ' + selectedIp : '');
      var pill = $('pill');
      pill.textContent = selectedIp ? 'Encrypted · Same Wi-Fi only' : 'Not connected to a network';
      pill.classList.toggle('off', !selectedIp);
    }
  }

  $('addr').onchange = function () { selectedIp = $('addr').value; seen.qr = seen.foot = null; renderHome(); };

  // ---------- Transfer ----------

  function renderReady() {
    var items = { shares: state.shares, notes: state.notes };
    if (!changed('ready', items)) return;
    var ul = $('ready');
    ul.innerHTML = '';
    state.notes.forEach(function (n) {
      var li = el('li');
      var what = el('span', 'what');
      what.appendChild(el('span', 'tag', 'Text'));
      what.appendChild(document.createTextNode(n.text.length > 120 ? n.text.slice(0, 120) + '…' : n.text));
      var b = el('button', 'link', 'Remove');
      b.onclick = function () { api('DELETE', '/api/note?id=' + n.id).then(refresh).catch(fail); };
      li.appendChild(what); li.appendChild(b);
      ul.appendChild(li);
    });
    state.shares.forEach(function (s) {
      var li = el('li');
      var what = el('span', 'what');
      what.appendChild(el('span', 'tag', 'File'));
      what.appendChild(document.createTextNode(s.name));
      what.appendChild(el('small', s.missing ? 'missing' : null, s.missing ? 'This file was moved or deleted' : fmtSize(s.size)));
      var b = el('button', 'link', 'Remove');
      b.onclick = function () { api('DELETE', '/api/share?id=' + s.id).then(refresh).catch(fail); };
      li.appendChild(what); li.appendChild(b);
      ul.appendChild(li);
    });
    $('readyCard').hidden = !state.notes.length && !state.shares.length;
  }

  var progressRows = {};
  function renderProgress() {
    var ul = $('progress');
    var live = {};
    state.transfers.forEach(function (t, index) {
      live[t.id] = true;
      var row = progressRows[t.id];
      if (!row) {
        var li = el('li');
        row = {
          li: li, what: el('span', 'what'), bar: el('span', 'bar'), fill: el('i'),
          pct: el('span', 'pct'), speed: el('span', 'speed'), end: el('span', 'end'),
        };
        row.bar.appendChild(row.fill);
        [row.what, row.bar, row.pct, row.speed, row.end].forEach(function (n) { li.appendChild(n); });
        progressRows[t.id] = row;
      }
      if (ul.children[index] !== row.li) ul.insertBefore(row.li, ul.children[index] || null);

      var pct = t.size ? Math.min(100, Math.floor(t.done / t.size * 100)) : 100;
      var sig = [t.name, t.device, t.dir, t.size].join('|');
      if (row.sig !== sig) {
        row.sig = sig;
        row.what.textContent = t.name;
        row.what.appendChild(el('small', null, (t.dir === 'in' ? 'From ' : 'To ') + t.device + ' · ' + fmtSize(t.size)));
      }
      var active = t.status === 'active' || t.status === 'waiting';
      row.bar.style.visibility = active ? 'visible' : 'hidden';
      row.fill.style.width = pct + '%';
      row.pct.textContent = active ? pct + '%' : '';
      row.speed.textContent = t.status === 'active' ? fmtSpeed(t.speed) : (t.status === 'waiting' ? 'Waiting…' : '');
      if (row.status !== t.status) {
        row.status = t.status;
        row.end.innerHTML = '';
        if (active) {
          var c = el('button', 'link', 'Cancel');
          c.onclick = function () { api('POST', '/api/transfer-cancel?id=' + encodeURIComponent(t.id)).then(refresh).catch(fail); };
          row.end.appendChild(c);
        } else if (t.status === 'done') {
          row.end.appendChild(el('span', 'ok', t.dir === 'in' ? 'Received' : 'Sent'));
        } else {
          row.end.appendChild(el('span', 'dim', t.status === 'cancelled' ? 'Cancelled' : 'Failed'));
        }
      }
    });
    Object.keys(progressRows).forEach(function (id) {
      if (!live[id]) { progressRows[id].li.remove(); delete progressRows[id]; }
    });
    $('progressEmpty').hidden = state.transfers.length > 0;
  }

  function reportShare(result) {
    var parts = [];
    if (result.added && result.added.length) {
      parts.push('Added ' + (result.added.length === 1 ? result.added[0] : result.added.length + ' files') + '.');
    }
    if (result.skipped && result.skipped.length) {
      parts.push('Skipped ' + result.skipped.join(', ') + ' (folders cannot be sent; zip them first).');
    }
    $('dropStatus').textContent = parts.join(' ');
    refresh();
  }

  // In an ordinary browser we cannot learn where a file lives, so the file is copied into LocalBeam instead.
  function uploadCopies(files) {
    var queue = Array.prototype.slice.call(files);
    (function next() {
      var f = queue.shift();
      if (!f) return;
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/outbox-upload');
      xhr.setRequestHeader('X-LocalBeam', '1');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(f.name));
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) $('dropStatus').textContent = 'Adding ' + f.name + '… ' + Math.round(e.loaded / e.total * 100) + '%';
      };
      xhr.onloadend = function () {
        $('dropStatus').textContent = xhr.status === 200 ? 'Added ' + f.name + '.' : 'Could not add ' + f.name + '.';
        refresh();
        next();
      };
      xhr.send(f);
    })();
  }

  function addFiles(files) {
    if (!files || !files.length) return;
    if (shell && shell.pathForFile) {
      var paths = Array.prototype.map.call(files, function (f) { return shell.pathForFile(f); }).filter(Boolean);
      api('POST', '/api/share-paths', { paths: paths }).then(reportShare).catch(fail);
    } else uploadCopies(files);
  }

  function chooseFiles() {
    if (state && state.settings.canPick) api('POST', '/api/pick-files').then(reportShare).catch(fail);
    else $('filePick').click();
  }

  var drop = $('drop');
  drop.onclick = chooseFiles;
  drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFiles(); } };
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function () { drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { e.preventDefault(); addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  $('filePick').onchange = function () { addFiles($('filePick').files); $('filePick').value = ''; };

  $('outSend').onclick = function () {
    var text = $('outText').value.trim();
    if (!text) return toast('Type or paste something first.', true);
    api('POST', '/api/note', text, true).then(function () {
      $('outText').value = '';
      toast('Text is ready for your devices.');
      refresh();
    }).catch(fail);
  };

  // ---------- Received ----------

  function renderReceived() {
    if (!changed('received', state.received)) return;
    var body = $('received');
    body.innerHTML = '';
    state.received.forEach(function (r) {
      var tr = el('tr');
      var name = el('td', 'n');
      var action = el('td', 'r');
      if (r.type === 'file') {
        var open = el('button', null, r.name);
        open.title = 'Open this file';
        open.onclick = function () { api('POST', '/api/open-item?id=' + r.id).catch(fail); };
        name.appendChild(open);
        var showBtn = el('button', 'link', 'Show');
        showBtn.title = 'Show in folder';
        showBtn.onclick = function () { api('POST', '/api/show-item?id=' + r.id).catch(fail); };
        action.appendChild(showBtn);
      } else {
        var txt = el('span', 'txt');
        linkify(txt, r.text || '');
        name.appendChild(txt);
        var copy = el('button', 'link', 'Copy');
        copy.onclick = function () {
          navigator.clipboard.writeText(r.text || '').then(function () {
            copy.textContent = 'Copied';
            setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
          }).catch(fail);
        };
        action.appendChild(copy);
      }
      tr.appendChild(name);
      tr.appendChild(el('td', 'nowrap', r.type === 'file' ? fmtSize(r.size) : '—'));
      tr.appendChild(el('td', null, r.from));
      tr.appendChild(el('td', 'nowrap', fmtTime(r.time)));
      tr.appendChild(action);
      body.appendChild(tr);
    });
    $('receivedEmpty').hidden = state.received.length > 0;
  }

  $('openFolder').onclick = function () { api('POST', '/api/open-folder').catch(fail); };
  $('clearHistory').onclick = function () {
    if (!state || !state.received.length) return;
    if (!confirm('Clear this list? The received files stay in the folder.')) return;
    api('POST', '/api/clear-history').then(refresh).catch(fail);
  };

  // ---------- Settings ----------

  function renderSettings() {
    var s = state.settings;
    var nameBox = $('deviceName');
    if (document.activeElement !== nameBox && changed('name', s.deviceName)) {
      nameBox.value = s.deviceName;
      $('saveName').hidden = true;
    }
    if (changed('saveDir', s.saveDir)) $('saveDir').textContent = s.saveDir;
    if (changed('fp', s.fingerprint)) $('fingerprint').textContent = s.fingerprint;
    if (changed('auto', s.autoStart)) {
      var box = $('autoStart');
      box.disabled = s.autoStart === null;
      box.checked = s.autoStart === true;
      $('autoNote').hidden = s.autoStart !== null;
    }
  }

  function saveName() {
    var name = $('deviceName').value.trim();
    if (!name) return toast('The name cannot be empty.', true);
    api('POST', '/api/settings', { deviceName: name }).then(function () {
      $('saveName').hidden = true;
      $('deviceName').blur();
      seen.name = null;
      toast('Name saved.');
      refresh();
    }).catch(fail);
  }
  $('deviceName').oninput = function () { $('saveName').hidden = !state || $('deviceName').value.trim() === state.settings.deviceName; };
  $('deviceName').onkeydown = function (e) { if (e.key === 'Enter') saveName(); };
  $('saveName').onclick = saveName;

  $('changeDir').onclick = function () {
    if (state && state.settings.canPick) {
      api('POST', '/api/pick-save-folder').then(refresh).catch(fail);
    } else {
      $('saveDirEdit').hidden = !$('saveDirEdit').hidden;
      $('saveDirInput').value = state ? state.settings.saveDir : '';
    }
  };
  $('saveDirOk').onclick = function () {
    api('POST', '/api/settings', { saveDir: $('saveDirInput').value }).then(function () {
      $('saveDirEdit').hidden = true;
      toast('Folder changed.');
      refresh();
    }).catch(fail);
  };
  $('autoStart').onchange = function () {
    api('POST', '/api/settings', { autoStart: $('autoStart').checked }).then(function () { seen.auto = undefined; refresh(); }).catch(fail);
  };

  // ---------- loop ----------

  var offline = false;
  async function refresh() {
    try {
      var r = await fetch('/api/state');
      state = await r.json();
      if (offline) { offline = false; $('toast').hidden = true; }
      renderHome(); renderReady(); renderProgress(); renderReceived(); renderSettings(); renderBadges();
    } catch (e) {
      if (!offline) { offline = true; toast('LocalBeam has stopped. Start it again to continue.', true); }
    }
  }

  show(location.hash.slice(1) || 'home');
  refresh();
  setInterval(refresh, 1000);
})();
