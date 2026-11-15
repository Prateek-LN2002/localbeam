'use strict';
// Runs the LocalBeam engine without the desktop window, for development and testing:
//   node src/standalone.js
// Then open http://127.0.0.1:53701 for the computer's screens.

const path = require('path');
const os = require('os');
const { startEngine } = require('./engine');

function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'LocalBeam-dev');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'LocalBeam-dev');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'LocalBeam-dev');
}

// Options: --data=<folder>  --ui-port=<n>  --dev-http=<n> (device pages over plain http on this computer, for testing)
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

startEngine({
  dataDir: arg('data') || process.env.LOCALBEAM_DATA || defaultDataDir(),
  uiPort: Number(arg('ui-port') || process.env.LOCALBEAM_UI_PORT) || 53701,
  devHttpPort: Number(arg('dev-http') || process.env.LOCALBEAM_DEV_HTTP) || 0,
  log: (m) => console.log(m),
}).then((engine) => {
  console.log(`Computer screens: ${engine.uiUrl}`);
  console.log(`Devices connect on https port ${engine.httpsPort}`);
}).catch((err) => {
  console.error('LocalBeam could not start: ' + err.message);
  process.exit(1);
});
