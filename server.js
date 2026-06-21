'use strict';

const https = require('https');
const express = require('express');
const path = require('path');
const os = require('os');
const forge = require('node-forge');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8443;

// In-memory clipboard store: array of { type: string, data: string (base64) }
let sharedClipboard = [];
let clipboardLastUpdated = null;

// In-memory file store: array of { name: string, mime: string, buf: Buffer, size: number }
let sharedFiles = [];
let filesLastUpdated = null;

// multer: store uploads in memory (Buffer), no size limit beyond Node heap
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Parse JSON bodies up to 50 MB (to accommodate large images)
app.use(express.json({ limit: '50mb' }));

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Clipboard API ────────────────────────────────────────────────────────────

// GET /api/clipboard - retrieve current shared clipboard contents
app.get('/api/clipboard', (req, res) => {
  res.json({ items: sharedClipboard, lastUpdated: clipboardLastUpdated });
});

// POST /api/clipboard - replace shared clipboard with new contents
app.post('/api/clipboard', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'items must be an array' });
  }
  for (const item of items) {
    if (typeof item.type !== 'string' || typeof item.data !== 'string') {
      return res.status(400).json({ error: 'each item must have string type and data fields' });
    }
  }
  sharedClipboard = items;
  clipboardLastUpdated = new Date().toISOString();
  res.json({ ok: true, count: items.length, lastUpdated: clipboardLastUpdated });
});

// ── File API ─────────────────────────────────────────────────────────────────

// GET /api/files - list files currently on the server
app.get('/api/files', (req, res) => {
  res.json({
    files: sharedFiles.map(f => ({ name: f.name, mime: f.mime, size: f.size })),
    lastUpdated: filesLastUpdated,
  });
});

// POST /api/files - upload one or more files (replaces current set)
app.post('/api/files', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'no files uploaded' });
  }
  sharedFiles = req.files.map(f => ({
    name: f.originalname,
    mime: f.mimetype,
    buf: f.buffer,
    size: f.size,
  }));
  filesLastUpdated = new Date().toISOString();
  res.json({
    ok: true,
    count: sharedFiles.length,
    files: sharedFiles.map(f => ({ name: f.name, mime: f.mime, size: f.size })),
    lastUpdated: filesLastUpdated,
  });
});

// GET /api/files/:index - download a single file by index
app.get('/api/files/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= sharedFiles.length) {
    return res.status(404).json({ error: 'file not found' });
  }
  const file = sharedFiles[idx];
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader('Content-Length', file.size);
  res.send(file.buf);
});

// ── TLS cert generation ───────────────────────────────────────────────────────

function getLanIPs() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push(addr.address);
      }
    }
  }
  return result;
}

function generateCert(lanIPs) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const attrs = [{ name: 'commonName', value: 'clipshare' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIPs.map(ip => ({ type: 7, ip })),
  ];
  cert.setExtensions([
    { name: 'subjectAltName', altNames },
    { name: 'basicConstraints', cA: false },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

console.log('Generating TLS certificate...');
const lanIPs = getLanIPs();
const { key, cert } = generateCert(lanIPs);

const server = https.createServer({ key, cert }, app);

server.listen(PORT, () => {
  console.log('\nClipShare is running over HTTPS.\n');
  console.log(`  Local:   https://localhost:${PORT}`);
  for (const ip of lanIPs) {
    console.log(`  LAN:     https://${ip}:${PORT}`);
  }
  console.log('\nBrowser setup (one-time per device):');
  console.log('  Open the URL above, click "Advanced" on the cert warning, then "Proceed".');
  console.log('  You only need to do this once per browser per device.\n');
});
