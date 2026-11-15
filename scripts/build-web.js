'use strict';
// Prepares the website's bundled libraries and icons (web/vendor, web/icon-*.png).
// The results are committed, so the site can be served as plain files with no build step.
//   node scripts/build-web.js

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
fs.mkdirSync(path.join(web, 'vendor'), { recursive: true });

// PeerJS: introduces the two browsers to each other (MIT licence).
fs.copyFileSync(path.join(root, 'node_modules/peerjs/dist/peerjs.min.js'), path.join(web, 'vendor/peerjs.min.js'));

// QR code generator (MIT licence), bundled as one file that defines window.QRCode.
esbuild.buildSync({
  entryPoints: [path.join(root, 'node_modules/qrcode/lib/browser.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'QRCode',
  outfile: path.join(web, 'vendor/qrcode.js'),
});

for (const size of [180, 192, 512]) {
  fs.copyFileSync(path.join(root, `src/ui/icons/icon-${size}.png`), path.join(web, `icon-${size}.png`));
}

const licences = [
  'Third-party code in this folder',
  '',
  'peerjs.min.js: PeerJS ' + require(path.join(root, 'node_modules/peerjs/package.json')).version + ', MIT licence, https://github.com/peers/peerjs',
  'qrcode.js: node-qrcode ' + require(path.join(root, 'node_modules/qrcode/package.json')).version + ', MIT licence, https://github.com/soldair/node-qrcode',
  '',
].join('\n');
fs.writeFileSync(path.join(web, 'vendor/THIRD-PARTY.txt'), licences);

for (const f of fs.readdirSync(path.join(web, 'vendor'))) {
  console.log('web/vendor/' + f + '  ' + Math.round(fs.statSync(path.join(web, 'vendor', f)).size / 1024) + ' KB');
}
