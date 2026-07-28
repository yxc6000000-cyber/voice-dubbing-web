// ─── IndexedDB ─────────────────────────────────────────────
const DB_NAME = 'VoiceDubbingDB';
const DB_VERSION = 1;
const STORE_NAME = 'clips';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveClips(videoKey, clips, loopA, loopB) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await new Promise((resolve, reject) => {
    const delReq = store.delete(videoKey);
    delReq.onsuccess = () => resolve();
    delReq.onerror = () => reject(delReq.error);
  });
  await new Promise((resolve, reject) => {
    const putReq = store.put({
      id: videoKey,
      clips: clips.map(c => ({
        id: c.id,
        startTime: c.startTime,
        endTime: c.endTime,
        data: c.blob,
      })),
      loopA,
      loopB,
    });
    putReq.onsuccess = () => resolve();
    putReq.onerror = () => reject(putReq.error);
  });
  tx.commit();
}

async function loadClips(videoKey) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.get(videoKey);
    req.onsuccess = () => {
      if (req.result) resolve({ clips: req.result.clips, loopA: req.result.loopA, loopB: req.result.loopB });
      else resolve({ clips: [], loopA: -1, loopB: -1 });
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── State ───────────────────────────────────────────────
const state = {
  videoLoaded: false,
  videoKey: null,
  recording: false,
  recordStartTime: 0,
  mediaRecorder: null,
  recordedChunks: [],
  clips: [],
  clipsOrder: [],  // 记录插入顺序，用于删除最新录音
  clipsHistory: [],  // 撤销栈：被删除的 clip { id, blob, url, startTime, endTime }
  mixedUrl: null,
  loopA: -1,
  loopB: -1,
  loopEnabled: false,
  dubAudio: null,
  dubMode: null,
  playingClipId: null,
};

// ─── DOM refs ──────────────────────────────────────────────
const video = document.getElementById('video');
const fileInput = document.getElementById('fileInput');
const importBtn = document.getElementById('importBtn');
const btnImport = document.getElementById('btnImport');
const btnDub = document.getElementById('btnDub');
const btnPlayDub = document.getElementById('btnPlayDub');
const muteToggle = document.getElementById('muteToggle');
const muteIcon = document.getElementById('muteIcon');
const clipMuteToggle = document.getElementById('clipMuteToggle');
const clipMuteIcon = document.getElementById('clipMuteIcon');
const seekBar = document.getElementById('seekBar');
const timeDisplay = document.getElementById('timeDisplay');
const statusBadge = document.getElementById('statusBadge');
const btnSetA = document.getElementById('btnSetA');
const btnSetB = document.getElementById('btnSetB');
const btnClearLoop = document.getElementById('btnClearLoop');
const btnPlayFromA = document.getElementById('btnPlayFromA');
const loopLabel = document.getElementById('loopLabel');
const overlay = document.getElementById('videoOverlay');
const clipListEl = document.getElementById('clipList');

// ─── Dub mute toggle ─────────────────────────────────────
let dubMuted = true;
let clipMuted = false;

muteToggle.addEventListener('click', () => {
  dubMuted = !dubMuted;
  muteIcon.textContent = dubMuted ? '🔇' : '🔊';
  if (state.dubMode) video.muted = dubMuted;
});

clipMuteToggle.addEventListener('click', () => {
  clipMuted = !clipMuted;
  clipMuteIcon.textContent = clipMuted ? '🎙️🔇' : '🎙️';
  // 实时静音/恢复正在播放的录音
  if (state.dubAudio) {
    state.dubAudio.volume = clipMuted ? 0 : 1;
  }
});

// ─── Format helpers ──────────────────────────────────────
function fmt(sec) {
  if (!isFinite(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function setBadge(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + cls;
}

function enableWhenLoaded() {
  const ok = state.videoLoaded;
  btnDub.disabled = !ok;
  btnPlayDub.disabled = !ok;
}

function fmtLoop() {
  return `A:${state.loopA >= 0 ? fmt(state.loopA) : '--:--'}  B:${state.loopB >= 0 ? fmt(state.loopB) : '--:--'}`;
}

// ─── Markers ─────────────────────────────────────────────
function renderLoopMarkers() {
  document.querySelectorAll('.loop-marker').forEach(el => el.remove());
  if (!state.videoLoaded || !video.duration) return;
  const wrapper = document.querySelector('.seek-wrapper');
  if (!wrapper) return;
  if (state.loopA >= 0) {
    const pct = (state.loopA / video.duration) * 100;
    const m = document.createElement('div');
    m.className = 'loop-marker marker-a';
    m.style.left = pct + '%';
    wrapper.appendChild(m);
  }
  if (state.loopB >= 0) {
    const pct = (state.loopB / video.duration) * 100;
    const m = document.createElement('div');
    m.className = 'loop-marker marker-b';
    m.style.left = pct + '%';
    wrapper.appendChild(m);
  }
}

function renderClipMarkers() {
  document.querySelectorAll('.clip-marker').forEach(el => el.remove());
  if (!state.videoLoaded || !video.duration) return;
  const wrapper = document.querySelector('.seek-wrapper');
  if (!wrapper) return;
  for (let i = 0; i < state.clips.length; i++) {
    const clip = state.clips[i];
    const startPct = (clip.startTime / video.duration) * 100;
    const endPct = (clip.endTime / video.duration) * 100;
    const m = document.createElement('div');
    m.className = 'clip-marker' + (state.playingClipId === clip.id ? ' active' : '');
    m.style.left = startPct + '%';
    m.style.width = Math.max(0.5, endPct - startPct) + '%';
    m.dataset.idx = i;
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.idx);
      const c = state.clips[idx];
      if (c) toggleClipLoop(c);
    });
    wrapper.appendChild(m);
  }
}

function renderClipList() {
  if (!clipListEl) return;
  clipListEl.innerHTML = '';
  state.clips.sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < state.clips.length; i++) {
    const clip = state.clips[i];
    const isActive = state.playingClipId === clip.id;
    const item = document.createElement('div');
    item.className = 'clip-item' + (isActive ? ' active' : '');
    item.innerHTML = `<span class="clip-num">#${i + 1}</span><span class="clip-time">${fmt(clip.startTime)} - ${fmt(clip.endTime)}</span><span class="clip-play-icon">${isActive ? '⏹' : '▶'}</span><span class="clip-del" data-idx="${i}">✕</span>`;
    item.querySelector('.clip-play-icon').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleClipLoop(clip);
    });
    item.addEventListener('click', (e) => {
      toggleClipLoop(clip);
    });
    item.querySelector('.clip-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteClip(i);
    });
    clipListEl.appendChild(item);
  }
}

function toggleClipLoop(clip) {
  // 如果正在播放同一个 clip，就停止（点同一个 toggle off）
  if (state.dubMode === 'playClip' && state.playingClipId === clip.id) {
    stopDubMode();
    video.muted = false;
    renderClipMarkers();
    renderClipList();
    setBadge('🟢 Watch Mode', 'watch');
    return;
  }
  // 停止之前的播放，播新的
  stopDubMode();
  if (state.recording) {
    stopRecording();
    video.muted = false;
  }

  // clip.url 是持久 blob URL，直接复用
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = clip.url;
  audio.loop = false;
  state.dubAudio = audio;
  state.dubMode = 'playClip';
  state.playingClipId = clip.id;

  audio.onended = () => {
    stopDubMode();
    video.muted = false;
    renderClipMarkers();
    renderClipList();
    setBadge('🟢 Watch Mode', 'watch');
  };

  video.currentTime = clip.startTime;
  video.muted = true;
  renderClipMarkers();
  renderClipList();

  const startPlayback = async () => {
    try { await video.play(); } catch (_) {}
    try { await audio.play(); } catch (_) {}
  };

  if (audio.readyState >= 2) {
    startPlayback();
  } else {
    audio.addEventListener('canplay', startPlayback, { once: true });
    audio.addEventListener('error', startPlayback, { once: true });
  }

  setBadge(`▶ Playing clip #${state.clips.indexOf(clip) + 1}`, 'play');
}

function deleteClip(idx) {
  const clip = state.clips[idx];
  if (!clip) return;
  // 保存到撤销栈
  state.clipsHistory.push({ id: clip.id, blob: clip.blob, url: clip.url, startTime: clip.startTime, endTime: clip.endTime });
  URL.revokeObjectURL(clip.url);
  clip.blob = null;
  state.clips.splice(idx, 1);
  const orderIdx = state.clipsOrder.indexOf(clip.id);
  if (orderIdx >= 0) state.clipsOrder.splice(orderIdx, 1);
  if (state.mixedUrl && state.clips.length > 1) {
    URL.revokeObjectURL(state.mixedUrl);
    state.mixedUrl = null;
  }
  mixClips().then(() => {
    renderClipMarkers();
    renderClipList();
    enableWhenLoaded();
    if (state.clips.length === 0) {
      stopDubMode();
      setBadge('🟢 Watch Mode', 'watch');
    }
    if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
  });
}

// ─── Audio mixing ─────────────────────────────────────────
async function mixClips() {
  if (state.clips.length === 0) {
    if (state.mixedUrl) URL.revokeObjectURL(state.mixedUrl);
    state.mixedUrl = null;
    return;
  }
  if (state.clips.length === 1) {
    const single = state.clips[0];
    // 如果 mixedUrl 已经是 WAV 格式（不是 webm blob），复用
    if (state.mixedUrl && state.mixedUrl !== single.url) {
      return;
    }
  }

  const oldMixedUrl = state.mixedUrl;
  const sampleRate = 48000;
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const bufLen = Math.ceil(video.duration * sampleRate);
  const totalBuf = audioCtx.createBuffer(1, bufLen, sampleRate);
  const channel = totalBuf.getChannelData(0);

  for (const clip of state.clips) {
    const resp = await fetch(clip.url);
    const ab = await resp.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(ab);
    const src = decoded.getChannelData(0);
    const offsetSamples = Math.round(clip.startTime * sampleRate);
    for (let i = 0; i < src.length; i++) {
      const pos = offsetSamples + i;
      if (pos >= bufLen) break;
      channel[pos] = src[i];
    }
  }

  const numSamples = totalBuf.length;
  const wav = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(wav);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  const d = totalBuf.getChannelData(0);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, d[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  const blob = new Blob([wav], { type: 'audio/wav' });
  state.mixedUrl = URL.createObjectURL(blob);
  if (oldMixedUrl) URL.revokeObjectURL(oldMixedUrl);
  audioCtx.close();
}

// ─── Dub audio management ─────────────────────────────────
function stopDubMode() {
  if (state.dubAudio) {
    state.dubAudio.pause();
    state.dubAudio.src = '';
    state.dubAudio.load();
    state.dubAudio = null;
  }
  state.dubMode = null;
  state.playingClipId = null;
}

function syncDubAudio() {
  if (!state.dubAudio || !state.dubAudio.src) return;
  // playClip 模式：视频从 clip.startTime 开始，音频从 0 开始，
  // 两者速率相同，不需要同步
  if (state.dubMode === 'playClip') return;
  // play 模式（Play Dub）：视频和音频都从 0 开始，直接比较
  const offset = video.currentTime;
  const diff = Math.abs(state.dubAudio.currentTime - offset);
  if (diff > 0.5) {
    state.dubAudio.currentTime = offset;
  }
}

// ─── Import ──────────────────────────────────────────────
function loadVideo(file) {
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
  overlay.classList.add('hidden');
  state.videoLoaded = true;
  state.videoKey = file.name;
  state.clips = [];
  state.clipsOrder = [];
  state.mixedUrl = null;
  state.loopA = -1;
  state.loopB = -1;
  state.loopEnabled = false;
  loopLabel.textContent = fmtLoop();
  renderLoopMarkers();
  renderClipMarkers();
  renderClipList();
  enableWhenLoaded();
  setBadge('🟢 Watch Mode', 'watch');
  // 视频加载完成后恢复 clips
  video.addEventListener('canplay', () => {
    restoreClips(file.name);
  }, { once: true });
}

async function restoreClips(videoKey) {
  const saved = await loadClips(videoKey);
  if (!saved || !saved.clips || saved.clips.length === 0) {
    setBadge('🟢 Watch Mode', 'watch');
    return;
  }
  for (const item of saved.clips) {
    const blob = item.data;
    const url = URL.createObjectURL(blob);
    state.clipsOrder.push(item.id);
    const idx = state.clips.findIndex(c => c.startTime > item.startTime);
    if (idx < 0) state.clips.push({ id: item.id, blob, url, startTime: item.startTime, endTime: item.endTime });
    else state.clips.splice(idx, 0, { id: item.id, blob, url, startTime: item.startTime, endTime: item.endTime });
  }
  await mixClips();
  renderClipMarkers();
  renderClipList();
  enableWhenLoaded();
  // 恢复 A/B 点
  if (saved.loopA >= 0 || saved.loopB >= 0) {
    state.loopA = saved.loopA >= 0 ? saved.loopA : -1;
    state.loopB = saved.loopB >= 0 ? saved.loopB : -1;
    if (state.loopA >= 0 && state.loopB >= 0) state.loopEnabled = true;
    loopLabel.textContent = fmtLoop();
    renderLoopMarkers();
  }
  setBadge(`💾 Restored ${saved.clips.length} clip(s)`, 'watch');
}

btnImport.addEventListener('click', () => fileInput.click());
importBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files.length) loadVideo(e.target.files[0]);
});

video.addEventListener('canplay', () => {
  enableWhenLoaded();
  timeDisplay.textContent = `00:00 / ${fmt(video.duration)}`;
  renderLoopMarkers();
  renderClipMarkers();
});

// ─── Playback controls ───────────────────────────────────
video.addEventListener('timeupdate', () => {
  if (video.duration) {
    seekBar.value = (video.currentTime / video.duration) * 1000;
    timeDisplay.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }
  if (state.loopEnabled && state.loopB >= 0 && state.loopA >= 0 && video.currentTime >= state.loopB) {
    video.currentTime = state.loopA;
    video.play();
  }
  syncDubAudio();
  // Play My Dub 模式下：在 clip 时间段内静音（听录音），之外播原声
  // muteToggle 可以覆盖：按🔊时 dubMuted=false，所有位置都不静音（对比原声）
  if (state.dubMode === 'play') {
    const inside = state.clips.some(c => video.currentTime >= c.startTime && video.currentTime < c.endTime);
    video.muted = inside && dubMuted;
  }
  renderLoopMarkers();
});

seekBar.addEventListener('input', () => {
  if (video.duration)
    video.currentTime = (seekBar.value / 1000) * video.duration;
});

video.addEventListener('pause', () => {
  if (state.dubAudio && !state.dubAudio.paused) state.dubAudio.pause();
});
video.addEventListener('play', () => {
  if (state.dubAudio && state.dubAudio.paused && state.dubAudio.readyState >= 2) {
    state.dubAudio.play().catch(() => {});
  }
});

// ─── Loop ────────────────────────────────────────────────
btnSetA.addEventListener('click', () => {
  if (state.loopA >= 0) {
    state.loopA = -1;
    state.loopEnabled = false;
    loopLabel.textContent = fmtLoop();
    renderLoopMarkers();
    if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
    return;
  }
  state.loopA = video.currentTime;
  loopLabel.textContent = fmtLoop();
  if (state.loopB >= 0) state.loopEnabled = true;
  renderLoopMarkers();
  if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
});

btnSetB.addEventListener('click', () => {
  if (state.loopB >= 0) {
    state.loopB = -1;
    state.loopEnabled = false;
    loopLabel.textContent = fmtLoop();
    renderLoopMarkers();
    if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
    return;
  }
  state.loopB = video.currentTime;
  loopLabel.textContent = fmtLoop();
  if (state.loopA >= 0) state.loopEnabled = true;
  renderLoopMarkers();
  if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
});

// ─── Clear loop ──────────────────────────────────────────
btnClearLoop.addEventListener('click', () => {
  state.loopA = -1;
  state.loopB = -1;
  state.loopEnabled = false;
  loopLabel.textContent = fmtLoop();
  renderLoopMarkers();
  renderClipList();
  video.muted = false;
  setBadge('🟢 Watch Mode', 'watch');
  if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
});

btnPlayFromA.addEventListener('click', () => {
  if (!state.videoLoaded) return;
  if (state.loopA < 0) return; // A 点没设，忽略
  video.currentTime = state.loopA;
  video.play();
});

// ─── Recording ───────────────────────────────────────────
async function startRecording() {
  if (state.recording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordedChunks = [];
    state.recordStartTime = video.currentTime;
    state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    state.mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) state.recordedChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(state.recordedChunks, { type: 'audio/webm' });
      const endTime = video.currentTime;
      const url = URL.createObjectURL(blob);
      const newClip = { id: crypto.randomUUID(), blob, url, startTime: state.recordStartTime, endTime };
      state.clipsOrder.push(newClip.id);
      const idx = state.clips.findIndex(c => c.startTime > state.recordStartTime);
      if (idx < 0) state.clips.push(newClip);
      else state.clips.splice(idx, 0, newClip);
      await mixClips();
      renderClipMarkers();
      renderClipList();
      enableWhenLoaded();
      if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
    };

    state.mediaRecorder.start();
    state.recording = true;
    setBadge('🔴 Recording...', 'rec');
  } catch (err) {
    setBadge('❌ Mic permission denied', 'watch');
    alert('无法访问麦克风，请允许麦克风权限后重试。\n' + err.message);
  }
}

function stopRecording() {
  if (!state.recording || !state.mediaRecorder) return Promise.resolve();
  return new Promise(resolve => {
    const origOnstop = state.mediaRecorder.onstop;
    state.mediaRecorder.onstop = async () => {
      if (origOnstop) await origOnstop.call(state.mediaRecorder);
      resolve();
    };
    state.mediaRecorder.stop();
    state.recording = false;
    btnDub.textContent = 'Dub';
    setBadge('🟢 Watch Mode', 'watch');
  });
}

// ─── Start Dub ──────────────────────────────────────────────
let dubKeyPressed = false;

async function startDubFrom(time) {
  if (state.recording) return;
  stopDubMode();
  state.recordStartTime = time;
  video.muted = true;
  if (video.paused) video.play();
  btnDub.textContent = '⏹ Dub';
  setBadge('🎤 Dub Mode — Recording...', 'dub');
  await startRecording();
}

async function stopDubIfRecording() {
  if (!state.recording) return;
  await stopRecording();
  video.muted = false;
  btnDub.textContent = 'Dub';
}

btnDub.addEventListener('mousedown', async () => {
  if (!state.videoLoaded) return;
  dubKeyPressed = true;
  await startDubFrom(video.currentTime);
});

document.addEventListener('mouseup', async () => {
  if (dubKeyPressed) {
    dubKeyPressed = false;
    await stopDubIfRecording();
  }
});

btnDub.addEventListener('mouseleave', async () => {
  if (dubKeyPressed) {
    dubKeyPressed = false;
    await stopDubIfRecording();
  }
});

// ─── Play My Dub ────────────────────────────────────────────
btnPlayDub.addEventListener('click', async () => {
  // 如果已经在 Play Dub 模式，切回 Watch Mode
  if (state.dubMode === 'play') {
    stopDubMode();
    video.muted = false;
    setBadge('🟢 Watch Mode', 'watch');
    btnPlayDub.textContent = '🟢 Watch Mode';
    return;
  }

  if (state.recording) {
    await stopRecording();
    video.muted = false;
  }
  stopDubMode();

  if (!state.mixedUrl) {
    video.muted = false;
    setBadge('🟢 Watch Mode', 'watch');
    btnPlayDub.textContent = '🟢 Watch Mode';
    try { await video.play(); } catch (_) {}
    return;
  }

  // 有录音 → 从当前时间开始播放配音
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = state.mixedUrl;
  audio.currentTime = video.currentTime;
  state.dubAudio = audio;
  video.muted = false;
  state.dubMode = 'play';
  setBadge('🎧 Dub Mode', 'play');
  btnPlayDub.textContent = '🎧 Dub Mode';

  const startPlayback = async () => {
    try {
      audio.volume = clipMuted ? 0 : 1;
      await audio.play();
    } catch (e) {
      setBadge('❌ Audio blocked — click again', 'watch');
      btnPlayDub.textContent = '🟢 Watch Mode';
      return;
    }
    try { await video.play(); } catch (_) {}
  };

  audio.onended = () => {
    stopDubMode();
    video.muted = false;
    setBadge('🟢 Watch Mode', 'watch');
    btnPlayDub.textContent = '🟢 Watch Mode';
  };

  if (audio.readyState >= 2) {
    await startPlayback();
  } else {
    await new Promise(resolve => {
      audio.addEventListener('canplay', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
    });
    await startPlayback();
  }
});

// ─── Keyboard ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'button', 'submit', 'checkbox', 'radio'].includes(e.target.type))) return;
  if (e.key === ' ' || e.key === 'Space') {
    e.preventDefault();
    if (video.paused) video.play();
    else video.pause();
  }
  if (e.key === 'a' || e.key === 'A') {
    if (state.videoLoaded) {
      e.preventDefault();
      btnSetA.click();
    }
  }
  if (e.key === 'f' || e.key === 'F') {
    if (state.videoLoaded) {
      e.preventDefault();
      startDubFrom(video.currentTime);
    }
  }
  if (e.key === 's' || e.key === 'S') {
    if (state.videoLoaded && state.loopA >= 0) {
      e.preventDefault();
      video.currentTime = state.loopA;
      video.play();
    }
  }
  if (e.key === 'd' || e.key === 'D') {
    if (state.clipsOrder.length > 0) {
      e.preventDefault();
      const lastId = state.clipsOrder[state.clipsOrder.length - 1];
      const idx = state.clips.findIndex(c => c.id === lastId);
      if (idx >= 0) deleteClip(idx);
    }
  }
  // W：播放刚录的 clip（逻辑和 D 一样，改为播放）
  if (e.key === 'w' || e.key === 'W') {
    if (state.clipsOrder.length > 0 && state.videoLoaded) {
      e.preventDefault();
      const lastId = state.clipsOrder[state.clipsOrder.length - 1];
      const clip = state.clips.find(c => c.id === lastId);
      if (clip) toggleClipLoop(clip);
    }
  }
  // Ctrl+Z：撤销上次删除
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    if (state.clipsHistory.length > 0) {
      e.preventDefault();
      const restored = state.clipsHistory.pop();
      // 重建 blob URL
      const url = URL.createObjectURL(restored.blob);
      restored.url = url;
      // 按时间轴插入
      const idx = state.clips.findIndex(c => c.startTime > restored.startTime);
      if (idx < 0) state.clips.push(restored);
      else state.clips.splice(idx, 0, restored);
      state.clipsOrder.push(restored.id);
      mixClips().then(() => {
        renderClipMarkers();
        renderClipList();
        enableWhenLoaded();
        if (state.videoKey) saveClips(state.videoKey, state.clips, state.loopA, state.loopB);
      });
    }
  }
  // R：切换 Play Dub / Watch Mode
  if (e.key === 'r' || e.key === 'R' && !(e.ctrlKey || e.metaKey)) {
    if (state.videoLoaded) {
      e.preventDefault();
      btnPlayDub.click();
    }
  }
  // 左右方向键：前进/后退 3 秒
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (state.videoLoaded) video.currentTime = Math.max(0, video.currentTime - 3);
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (state.videoLoaded) video.currentTime = Math.min(video.duration, video.currentTime + 3);
  }
});

document.addEventListener('keyup', e => {
  if (e.key === 'f' || e.key === 'F') {
    stopDubIfRecording();
  }
});