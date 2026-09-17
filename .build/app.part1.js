import mGBA from './mgba.js';

const GBA_W = 240;
const GBA_H = 160;
const FPS = 59.7275;
const FRAME_MS = 1000 / FPS;
const MAX_ROM = 32 * 1024 * 1024;
const AUDIO_RATE = 32768;
const AUDIO_PULL_FRAMES = 2048;
const DB_NAME = 'gba-pocket-db';
const DB_STORE = 'kv';

const $ = (q) => document.querySelector(q);
const screen = $('#screen');
const ctx = screen.getContext('2d', { alpha: false });
const romInput = $('#rom-file');
const emptyState = $('#empty-state');
const statusEl = $('#status');
const controlsLayer = $('#controls-layer');

let core = null;
let runFrame = null;
let currentRom = null;
let currentKey = null;
let scratchPtr = 0;
let loaded = false;
let stopped = false;
let saveTimer = null;
let statusTimer = null;
let audioCtx = null;
let gainNode = null;
let nextAudioTime = 0;
let lastTick = performance.now();
let accumulator = 0;
const held = new Set();
const activeButtonPointers = new Map();
let dpadPointer = null;
let dpadHeld = new Set();
let editDrag = null;

const defaults = {
  layout: 'auto',
  stretch: false,
  controlSize: 1,
  opacity: 0.72,
  sound: true,
  volume: 0.85,
  positions: {
    portrait: {
      l: [14, 12], r: [86, 12], dpad: [24, 57], actions: [78, 55], center: [50, 85]
    },
    landscape: {
      l: [10, 15], r: [90, 15], dpad: [15, 72], actions: [84, 69], center: [50, 88]
    }
  }
};

let settings = loadSettings();

function cloneDefaults() {
  return JSON.parse(JSON.stringify(defaults));
}

function loadSettings() {
  const base = cloneDefaults();
  try {
    const saved = JSON.parse(localStorage.getItem('gba-pocket-settings') || '{}');
    return {
      ...base,
      ...saved,
      positions: {
        portrait: { ...base.positions.portrait, ...(saved.positions?.portrait || {}) },
        landscape: { ...base.positions.landscape, ...(saved.positions?.landscape || {}) }
      }
    };
  } catch {
    return base;
  }
}

function saveSettings() {
  localStorage.setItem('gba-pocket-settings', JSON.stringify(settings));
}

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const database = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { database.close(); }
}

async function idbSet(key, value) {
  const database = await db();
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { database.close(); }
}

async function idbDelete(key) {
  const database = await db();
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { database.close(); }
}

function showStatus(text, sticky = false) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.classList.add('show');
  if (!sticky) statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1800);
}

function hideStatus() {
  clearTimeout(statusTimer);
  statusEl.classList.remove('show');
}

function cleanName(name) {
  return (name || 'game.gba').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._()\- ]/g, '_');
}

function stem(name) {
  return cleanName(name).replace(/\.gba$/i, '');
}

async function romKey(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return [...new Uint8Array(digest).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function readU16(v, o) { return v[o] | (v[o + 1] << 8); }
function readU32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }
function sig(v, o, n) { return readU32(v, o) === n; }

function extractGbaFromZip(buffer) {
  const z = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  let eocd = -1;
  const start = Math.max(0, z.length - 65557);
  for (let i = z.length - 22; i >= start; i--) {
    if (sig(z, i, 0x06054b50)) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP central directory not found');
  const entries = readU16(z, eocd + 10);
  let p = readU32(z, eocd + 16);
  let candidate = null;
  for (let i = 0; i < entries && p + 46 <= z.length; i++) {
    if (!sig(z, p, 0x02014b50)) throw new Error('Invalid ZIP directory');
    const method = readU16(z, p + 10);
    const cSize = readU32(z, p + 20);
    const uSize = readU32(z, p + 24);
    const nameLen = readU16(z, p + 28);
    const extraLen = readU16(z, p + 30);
    const commentLen = readU16(z, p + 32);
    const localOffset = readU32(z, p + 42);
    const name = decoder.decode(z.subarray(p + 46, p + 46 + nameLen));
    if (!candidate && /\.gba$/i.test(name) && !name.endsWith('/') && uSize > 0 && uSize <= MAX_ROM) {
      candidate = { name: cleanName(name), method, cSize, uSize, localOffset };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!candidate) throw new Error('No .gba file (32 MB or smaller) was found in this ZIP');
  const o = candidate.localOffset;
  if (!sig(z, o, 0x04034b50)) throw new Error('Invalid ZIP local header');
  const nameLen = readU16(z, o + 26);
  const extraLen = readU16(z, o + 28);
  const dataStart = o + 30 + nameLen + extraLen;
  const compressed = z.subarray(dataStart, dataStart + candidate.cSize);
  let out;
  if (candidate.method === 0) out = compressed.slice();
  else if (candidate.method === 8) out = window.fflate.inflateSync(compressed);
  else throw new Error('ZIP uses an unsupported compression method');
  if (out.length !== candidate.uSize || out.length > MAX_ROM) throw new Error('ZIP entry size is invalid');
  return { name: candidate.name, bytes: out };
}

async function importFile(file) {
  if (!file) return;
  await ensureAudio();
  showStatus('Importing…', true);
  try {
    const buffer = await file.arrayBuffer();
    let picked;
    if (/\.zip$/i.test(file.name)) picked = extractGbaFromZip(buffer);
    else if (/\.gba$/i.test(file.name)) picked = { name: cleanName(file.name), bytes: new Uint8Array(buffer) };
    else throw new Error('Choose a .gba or .zip file');
    if (!picked.bytes.length || picked.bytes.length > MAX_ROM) throw new Error('ROM must be between 1 byte and 32 MB');
    const key = await romKey(picked.bytes);
    await idbSet('last-rom', { name: picked.name, key, data: picked.bytes.buffer.slice(picked.bytes.byteOffset, picked.bytes.byteOffset + picked.bytes.byteLength) });
    location.reload();
  } catch (err) {
    console.error(err);
    showStatus(err.message || 'Could not import that file', true);
  } finally {
    romInput.value = '';
  }
