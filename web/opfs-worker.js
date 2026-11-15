'use strict';
// Writes incoming files straight to the browser's private disk storage, piece by piece,
// so a large file never has to fit in memory. Runs in a worker because the fast, synchronous
// file handle is only available there.

const DIR = 'localbeam-incoming';
const open = new Map(); // id -> { handle, pos }
let dirPromise = null;

function dir() {
  if (!dirPromise) {
    dirPromise = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(DIR, { create: true }));
  }
  return dirPromise;
}

async function handle(m) {
  try {
    if (m.op === 'purge') {
      for (const f of open.values()) { try { f.handle.close(); } catch (e) { /* already closed */ } }
      open.clear();
      try { await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true }); } catch (e) { /* nothing there */ }
      dirPromise = null;
      return;
    }
    if (m.op === 'open') {
      const fileHandle = await (await dir()).getFileHandle(m.id, { create: true });
      const access = await fileHandle.createSyncAccessHandle();
      access.truncate(0);
      open.set(m.id, { handle: access, pos: 0 });
      postMessage({ rid: m.rid });
      return;
    }
    const f = open.get(m.id);
    if (m.op === 'write') {
      if (!f) return;
      const bytes = new Uint8Array(m.buf);
      const written = f.handle.write(bytes, { at: f.pos });
      if (written !== bytes.length) throw new Error('This device ran out of storage space.');
      f.pos += written;
      return;
    }
    if (m.op === 'close') {
      if (f) { f.handle.flush(); f.handle.close(); open.delete(m.id); }
      postMessage({ rid: m.rid, size: f ? f.pos : 0 });
      return;
    }
    if (m.op === 'remove') {
      if (f) { try { f.handle.close(); } catch (e) { /* already closed */ } open.delete(m.id); }
      try { await (await dir()).removeEntry(m.id); } catch (e) { /* already gone */ }
      if (m.rid) postMessage({ rid: m.rid });
    }
  } catch (err) {
    const error = String((err && err.message) || err);
    if (m.rid) postMessage({ rid: m.rid, error: error });
    else postMessage({ op: 'werror', id: m.id, error: error });
  }
}

// One message at a time, in order.
let chain = Promise.resolve();
onmessage = (e) => { chain = chain.then(() => handle(e.data)); };
