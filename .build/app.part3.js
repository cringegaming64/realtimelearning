  KeyZ:'A', KeyX:'B', KeyA:'L', KeyS:'R', Enter:'Start', Backspace:'Select'
};
window.addEventListener('keydown', e => {
  const k = keyMap[e.code] || keyMap[e.key];
  if (!k || e.repeat) return; e.preventDefault(); void ensureAudio(); down(k);
}, true);
window.addEventListener('keyup', e => {
  const k = keyMap[e.code] || keyMap[e.key];
  if (!k) return; e.preventDefault(); up(k);
}, true);

function currentMode() {
  if (settings.layout === 'portrait' || settings.layout === 'landscape') return settings.layout;
  return innerWidth > innerHeight ? 'landscape' : 'portrait';
}

function applyLayout() {
  const mode = currentMode();
  document.body.dataset.mode = mode;
  document.body.classList.toggle('stretch', !!settings.stretch);
  document.body.classList.toggle('smooth-video', !!settings.smoothVideo);
  document.documentElement.style.setProperty('--control-scale', String(settings.controlSize));
  document.documentElement.style.setProperty('--control-opacity', String(settings.opacity));
  const pos = settings.positions[mode];
  document.querySelectorAll('[data-group]').forEach(g => {
    const p = pos[g.dataset.group];
    if (p) { g.style.left = `${p[0]}%`; g.style.top = `${p[1]}%`; }
  });
  requestAnimationFrame(() => { resizeDisplayCanvas(); if (loaded) drawVideoFrame(); });
}

function syncSettingsUi() {
  $('#layout-mode').value = settings.layout;
  $('#stretch-screen').checked = settings.stretch;
  $('#smooth-video').checked = settings.smoothVideo;
  $('#control-size').value = settings.controlSize;
  $('#control-opacity').value = settings.opacity;
  $('#sound-enabled').checked = settings.sound;
  $('#volume').value = settings.volume;
  updateAudioGain();
  applyLayout();
}

function bindSetting(id, event, setter) {
  $(id).addEventListener(event, e => { setter(e.target); saveSettings(); syncSettingsUi(); });
}
bindSetting('#layout-mode','change', el => settings.layout = el.value);
bindSetting('#stretch-screen','change', el => settings.stretch = el.checked);
bindSetting('#smooth-video','change', el => settings.smoothVideo = el.checked);
bindSetting('#control-size','input', el => settings.controlSize = Number(el.value));
bindSetting('#control-opacity','input', el => settings.opacity = Number(el.value));
bindSetting('#sound-enabled','change', el => {
  settings.sound = el.checked;
  resetAudioQueue(!el.checked);
  updateAudioGain();
  if (el.checked) void ensureAudio();
});
bindSetting('#volume','input', el => settings.volume = Number(el.value));

function openSettings() { $('#settings-backdrop').hidden = false; }
function closeSettings() {
  if ($('#settings-backdrop').hidden) return false;
  $('#settings-backdrop').hidden = true;
  $('#edit-controls').checked = false;
  document.body.classList.remove('editing');
  return true;
}
$('#settings-button').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', closeSettings);
$('#settings-backdrop').addEventListener('pointerdown', e => { if (e.target === $('#settings-backdrop')) closeSettings(); });
window.__closeSettings = closeSettings;

$('#edit-controls').addEventListener('change', e => document.body.classList.toggle('editing', e.target.checked));

document.querySelectorAll('[data-group]').forEach(group => {
  group.addEventListener('pointerdown', e => {
    if (!document.body.classList.contains('editing')) return;
    e.preventDefault(); e.stopPropagation();
    group.setPointerCapture?.(e.pointerId);
    editDrag = { pointer: e.pointerId, group };
  }, true);
  group.addEventListener('pointermove', e => {
    if (!editDrag || editDrag.pointer !== e.pointerId || editDrag.group !== group) return;
    const r = controlsLayer.getBoundingClientRect();
    const x = Math.max(5, Math.min(95, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.max(5, Math.min(95, ((e.clientY - r.top) / r.height) * 100));
    group.style.left = `${x}%`; group.style.top = `${y}%`;
    settings.positions[currentMode()][group.dataset.group] = [Number(x.toFixed(2)), Number(y.toFixed(2))];
  }, true);
  const finish = e => {
    if (!editDrag || editDrag.pointer !== e.pointerId) return;
    editDrag = null; saveSettings();
  };
  group.addEventListener('pointerup', finish, true);
  group.addEventListener('pointercancel', finish, true);
});

$('#reset-layout').addEventListener('click', () => {
  settings.positions = cloneDefaults().positions;
  saveSettings(); applyLayout(); showStatus('Control positions reset');
});
$('#change-rom').addEventListener('click', () => { closeSettings(); romInput.click(); });
$('#forget-rom').addEventListener('click', async () => {
  await flushSave();
  await idbDelete('last-rom');
  location.reload();
});
$('#open-rom').addEventListener('click', async () => { await ensureAudio(); romInput.click(); });
romInput.addEventListener('change', () => importFile(romInput.files?.[0]));

window.addEventListener('resize', applyLayout);
window.addEventListener('blur', releaseAll, true);
window.__orientationChanged = () => setTimeout(applyLayout, 60);
window.__appPause = () => {
  releaseAll();
  flushSave();
  resetAudioQueue(true);
  lastTick = performance.now();
  accumulator = 0;
};
window.__appResume = () => {
  discardCoreAudio();
  resetAudioQueue(false);
  updateAudioGain();
  if (settings.sound) void ensureAudio();
  lastTick = performance.now();
  accumulator = 0;
  applyLayout();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) window.__appPause();
  else window.__appResume();
});
window.addEventListener('pagehide', () => flushSave());
window.addEventListener('error', e => showStatus(`Error: ${e.message}`, true));
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  showStatus(`Error: ${e.reason?.message || 'Emulator failed to start'}`, true);
});

syncSettingsUi();
bootStoredRom().catch(err => {
  console.error(err);
  emptyState.hidden = false;
  showStatus(err.message || 'Could not start the emulator', true);
});
