}

async function initCore() {
  if (core) return;
  showStatus('Starting mGBA…', true);
  core = await mGBA({
    canvas: null,
    locateFile: (name) => new URL(name, location.href).href,
    print: () => {},
    printErr: (m) => console.warn('[mGBA]', m)
  });
  await core.FSInit();
  runFrame = core.runFrame || core._runFrame;
  if (typeof runFrame !== 'function') throw new Error('Emulator frame API is unavailable');
  scratchPtr = core._malloc(AUDIO_PULL_FRAMES * 2 * 2);
}

async function bootStoredRom() {
  const savedRom = await idbGet('last-rom');
  if (!savedRom?.data) {
    emptyState.hidden = false;
    hideStatus();
    return;
  }
  currentRom = savedRom;
  currentKey = savedRom.key;
  emptyState.hidden = true;
  await initCore();
  const bytes = new Uint8Array(savedRom.data);
  const paths = core.filePaths();
  const gameName = cleanName(savedRom.name).toLowerCase().endsWith('.gba') ? cleanName(savedRom.name) : cleanName(savedRom.name) + '.gba';
  const gamePath = `${paths.gamePath}/${gameName}`;
  const savePath = `${paths.savePath}/${stem(gameName)}.sav`;
  const battery = await idbGet(`save:${currentKey}`);
  if (battery?.data) core.FS.writeFile(savePath, new Uint8Array(battery.data));
  core.FS.writeFile(gamePath, bytes);
  if (!core.loadGame(gamePath)) throw new Error('mGBA could not load this ROM');
  core.addCoreCallbacks({
    saveDataUpdatedCallback: () => scheduleSave(),
    coreCrashedCallback: () => showStatus('The emulator core stopped unexpectedly', true),
    alarmCallback: null, keysReadCallback: null, videoFrameEndedCallback: null,
    videoFrameStartedCallback: null, autoSaveStateCapturedCallback: null,
    autoSaveStateLoadedCallback: null
  });
  loaded = true;
  stopped = false;
  lastTick = performance.now();
  accumulator = FRAME_MS;
  showStatus(gameName);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!loaded || !core || !currentKey) return;
  try {
    const bytes = core.getSave();
    if (bytes?.length) await idbSet(`save:${currentKey}`, { data: bytes.slice().buffer, updated: Date.now() });
  } catch (err) {
    console.warn('Save write failed', err);
  }
}

function renderFrame() {
  const pixels = core.getPixelBuffer();
  if (!pixels) return;
  const dims = core.getPixelBufferDimensions ? core.getPixelBufferDimensions() : { width: GBA_W, height: GBA_H };
  if (screen.width !== dims.width || screen.height !== dims.height) {
    screen.width = dims.width; screen.height = dims.height;
  }
  const view = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  ctx.putImageData(new ImageData(view, dims.width, dims.height), 0, 0);
}

async function ensureAudio() {
  if (!settings.sound) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      gainNode = audioCtx.createGain();
      gainNode.gain.value = settings.volume;
      gainNode.connect(audioCtx.destination);
      nextAudioTime = audioCtx.currentTime;
    }
    if (audioCtx.state !== 'running') await audioCtx.resume();
  } catch (err) { console.warn('Audio unavailable', err); }
}

function drainAudio() {
  if (!core || !scratchPtr || typeof core._getAudioSamples !== 'function') return;
  const got = core._getAudioSamples(scratchPtr, AUDIO_PULL_FRAMES);
  if (!got) return;
  if (!settings.sound || !audioCtx || audioCtx.state !== 'running' || !gainNode) return;
  const offset = scratchPtr >> 1;
  const samples = core.HEAP16.subarray(offset, offset + got * 2);
  const buffer = audioCtx.createBuffer(2, got, AUDIO_RATE);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  for (let i = 0, j = 0; i < got; i++, j += 2) {
    left[i] = samples[j] / 32768;
    right[i] = samples[j + 1] / 32768;
  }
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode);
  const now = audioCtx.currentTime;
  if (nextAudioTime < now || nextAudioTime > now + 0.24) nextAudioTime = now + 0.018;
  source.start(nextAudioTime);
  nextAudioTime += got / AUDIO_RATE;
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!loaded || stopped || document.hidden) { lastTick = now; return; }
  const elapsed = Math.min(100, Math.max(0, now - lastTick));
  lastTick = now;
  accumulator += elapsed;
  let steps = 0;
  while (accumulator >= FRAME_MS && steps < 3) {
    runFrame();
    drainAudio();
    accumulator -= FRAME_MS;
    steps++;
  }
  if (steps) renderFrame();
}
requestAnimationFrame(tick);

function down(name) {
  if (!loaded || held.has(name)) return;
  held.add(name);
  core.buttonPress(name);
  document.querySelectorAll(`[data-key="${name}"]`).forEach(el => el.classList.add('pressed'));
}

function up(name) {
  if (!held.has(name)) return;
  held.delete(name);
  if (loaded) core.buttonUnpress(name);
  document.querySelectorAll(`[data-key="${name}"]`).forEach(el => el.classList.remove('pressed'));
}

function releaseAll() {
  [...held].forEach(up);
  clearDpad();
}

document.querySelectorAll('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', async e => {
    if (document.body.classList.contains('editing')) return;
    e.preventDefault();
    await ensureAudio();
    button.setPointerCapture?.(e.pointerId);
    activeButtonPointers.set(e.pointerId, button.dataset.key);
    down(button.dataset.key);
  });
  const release = e => {
    const key = activeButtonPointers.get(e.pointerId);
    if (!key) return;
    activeButtonPointers.delete(e.pointerId);
    up(key);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
});

const dpad = $('#dpad-zone');
function setDpad(desired) {
  for (const k of dpadHeld) if (!desired.has(k)) up(k);
  for (const k of desired) if (!dpadHeld.has(k)) down(k);
  dpadHeld = desired;
  const visual = { Up: '.up', Down: '.down', Left: '.left', Right: '.right' };
  Object.entries(visual).forEach(([k, q]) => dpad.querySelector(q).classList.toggle('pressed', desired.has(k)));
}
function updateDpad(e) {
  const r = dpad.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1;
  const y = ((e.clientY - r.top) / r.height) * 2 - 1;
  const desired = new Set();
  if (x < -0.20) desired.add('Left');
  if (x > 0.20) desired.add('Right');
  if (y < -0.20) desired.add('Up');
  if (y > 0.20) desired.add('Down');
  setDpad(desired);
}
function clearDpad() { setDpad(new Set()); dpadPointer = null; }
dpad.addEventListener('pointerdown', async e => {
  if (document.body.classList.contains('editing')) return;
  e.preventDefault(); await ensureAudio();
  dpadPointer = e.pointerId; dpad.setPointerCapture?.(e.pointerId); updateDpad(e);
});
dpad.addEventListener('pointermove', e => { if (e.pointerId === dpadPointer) updateDpad(e); });
dpad.addEventListener('pointerup', e => { if (e.pointerId === dpadPointer) clearDpad(); });
dpad.addEventListener('pointercancel', e => { if (e.pointerId === dpadPointer) clearDpad(); });

const keyMap = {
  ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right',
