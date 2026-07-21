'use strict';

const https = require('https');
const net = require('net');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const forge = require('node-forge');
const multer = require('multer');

const app = express();
const DEFAULT_PORT = 8443;

// ── Config loading ─────────────────────────────────────────────────────────────
// Precedence: environment variables > config file > built-in defaults.
// The config file is searched at, in order:
//   1. the path given by the CONFIG env var
//   2. ./boardbee.config.json (current working directory)
//   3. <server dir>/boardbee.config.json
// Recognized fields:
//   port           (number)  TCP port the HTTPS server listens on
//   bindAddresses  (string[]) specific IP addresses to bind to; omit/empty to
//                           listen on all interfaces (default behavior)
const CONFIG_FILENAME = 'boardbee.config.json';

function findConfigPath() {
  const candidates = [];
  if (process.env.CONFIG) candidates.push(process.env.CONFIG);
  candidates.push(path.join(process.cwd(), CONFIG_FILENAME));
  candidates.push(path.join(__dirname, CONFIG_FILENAME));
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) { /* ignore, try next */ }
  }
  return null;
}

function loadConfigFile() {
  const cfgPath = findConfigPath();
  if (!cfgPath) return { path: null, config: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`Config file at ${cfgPath} is not a JSON object; ignoring.`);
      return { path: cfgPath, config: {} };
    }
    return { path: cfgPath, config: parsed };
  } catch (err) {
    console.warn(`Failed to read config file at ${cfgPath}: ${err.message}`);
    return { path: cfgPath, config: {} };
  }
}

function normalizeAddresses(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const a of arr) {
    if (typeof a === 'string') {
      const s = a.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function parseEnvAddresses(raw) {
  if (!raw) return null;
  return normalizeAddresses(raw.split(','));
}

const { path: configPath, config: fileConfig } = loadConfigFile();

const envPort = process.env.PORT !== undefined ? Number(process.env.PORT) : NaN;
const configPort = Number.isFinite(envPort) && envPort > 0
  ? envPort
  : (typeof fileConfig.port === 'number' && fileConfig.port > 0 ? fileConfig.port : DEFAULT_PORT);

const configBind = parseEnvAddresses(process.env.BIND_ADDRESSES)
  || normalizeAddresses(fileConfig.bindAddresses)
  || null;

const config = { port: configPort, bindAddresses: configBind, path: configPath };

if (config.path) {
  console.log(`Using config file: ${config.path}`);
}
if (config.bindAddresses) {
  console.log(`Bind addresses: ${config.bindAddresses.join(', ')}`);
}

// ── Authentication ─────────────────────────────────────────────────────────────
// On startup the server generates an 8-digit numeric passcode and prints it to
// the console. Clients must submit this passcode to obtain a session cookie,
// which is then required for all /api/* endpoints.
function generatePasscode() {
  const n = crypto.randomBytes(4).readUInt32BE(0) % 1000000;
  return n.toString().padStart(6, '0');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function constantTimeEquals(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

const passcode = generatePasscode();
const sessionToken = generateSessionToken();
const COOKIE_NAME = 'boardbee_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, in seconds

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies[COOKIE_NAME]) && constantTimeEquals(cookies[COOKIE_NAME], sessionToken);
}

function setSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

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

// ── Authentication API ────────────────────────────────────────────────────────

// POST /api/auth - submit a passcode to obtain a session cookie
app.post('/api/auth', (req, res) => {
  const { passcode: submitted } = req.body || {};
  if (submitted === undefined || submitted === null) {
    return res.status(400).json({ error: 'passcode required' });
  }
  if (!constantTimeEquals(submitted, passcode)) {
    return res.status(401).json({ error: 'invalid passcode' });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/check - report whether the current session is authenticated
app.get('/api/auth/check', (req, res) => {
  if (isAuthenticated(req)) return res.json({ authenticated: true });
  res.status(401).json({ authenticated: false });
});

// POST /api/auth/logout - clear the session cookie
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Require a valid session for all other /api/* endpoints
app.use('/api', (req, res, next) => {
  if (req.path === '/auth' || req.path.startsWith('/auth/')) return next();
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'authentication required' });
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

// Serve static files (favicon.svg, etc.)
app.use(express.static(path.join(__dirname, 'public')));

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

function generateCert(lanIPs, extraHosts, extraIPs) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const attrs = [{ name: 'commonName', value: 'boardbee' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const hostSet = new Set(['localhost']);
  const ipSet = new Set(['127.0.0.1']);
  for (const h of extraHosts) hostSet.add(h);
  for (const ip of extraIPs) ipSet.add(ip);
  for (const ip of lanIPs) ipSet.add(ip);

  const altNames = [];
  for (const h of hostSet) altNames.push({ type: 2, value: h });
  for (const ip of ipSet) altNames.push({ type: 7, ip });

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

// ── Resolve listen + display addresses ─────────────────────────────────────────
// When `bindAddresses` is configured, we bind to each listed address exactly.
// Otherwise we bind to all interfaces (Node default) and display every LAN IP.
const lanIPs = getLanIPs();

let listenHosts;     // array of host strings to pass to server.listen(port, host)
let displayUrls;     // array of { label, url } to print at startup
let certHosts;       // hostnames to include in the cert subjectAltName
let certIPs;         // IP addresses to include in the cert subjectAltName

if (config.bindAddresses && config.bindAddresses.length > 0) {
  listenHosts = config.bindAddresses;
  certHosts = [];
  certIPs = [];
  displayUrls = [];
  for (const addr of listenHosts) {
    if (net.isIP(addr)) {
      certIPs.push(addr);
      displayUrls.push({ label: addr === '127.0.0.1' || addr === '::1' ? 'Local:' : 'Bound:', url: `https://${addr}:${config.port}` });
    } else {
      certHosts.push(addr);
      displayUrls.push({ label: 'Bound:', url: `https://${addr}:${config.port}` });
    }
  }
} else {
  listenHosts = null; // listen on all interfaces
  certHosts = [];
  certIPs = [];
  displayUrls = [
    { label: 'Local:', url: `https://localhost:${config.port}` },
    ...lanIPs.map(ip => ({ label: 'LAN:', url: `https://${ip}:${config.port}` })),
  ];
}

console.log('Generating TLS certificate...');
const { key, cert } = generateCert(lanIPs, certHosts, certIPs);

const tlsOptions = { key, cert };

function printBanner() {
  console.log('\nBoardBee is running over HTTPS.\n');
  for (const u of displayUrls) {
    console.log(`  ${u.label.padEnd(8)} ${u.url}`);
  }
  console.log('\nBrowser setup (one-time per device):');
  console.log('  Open the URL above, click "Advanced" on the cert warning, then "Proceed".');
  console.log('  You only need to do this once per browser per device.');
  console.log('\n  Passcode:  ' + passcode);
  console.log('  Enter this passcode when prompted in the browser to connect.\n');
}

if (listenHosts) {
  let pending = listenHosts.length;
  for (const host of listenHosts) {
    const srv = https.createServer(tlsOptions, app);
    srv.on('error', (err) => {
      console.error(`Failed to listen on ${host}:${config.port}: ${err.message}`);
      process.exit(1);
    });
    srv.listen(config.port, host, () => {
      console.log(`  Listening on https://${host}:${config.port}`);
      pending -= 1;
      if (pending === 0) printBanner();
    });
  }
} else {
  const server = https.createServer(tlsOptions, app);
  server.on('error', (err) => {
    console.error(`Failed to listen on port ${config.port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.port, printBanner);
}
