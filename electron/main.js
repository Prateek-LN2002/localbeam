'use strict';
// LocalBeam desktop app: starts the engine and shows the computer's screens in a window.

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');
const { startEngine } = require('../src/engine');

let win = null;
let engine = null;

// Starting at login is something Windows and macOS offer; Linux desktops each do it differently.
const canAutoStart = process.platform === 'win32' || process.platform === 'darwin';

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'LocalBeam',
    backgroundColor: '#F4F5F7',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'src', 'ui', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(engine.uiUrl);

  // Links (for example in received text) open in the normal browser, never inside the app window.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(engine.uiUrl)) { event.preventDefault(); external(url); }
  });
  win.on('closed', () => { win = null; });
}

async function start() {
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('app.localbeam.desktop');
  try {
    engine = await startEngine({
      dataDir: app.getPath('userData'),
      shell: true,
      log: (m) => console.log(m),
      hooks: {
        openPath: (p) => { shell.openPath(p); },
        showItem: (p) => { shell.showItemInFolder(p); },
        pickFiles: async () => {
          const r = await dialog.showOpenDialog(win, {
            title: 'Choose files to send',
            properties: ['openFile', 'multiSelections'],
          });
          return r.canceled ? [] : r.filePaths;
        },
        pickFolder: async () => {
          const r = await dialog.showOpenDialog(win, {
            title: 'Save received files to',
            properties: ['openDirectory', 'createDirectory'],
          });
          return r.canceled ? null : r.filePaths[0];
        },
        getAutoStart: () => (canAutoStart ? app.getLoginItemSettings().openAtLogin : null),
        setAutoStart: (on) => { if (canAutoStart) app.setLoginItemSettings({ openAtLogin: !!on }); },
      },
    });
  } catch (err) {
    dialog.showErrorBox('LocalBeam could not start', String((err && err.message) || err));
    app.quit();
    return;
  }
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: the first copy shows its window instead
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(start);
  app.on('activate', () => { if (!win && engine) createWindow(); });
  app.on('window-all-closed', () => {
    if (engine) engine.stop();
    app.quit();
  });
}
