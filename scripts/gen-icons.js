'use strict';
// Draws the LocalBeam icon (a dot sending two beams) and writes it as PNG files.
// No image tools needed: the PNG is encoded here with Node's zlib.
//   node scripts/gen-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLUE = [21, 96, 232];
const WHITE = [255, 255, 255];
const SS = 4; // supersampling per axis, for smooth edges

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// opaque = true writes plain RGB with no transparency channel, which Apple requires for app icons.
function encodePng(size, rgba, opaque) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;              // bit depth
  ihdr[9] = opaque ? 2 : 6; // RGB or RGBA
  const bpp = opaque ? 3 : 4;
  const raw = Buffer.alloc((size * bpp + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * bpp + 1);
    raw[rowStart] = 0; // no filter
    if (!opaque) {
      rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    } else {
      for (let x = 0; x < size; x++) rgba.copy(raw, rowStart + 1 + x * 3, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Is the point (x, y in 0..1) inside the rounded square?
function inRoundedSquare(x, y, r) {
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

// Is the point part of the white mark? A dot at lower left, two arcs opening to the upper right.
function inMark(x, y) {
  const cx = 0.3;
  const cy = 0.7;
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= 0.085) return true;
  if (dx < 0 || dy > 0) return false;
  const angle = Math.atan2(-dy, dx); // 0 = right, PI/2 = up
  if (angle < 0.14 || angle > Math.PI / 2 - 0.14) return false;
  return Math.abs(d - 0.25) <= 0.04 || Math.abs(d - 0.43) <= 0.04;
}

function draw(size, rounded, opaque) {
  const rgba = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inside = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (rounded && !inRoundedSquare(x, y, 0.22)) continue;
          inside++;
          if (inMark(x, y)) mark++;
        }
      }
      const i = (py * size + px) * 4;
      const w = inside ? mark / inside : 0;
      rgba[i] = Math.round(BLUE[0] + (WHITE[0] - BLUE[0]) * w);
      rgba[i + 1] = Math.round(BLUE[1] + (WHITE[1] - BLUE[1]) * w);
      rgba[i + 2] = Math.round(BLUE[2] + (WHITE[2] - BLUE[2]) * w);
      rgba[i + 3] = Math.round((inside / n) * 255);
    }
  }
  return encodePng(size, rgba, opaque);
}

// Android adaptive icon foreground: only the white mark, on a transparent square, shrunk into the
// central "safe zone" because Android crops the outer part of the layer.
function drawForeground(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 0.52;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size - 0.5) / scale + 0.5;
          const y = ((py + (sy + 0.5) / SS) / size - 0.5) / scale + 0.5;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && inMark(x, y)) mark++;
        }
      }
      const i = (py * size + px) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
      rgba[i + 3] = Math.round((mark / (SS * SS)) * 255);
    }
  }
  return encodePng(size, rgba);
}

const root = path.join(__dirname, '..');
const out = [
  ['src/ui/icons/icon-180.png', 180, false], // phones round the corners themselves
  ['src/ui/icons/icon-192.png', 192, false],
  ['src/ui/icons/icon-512.png', 512, false],
  ['build/icon.png', 512, true],             // computer app icon
  ['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192, true],
  ['ios/LocalBeam/Assets.xcassets/AppIcon.appiconset/icon-1024.png', 1024, false, true],
];
for (const [rel, size, rounded, opaque] of out) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, draw(size, rounded, opaque));
  console.log(`${rel}  ${size}x${size}`);
}
const fg = path.join(root, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png');
fs.writeFileSync(fg, drawForeground(432));
console.log('android adaptive icon foreground  432x432');
