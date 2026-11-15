'use strict';
// The only thing the screens get from the desktop shell: where a dropped file lives on disk,
// so it can be sent from its own location instead of being copied first.

const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('localbeam', {
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});
