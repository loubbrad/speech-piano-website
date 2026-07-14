const PIXELS_PER_SECOND = 58;
const PLAYHEAD_FRACTION = 0.28;
const YT_PLAYING = 1;

const elements = {
  sampleSelect: document.querySelector("#sample-select"),
  playButton: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  playLabel: document.querySelector("#play-label"),
  seek: document.querySelector("#seek"),
  currentTime: document.querySelector("#current-time"),
  duration: document.querySelector("#duration"),
  captionReadout: document.querySelector("#caption-readout"),
  speechCount: document.querySelector("#speech-count"),
  pianoCount: document.querySelector("#piano-count"),
  noteCount: document.querySelector("#note-count"),
  canvas: document.querySelector("#piano-roll"),
  keyboard: document.querySelector("#piano-keyboard"),
  pedal: document.querySelector("#piano-pedal"),
  sampleTitle: document.querySelector("#sample-title"),
  sampleChannel: document.querySelector("#sample-channel"),
  sampleRationale: document.querySelector("#sample-rationale"),
};

const state = {
  samples: [],
  sample: null,
  player: null,
  playerReady: false,
  time: 0,
  playing: false,
  activeSpeech: -1,
  activeWordKey: "",
  pedalDown: null,
};

function formatTime(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function clampTime(value) {
  return Math.max(0, Math.min(value || 0, state.sample?.duration || 0));
}

function loadYouTubeApi() {
  return new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
}

async function createPlayer() {
  await loadYouTubeApi();
  state.player = new YT.Player("youtube-player", {
    width: "100%",
    height: "100%",
    videoId: state.sample.youtubeId,
    playerVars: {
      controls: 0,
      cc_load_policy: 0,
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: () => {
        state.playerReady = true;
        elements.playButton.disabled = false;
        disableYouTubeCaptions();
      },
      onStateChange: handlePlayerState,
      onApiChange: disableYouTubeCaptions,
    },
  });
}

function disableYouTubeCaptions() {
  if (!state.player?.setOption) return;
  // YouTube has exposed the module under both names across player versions.
  for (const module of ["captions", "cc"]) {
    try {
      state.player.setOption(module, "track", {});
    } catch {
      // The module may not be loaded for videos without caption tracks.
    }
  }
}

function handlePlayerState(event) {
  state.playing = event.data === YT_PLAYING;
  disableYouTubeCaptions();
  updatePlayButton();
}

function updatePlayButton() {
  elements.playIcon.textContent = state.playing ? "❚❚" : "▶";
  elements.playLabel.textContent = state.playing ? "Pause" : "Play";
}

function togglePlayback() {
  if (!state.playerReady) return;
  if (state.playing) {
    state.player.pauseVideo();
    return;
  }
  state.player.playVideo();
}

function seekTo(seconds) {
  const time = clampTime(seconds);
  state.time = time;
  if (state.playerReady) state.player.seekTo(time, true);
  render(time);
}

function activeSpeechIndex(time) {
  return state.sample.speechSegments.findIndex(
    (segment) => time >= segment.start && time <= segment.end,
  );
}

function activeWordIndex(words, time) {
  let low = 0;
  let high = words.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle].start <= time) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate;
}

function updateCaption(time) {
  const segmentIndex = activeSpeechIndex(time);
  if (segmentIndex !== state.activeSpeech) {
    state.activeSpeech = segmentIndex;
    state.activeWordKey = "";
  }

  if (segmentIndex < 0) {
    if (state.activeWordKey !== "none") {
      elements.captionReadout.textContent = "No speech at this point.";
      state.activeWordKey = "none";
    }
    return;
  }

  const words = state.sample.speechSegments[segmentIndex].words;
  const wordIndex = activeWordIndex(words, time);
  const key = `${segmentIndex}:${wordIndex}`;
  if (key === state.activeWordKey) return;
  state.activeWordKey = key;

  const start = Math.max(0, wordIndex - 8);
  const end = Math.min(words.length, Math.max(wordIndex + 10, 18));
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index += 1) {
    const span = document.createElement("span");
    span.textContent = `${index === start ? "" : " "}${words[index].text}`;
    if (index === wordIndex) span.className = "current-word";
    fragment.appendChild(span);
  }
  elements.captionReadout.replaceChildren(fragment);
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function renderPiano(time) {
  resizeCanvas(elements.canvas);
  const canvas = elements.canvas;
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const playheadX = width * PLAYHEAD_FRACTION;
  const visibleStart = time - playheadX / PIXELS_PER_SECOND;
  const visibleEnd = time + (width - playheadX) / PIXELS_PER_SECOND;
  const pitches = state.sample.notes;
  const minPitch = Math.max(0, state.sample.minPitch - 1);
  const maxPitch = Math.min(127, state.sample.maxPitch + 1);
  const pitchSpan = Math.max(1, maxPitch - minPitch + 1);
  const rowHeight = height / pitchSpan;

  context.fillStyle = "rgba(85, 214, 168, 0.085)";
  for (const segment of state.sample.pianoSegments) {
    if (segment.end < visibleStart || segment.start > visibleEnd) continue;
    const x = playheadX + (segment.start - time) * PIXELS_PER_SECOND;
    const endX = playheadX + (segment.end - time) * PIXELS_PER_SECOND;
    context.fillRect(x, 0, endX - x, height);
  }

  context.strokeStyle = "rgba(255,255,255,0.055)";
  context.lineWidth = 1;
  for (let second = Math.ceil(visibleStart); second <= visibleEnd; second += 1) {
    const x = playheadX + (second - time) * PIXELS_PER_SECOND;
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, 0);
    context.lineTo(Math.round(x) + 0.5, height);
    context.stroke();
  }

  for (let pitch = minPitch; pitch <= maxPitch; pitch += 1) {
    if (pitch % 12 !== 0) continue;
    const y = (maxPitch - pitch) * rowHeight;
    context.fillStyle = "rgba(255,255,255,0.035)";
    context.fillRect(0, y, width, rowHeight);
  }

  for (const note of pitches) {
    if (note.end < visibleStart || note.start > visibleEnd) continue;
    const x = playheadX + (note.start - time) * PIXELS_PER_SECOND;
    const noteWidth = Math.max(2, (note.end - note.start) * PIXELS_PER_SECOND - 1);
    const y = (maxPitch - note.pitch) * rowHeight;
    const velocityAlpha = 0.45 + (note.velocity / 127) * 0.5;
    context.fillStyle = `rgba(85, 214, 168, ${velocityAlpha})`;
    context.fillRect(x, y + 0.5, noteWidth, Math.max(1.5, rowHeight - 1));
  }

  context.strokeStyle = "#fff";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, height);
  context.stroke();
}

function isWhiteKey(pitch) {
  return [0, 2, 4, 5, 7, 9, 11].includes(pitch % 12);
}

function renderKeyboard(time) {
  const canvas = elements.keyboard;
  resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const activePitches = new Set();
  for (const note of state.sample.notes) {
    if (note.start > time) break;
    if (note.end >= time) activePitches.add(note.pitch);
  }

  const firstPitch = 21; // A0
  const lastPitch = 108; // C8
  const whiteKeyCount = 52;
  const whiteWidth = width / whiteKeyCount;
  const blackWidth = Math.max(3, whiteWidth * 0.62);
  const blackHeight = height * 0.62;
  let whiteIndex = 0;

  context.fillStyle = "#090b0d";
  context.fillRect(0, 0, width, height);

  for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
    if (!isWhiteKey(pitch)) continue;
    const x = whiteIndex * whiteWidth;
    const active = activePitches.has(pitch);
    const press = active ? 3 : 0;
    context.fillStyle = active ? "#e34b52" : "#e7e7e3";
    context.fillRect(x + 0.5, press, Math.max(1, whiteWidth - 1), height - press - 1);
    context.strokeStyle = active ? "#ff7479" : "#33383d";
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, press + 0.5, Math.max(1, whiteWidth - 1), height - press - 1);
    if (active) {
      context.fillStyle = "rgba(75, 0, 5, 0.2)";
      context.fillRect(x + 1, height - 7, Math.max(1, whiteWidth - 2), 5);
    }
    whiteIndex += 1;
  }

  // Black keys sit over the gap immediately after their preceding white key.
  whiteIndex = 0;
  for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
    if (isWhiteKey(pitch)) {
      whiteIndex += 1;
      continue;
    }
    const x = whiteIndex * whiteWidth - blackWidth / 2;
    const active = activePitches.has(pitch);
    const press = active ? 3 : 0;
    context.fillStyle = active ? "#b92734" : "#15191c";
    context.fillRect(x, press, blackWidth, blackHeight - press);
    context.strokeStyle = active ? "#f05b64" : "#020304";
    context.strokeRect(x + 0.5, press + 0.5, blackWidth - 1, blackHeight - press - 1);
    context.fillStyle = active ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.06)";
    context.fillRect(x + 1, press + 1, Math.max(1, blackWidth - 2), 2);
  }

  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.beginPath();
  context.moveTo(0, 0.5);
  context.lineTo(width, 0.5);
  context.stroke();
}

function updatePedal(time) {
  const pedalDown = state.sample.pedalSegments.some(
    (segment) => time >= segment.start && time < segment.end,
  );
  if (pedalDown === state.pedalDown) return;
  state.pedalDown = pedalDown;
  elements.pedal.classList.toggle("active", pedalDown);
  elements.pedal.setAttribute(
    "aria-label",
    pedalDown ? "Sustain pedal pressed" : "Sustain pedal released",
  );
}

function render(time) {
  if (!state.sample) return;
  state.time = clampTime(time);
  updateCaption(state.time);
  renderPiano(state.time);
  renderKeyboard(state.time);
  updatePedal(state.time);
  elements.currentTime.textContent = formatTime(state.time);
  if (document.activeElement !== elements.seek) elements.seek.value = String(state.time);
}

function animationFrame() {
  if (state.playerReady && state.sample) {
    const playerTime = clampTime(state.player.getCurrentTime());
    render(playerTime);
  }
  requestAnimationFrame(animationFrame);
}

function enrichSample(sample) {
  const pitchValues = sample.notes.map((note) => note.pitch);
  sample.minPitch = Math.min(...pitchValues);
  sample.maxPitch = Math.max(...pitchValues);
  return sample;
}

function selectSample(index) {
  const sample = state.samples[index];
  if (!sample) return;
  state.player?.pauseVideo();
  state.sample = sample;
  state.time = 0;
  state.playing = false;
  state.activeSpeech = -1;
  state.activeWordKey = "";
  state.pedalDown = null;
  if (state.playerReady) state.player.cueVideoById(sample.youtubeId, 0);

  elements.seek.max = String(sample.duration);
  elements.seek.value = "0";
  elements.duration.textContent = formatTime(sample.duration);
  elements.speechCount.textContent = sample.speechSegments.length.toLocaleString();
  elements.pianoCount.textContent = sample.pianoSegments.length.toLocaleString();
  elements.noteCount.textContent = sample.notes.length.toLocaleString();
  elements.sampleTitle.textContent = sample.title;
  elements.sampleChannel.textContent = sample.channel;
  elements.sampleRationale.textContent = sample.rationale;
  updatePlayButton();
  render(0);
}

async function init() {
  // Resolve from this module so both the root Pages entry point and /src/
  // development page load the same prepared data.
  const datasetUrl = new URL("./data/dataset.json", import.meta.url);
  const response = await fetch(datasetUrl);
  if (!response.ok) throw new Error(`Could not load dataset: HTTP ${response.status}`);
  const dataset = await response.json();
  state.samples = dataset.samples.map(enrichSample);
  for (const [index, sample] of state.samples.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${sample.title} — ${sample.channel}`;
    elements.sampleSelect.appendChild(option);
  }
  selectSample(0);
  await createPlayer();
}

elements.sampleSelect.addEventListener("change", (event) => {
  selectSample(Number(event.target.value));
});
elements.playButton.addEventListener("click", togglePlayback);
elements.seek.addEventListener("input", (event) => seekTo(Number(event.target.value)));
window.addEventListener("resize", () => render(state.time));
window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !["INPUT", "SELECT", "BUTTON"].includes(event.target.tagName)) {
    event.preventDefault();
    togglePlayback();
  }
});

init().catch((error) => {
  console.error(error);
  elements.sampleTitle.textContent = "Unable to load the demo";
  elements.sampleRationale.textContent = error.message;
});
requestAnimationFrame(animationFrame);
