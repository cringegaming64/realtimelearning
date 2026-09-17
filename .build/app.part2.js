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

function resizeDisplayCanvas() {
  const r = gameStage.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(r.width * dpr));
  const height = Math.max(1, Math.round(r.height * dpr));
  if (screen.width !== width || screen.height !== height) {
    screen.width = width;
    screen.height = height;
    return true;
  }
  return false;
}

function drawVideoFrame() {
  if (!frameCanvas.width || !frameCanvas.height || !screen.width || !screen.height) return;
  ctx.imageSmoothingEnabled = !!settings.smoothVideo;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = settings.smoothVideo ? 'high' : 'low';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, screen.width, screen.height);

  let dx = 0, dy = 0, dw = screen.width, dh = screen.height;
  if (!settings.stretch) {
    const scale = Math.min(screen.width / frameCanvas.width, screen.height / frameCanvas.height);
    dw = Math.max(1, Math.round(frameCanvas.width * scale));
    dh = Math.max(1, Math.round(frameCanvas.height * scale));
    dx = Math.floor((screen.width - dw) / 2);
    dy = Math.floor((screen.height - dh) / 2);
  }
  ctx.drawImage(frameCanvas, 0, 0, frameCanvas.width, frameCanvas.height, dx, dy, dw, dh);
}

function renderFrame() {
  const pixels = core.getPixelBuffer();
  if (!pixels) return;
  const dims = core.getPixelBufferDimensions ? core.getPixelBufferDimensions() : { width: GBA_W, height: GBA_H };
  if (frameCanvas.width !== dims.width || frameCanvas.height !== dims.height) {
    frameCanvas.width = dims.width;
    frameCanvas.height = dims.height;
  }
  const needed = dims.width * dims.height * 4;
  const view = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, Math.min(needed, pixels.byteLength));
  if (view.byteLength < needed) return;
  frameCtx.putImageData(new ImageData(view, dims.width, dims.height), 0, 0);
  resizeDisplayCanvas();
  drawVideoFrame();
}

function updateAudioGain() {
  if (gainNode) gainNode.gain.value = settings.sound ? settings.volume : 0;
}

function clearAudioRing() {
  audioRead = 0;
  audioWrite = 0;
  audioCount = 0;
  audioPhase = 0;
  audioPrimed = false;
}

function resetAudioQueue(mute = false) {
  clearAudioRing();
  if (mute && gainNode) gainNode.gain.value = 0;
}

function discardCoreAudio() {
  if (!core || !scratchPtr || typeof core._getAudioSamples !== 'function') return;
  for (let i = 0; i < 16; i++) {
    if (!core._getAudioSamples(scratchPtr, AUDIO_PULL_FRAMES)) break;
  }
}

function pushAudio(samples, frames) {
  if (frames <= 0) return;
  const overflow = Math.max(0, audioCount + frames - AUDIO_MAX_QUEUE_FRAMES);
  if (overflow) {
    audioRead = (audioRead + overflow) % AUDIO_RING_FRAMES;
    audioCount -= Math.min(overflow, audioCount);
    audioPhase = 0;
  }

  for (let i = 0, j = 0; i < frames; i++, j += 2) {
    if (audioCount >= AUDIO_RING_FRAMES - 1) {
      audioRead = (audioRead + 1) % AUDIO_RING_FRAMES;
      audioCount--;
      audioPhase = 0;
    }
    audioRingL[audioWrite] = samples[j] / 32768;
    audioRingR[audioWrite] = samples[j + 1] / 32768;
    audioWrite = (audioWrite + 1) % AUDIO_RING_FRAMES;
    audioCount++;
  }
  if (!audioPrimed && audioCount >= AUDIO_START_FRAMES) audioPrimed = true;
}

function outputAudio(event) {
  const left = event.outputBuffer.getChannelData(0);
  const right = event.outputBuffer.getChannelData(1);
  left.fill(0);
  right.fill(0);
  if (!settings.sound || !audioPrimed || !audioCtx) return;

  const ratio = AUDIO_RATE / audioCtx.sampleRate;
  for (let i = 0; i < left.length; i++) {
    if (audioCount < 2) {
      audioPrimed = false;
      break;
    }
    const next = (audioRead + 1) % AUDIO_RING_FRAMES;
    const frac = audioPhase;
    left[i] = audioRingL[audioRead] + (audioRingL[next] - audioRingL[audioRead]) * frac;
    right[i] = audioRingR[audioRead] + (audioRingR[next] - audioRingR[audioRead]) * frac;

    audioPhase += ratio;
    const advance = Math.floor(audioPhase);
    audioPhase -= advance;
    if (advance > 0) {
      const consume = Math.min(advance, Math.max(0, audioCount - 1));
      audioRead = (audioRead + consume) % AUDIO_RING_FRAMES;
      audioCount -= consume;
      if (consume < advance) {
        audioPrimed = false;
        break;
      }
    }
  }
}

async function ensureAudio() {
  if (!settings.sound) { updateAudioGain(); return; }
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      gainNode = audioCtx.createGain();
      audioNode = audioCtx.createScriptProcessor(1024, 0, 2);
      audioNode.onaudioprocess = outputAudio;
      audioNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    }
    updateAudioGain();
    if (audioCtx.state !== 'running') await audioCtx.resume();
  } catch (err) { console.warn('Audio unavailable', err); }
}

function drainAudio() {
  if (!core || !scratchPtr || typeof core._getAudioSamples !== 'function') return;
  const got = core._getAudioSamples(scratchPtr, AUDIO_PULL_FRAMES);
  if (!got) return;
  if (!settings.sound || !audioCtx || audioCtx.state !== 'running') return;
  const offset = scratchPtr >> 1;
  const samples = core.HEAP16.subarray(offset, offset + got * 2);
  pushAudio(samples, got);
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
  if (steps === 3 && accumulator >= FRAME_MS) accumulator %= FRAME_MS;
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

function releaseButtonPointer(pointerId) {
  const key = activeButtonPointers.get(pointerId);
  if (!key) return;
  activeButtonPointers.delete(pointerId);
  up(key);
}

document.querySelectorAll('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', e => {
    if (document.body.classList.contains('editing')) return;
    e.preventDefault();
    e.stopPropagation();
    activeButtonPointers.set(e.pointerId, button.dataset.key);
    try { button.setPointerCapture?.(e.pointerId); } catch {}
    down(button.dataset.key);
    void ensureAudio();
  });
  const release = e => releaseButtonPointer(e.pointerId);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  button.addEventListener('contextmenu', e => e.preventDefault());
});
window.addEventListener('pointerup', e => releaseButtonPointer(e.pointerId), true);
window.addEventListener('pointercancel', e => releaseButtonPointer(e.pointerId), true);

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
dpad.addEventListener('pointerdown', e => {
  if (document.body.classList.contains('editing')) return;
  e.preventDefault();
  dpadPointer = e.pointerId;
  try { dpad.setPointerCapture?.(e.pointerId); } catch {}
  updateDpad(e);
  void ensureAudio();
});
dpad.addEventListener('pointermove', e => {
  if (e.pointerId !== dpadPointer) return;
  e.preventDefault();
  updateDpad(e);
});
dpad.addEventListener('pointerup', e => { if (e.pointerId === dpadPointer) clearDpad(); });
dpad.addEventListener('pointercancel', e => { if (e.pointerId === dpadPointer) clearDpad(); });
dpad.addEventListener('lostpointercapture', e => { if (e.pointerId === dpadPointer) clearDpad(); });
dpad.addEventListener('contextmenu', e => e.preventDefault());

const keyMap = {
  ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right',
