'use strict';
// HTTPS for the local network.
// LocalBeam makes its own certificate authority (CA) once, then issues a server certificate
// for this computer's network addresses. Everything stays in the app's data folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const CA_DAYS = 3650;
const LEAF_DAYS = 397; // Apple devices reject server certificates that are valid for longer than about 13 months
const RENEW_BEFORE_DAYS = 30;
const MAX_IPS = 20;

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicPem: publicKey, privatePem: privateKey };
}

function serial() {
  const b = crypto.randomBytes(16);
  b[0] = (b[0] & 0x7f) || 1; // must be a positive number
  return b.toString('hex');
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function createCA(label) {
  const kp = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(kp.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(CA_DAYS);
  const clean = String(label || 'computer').replace(/[^\x20-\x7e]/g, '').slice(0, 30) || 'computer';
  const attrs = [
    { name: 'commonName', value: `LocalBeam CA (${clean})` },
    { name: 'organizationName', value: 'LocalBeam' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(kp.privatePem), forge.md.sha256.create());
  return { keyPem: kp.privatePem, certPem: forge.pki.certificateToPem(cert) };
}

function createLeaf(ca, ips) {
  const kp = newKeyPair();
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(kp.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(LEAF_DAYS);
  cert.setSubject([{ name: 'commonName', value: 'LocalBeam' }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }]
    .concat(ips.map((ip) => ({ type: 7, ip })));
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());
  return {
    keyPem: kp.privatePem,
    certPem: forge.pki.certificateToPem(cert),
    notAfter: cert.validity.notAfter.getTime(),
  };
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/**
 * Make sure a CA and a server certificate covering `ips` exist in `dataDir`.
 * Addresses seen before stay on the certificate, so returning to a known network
 * does not produce a new certificate (and a new browser warning).
 */
function ensure(dataDir, label, ips) {
  const dir = path.join(dataDir, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  const f = (name) => path.join(dir, name);

  let ca = { keyPem: readIfExists(f('ca-key.pem')), certPem: readIfExists(f('ca-cert.pem')) };
  let regenerated = false;
  if (!ca.keyPem || !ca.certPem) {
    ca = createCA(label);
    writePrivate(f('ca-key.pem'), ca.keyPem);
    fs.writeFileSync(f('ca-cert.pem'), ca.certPem);
    regenerated = true;
  }

  let meta = null;
  try { meta = JSON.parse(readIfExists(f('server.json'))); } catch { meta = null; }
  let keyPem = readIfExists(f('server-key.pem'));
  let certPem = readIfExists(f('server-cert.pem'));

  const known = meta && Array.isArray(meta.ips) ? meta.ips : [];
  const missing = ips.filter((ip) => !known.includes(ip));
  const expiring = !meta || !meta.notAfter || meta.notAfter - Date.now() < RENEW_BEFORE_DAYS * 86400000;

  if (regenerated || !keyPem || !certPem || missing.length || expiring) {
    const all = ips.concat(known.filter((ip) => !ips.includes(ip))).slice(0, MAX_IPS);
    const leaf = createLeaf(ca, all);
    keyPem = leaf.keyPem;
    certPem = leaf.certPem;
    writePrivate(f('server-key.pem'), keyPem);
    fs.writeFileSync(f('server-cert.pem'), certPem);
    fs.writeFileSync(f('server.json'), JSON.stringify({ ips: all, notAfter: leaf.notAfter }));
    regenerated = true;
  }

  return {
    key: keyPem,
    cert: certPem + ca.certPem, // send the CA along so devices that trust it can verify the chain
    caCertPem: ca.certPem,
    fingerprint: new crypto.X509Certificate(certPem).fingerprint256,
    // SHA-256 of the CA certificate. The phone apps receive it inside the QR code and refuse any
    // computer whose certificate was not issued by exactly this CA.
    caFingerprint: new crypto.X509Certificate(ca.certPem).fingerprint256.replace(/:/g, '').toLowerCase(),
    regenerated,
  };
}

module.exports = { ensure };
