# LocalBeam

Send files and text straight between your own devices. Nothing is uploaded to a server, there is no size
limit beyond your free storage, and everything is encrypted between the two devices. Free and open source (MIT).

**Use it in the browser: https://prateek-ln2002.github.io/localbeam/**

## Two ways to use it

| | Website | Installed apps |
|---|---|---|
| What you need | A browser on both devices, and internet to open the page and connect | The desktop app on a computer; the phone app or a browser on the phone |
| Works on | iPhone, Android, Windows, Mac, Linux | Windows (built), Android (built), Mac and iPhone (source only so far) |
| Internet needed | Yes, to load the page and for the two devices to find each other | No. Everything stays on your Wi-Fi |
| Certificate warning | None | None in the phone apps. One warning if a phone uses the browser page |

### Website (`web/`)

Open the site on both devices, scan the QR code shown on one with the other, and send files either way.

- The two browsers connect directly with WebRTC, which encrypts everything between them.
- A public service ([PeerJS](https://peerjs.com/)) only introduces the two browsers to each other. Because that
  service could in principle sit in the middle, each device proves it knows the secret from the pairing code,
  tied to the fingerprints of that exact encrypted connection. A device in the middle fails this check.
- Only direct connections are used (no relay servers), so both devices should be on the same network.
- Received files are written to the browser's private disk storage piece by piece, not held in memory.
- Paired devices are remembered and reconnect when both have the page open.

### Installed apps

- `electron/` + `src/`: the desktop app. It runs a small HTTPS server on your Wi-Fi with its own certificate
  authority, shows a pairing QR code, and receives into `Downloads/LocalBeam`.
- `android/`: the Android app. It scans the QR code, which carries the fingerprint of the computer's certificate
  authority, and refuses any computer that does not match it.
- `ios/`: the iPhone app source, same design as Android. It has not been compiled yet.

## Project layout

```
web/             the website (plain files, no build step)
src/engine.js    desktop engine: pairing, HTTPS, resumable uploads and downloads
src/certs.js     local certificate authority and server certificate
src/ui/          the desktop app's screens and the phone browser page
electron/        desktop shell
android/         Android app
ios/             iPhone app source
tests/           engine and packaged-app tests
designs/         the screen designs the UI follows
prototype/       the first single-file version
```

## Developing

```
npm install
npm run web        # the website at http://localhost:53720
npm start          # the desktop app
npm test           # 67 engine checks over real HTTPS
```

To try the website with two "devices" in one browser, open a second tab with `?profile=b` added to the address.

## Building

```
npm run dist:win     # Windows installer (on Windows)
npm run dist:mac     # Mac disk image (on a Mac)
npm run dist:linux   # Linux AppImage (on Linux)
gradle -p android assembleRelease   # Android APK (needs JDK 17 and the Android SDK)
```

`.github/workflows/build.yml` runs the tests and builds on GitHub's Windows, macOS and Linux machines.
`.github/workflows/pages.yml` publishes `web/` as the website.

Installers are not code-signed, so Windows SmartScreen and macOS Gatekeeper warn on first run.

## Known limits

- Website: both devices need internet and the same network; a dropped transfer starts again from the beginning;
  received files are kept only while the page is open.
- Desktop app: files offered from the computer go to every paired device; folders must be zipped first.
- The Android app has not yet been run on a device, and the iPhone app has not been compiled.

## Licence

MIT. See [LICENSE](LICENSE). Bundled third-party code is listed in [web/vendor/THIRD-PARTY.txt](web/vendor/THIRD-PARTY.txt).
