from pathlib import Path
import sys

path = Path(sys.argv[1])
s = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"patch {label!r}: expected 1 match, found {count}")
    s = s.replace(old, new, 1)


replace_once(
    "const AUDIO_RATE = 32768;",
    "const AUDIO_RATE = 65536; // This vendored mGBA core emits native 65.536 kHz stereo PCM.",
    "audio sample rate",
)

replace_once(
    "let nextAudioTime = 0;",
    "let nextAudioTime = 0;\nconst scheduledAudioSources = new Set();",
    "audio source tracking",
)

replace_once(
    "  stretch: false,\n  controlSize: 1,",
    "  stretch: false,\n  smoothVideo: false,\n  controlSize: 1,",
    "smooth video default",
)

old_audio = r'''async function ensureAudio() {
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
'''

new_audio = r'''function updateAudioGain() {
  if (!gainNode) return;
  gainNode.gain.value = settings.sound ? settings.volume : 0;
}

function resetAudioQueue(mute = false) {
  if (audioCtx) {
    const now = audioCtx.currentTime;
    for (const source of scheduledAudioSources) {
      try { source.stop(now); } catch {}
    }
  }
  scheduledAudioSources.clear();
  nextAudioTime = audioCtx ? audioCtx.currentTime + 0.025 : 0;
  if (mute && gainNode) gainNode.gain.value = 0;
}

function discardCoreAudio() {
  if (!core || !scratchPtr || typeof core._getAudioSamples !== 'function') return;
  // Discard stale PCM left in the core after an app pause/background transition.
  for (let i = 0; i < 16; i++) {
    if (!core._getAudioSamples(scratchPtr, AUDIO_PULL_FRAMES)) break;
  }
}

async function ensureAudio() {
  if (!settings.sound) { updateAudioGain(); return; }
  try {
    let resync = false;
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      resync = true;
    }
    if (audioCtx.state !== 'running') {
      await audioCtx.resume();
      resync = true;
    }
    updateAudioGain();
    if (resync || nextAudioTime <= audioCtx.currentTime - 0.015) {
      nextAudioTime = audioCtx.currentTime + 0.025;
    }
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

  const now = audioCtx.currentTime;
  if (!Number.isFinite(nextAudioTime) || nextAudioTime < now - 0.015) {
    nextAudioTime = now + 0.025;
  }
  // Never build a long scheduled backlog. Dropping a late chunk is preferable
  // to playing old audio on top of current audio.
  if (nextAudioTime > now + 0.12) return;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode);
  source.onended = () => scheduledAudioSources.delete(source);
  scheduledAudioSources.add(source);
  const startAt = Math.max(nextAudioTime, now + 0.005);
  source.start(startAt);
  nextAudioTime = startAt + got / AUDIO_RATE;
}
'''
replace_once(old_audio, new_audio, "audio pipeline")

old_buttons = r'''document.querySelectorAll('[data-key]').forEach(button => {
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
'''

new_buttons = r'''function releaseButtonPointer(pointerId) {
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
    // Register the game input immediately. Audio resume must never delay a held button.
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
'''
replace_once(old_buttons, new_buttons, "button pointer handling")

old_dpad = r'''dpad.addEventListener('pointerdown', async e => {
  if (document.body.classList.contains('editing')) return;
  e.preventDefault(); await ensureAudio();
  dpadPointer = e.pointerId; dpad.setPointerCapture?.(e.pointerId); updateDpad(e);
});
dpad.addEventListener('pointermove', e => { if (e.pointerId === dpadPointer) updateDpad(e); });
dpad.addEventListener('pointerup', e => { if (e.pointerId === dpadPointer) clearDpad(); });
dpad.addEventListener('pointercancel', e => { if (e.pointerId === dpadPointer) clearDpad(); });
'''

new_dpad = r'''dpad.addEventListener('pointerdown', e => {
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
'''
replace_once(old_dpad, new_dpad, "dpad pointer handling")

replace_once(
    "  document.body.classList.toggle('stretch', !!settings.stretch);",
    "  document.body.classList.toggle('stretch', !!settings.stretch);\n  document.body.classList.toggle('smooth-video', !!settings.smoothVideo);\n  ctx.imageSmoothingEnabled = !!settings.smoothVideo;",
    "video filtering application",
)

replace_once(
    "  $('#stretch-screen').checked = settings.stretch;",
    "  $('#stretch-screen').checked = settings.stretch;\n  $('#smooth-video').checked = settings.smoothVideo;",
    "smooth video UI sync",
)

replace_once(
    "  if (gainNode) gainNode.gain.value = settings.volume;",
    "  updateAudioGain();",
    "sound gain sync",
)

replace_once(
    "bindSetting('#stretch-screen','change', el => settings.stretch = el.checked);",
    "bindSetting('#stretch-screen','change', el => settings.stretch = el.checked);\nbindSetting('#smooth-video','change', el => settings.smoothVideo = el.checked);",
    "smooth video setting binding",
)

replace_once(
    "bindSetting('#sound-enabled','change', el => { settings.sound = el.checked; if (el.checked) ensureAudio(); });",
    "bindSetting('#sound-enabled','change', el => {\n  settings.sound = el.checked;\n  resetAudioQueue(!el.checked);\n  updateAudioGain();\n  if (el.checked) void ensureAudio();\n});",
    "sound toggle handling",
)

old_lifecycle = r'''window.addEventListener('resize', () => applyLayout());
window.__orientationChanged = () => setTimeout(applyLayout, 60);
window.__appPause = () => { releaseAll(); flushSave(); lastTick = performance.now(); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseAll(); flushSave(); }
  lastTick = performance.now();
  accumulator = 0;
});
'''

new_lifecycle = r'''window.addEventListener('resize', () => applyLayout());
window.addEventListener('blur', releaseAll, true);
window.__orientationChanged = () => setTimeout(applyLayout, 60);
window.__appPause = () => {
  releaseAll();
  flushSave();
  resetAudioQueue(true);
  lastTick = performance.now();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseAll();
    flushSave();
    resetAudioQueue(true);
  } else {
    discardCoreAudio();
    resetAudioQueue(false);
    updateAudioGain();
    if (settings.sound) void ensureAudio();
  }
  lastTick = performance.now();
  accumulator = 0;
});
'''
replace_once(old_lifecycle, new_lifecycle, "pause and resume handling")

path.write_text(s)
