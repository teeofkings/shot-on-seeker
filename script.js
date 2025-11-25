const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const captureBtn = document.getElementById('capture');
const recordBtn = document.getElementById('record');
const switchBtn = document.getElementById('switch-camera');
const recordLabel = document.querySelector('[data-record-label]');
const cameraPage = document.getElementById('camera-page');
const gate = document.getElementById('seeker-gate');
const permissionError = document.getElementById('permission-error');

const SEEKER_KEYWORDS = ['seeker', 'solana mobile', 'solanamobile', 'solana-mobile', 'sm-skr', 'skr'];

const state = {
  mediaRecorder: null,
  recordedChunks: [],
  stream: null,
  mixedStream: null,
  canvasStream: null,
  facingMode: 'environment',
  isRecording: false,
  animationFrameId: null,
  renderCanvas: document.createElement('canvas'),
  renderCtx: null,
  isSeekerDevice: false,
};

state.renderCtx = state.renderCanvas.getContext('2d', { alpha: true });

const watermarkImage = new Image();
watermarkImage.src = 'watermark.png';
let watermarkReady = null;
let watermarkLoaded = false;

if ('decode' in watermarkImage) {
  watermarkReady = watermarkImage
    .decode()
    .then(() => {
      watermarkLoaded = true;
    })
    .catch(() => {});
} else {
  watermarkReady = new Promise((resolve) => {
    watermarkImage.onload = () => {
      watermarkLoaded = true;
      resolve();
    };
    watermarkImage.onerror = resolve;
  });
}

init();

function bindUIEvents() {
  captureBtn.addEventListener('click', handleCapture);
  recordBtn.addEventListener('click', () => {
    state.isRecording ? stopRecording() : startRecording();
  });
  switchBtn.addEventListener('click', switchCamera);
  window.addEventListener('beforeunload', shutdownStream);
}

async function init() {
  bindUIEvents();
  setRecordingState(false);
  recordBtn.disabled = true;

  const detection = await detectSeekerDevice();
  state.isSeekerDevice = detection.isSeeker;
  if (!state.isSeekerDevice) {
    gate.classList.remove('hidden');
    cameraPage.classList.add('hidden');
    return;
  }

  gate.classList.add('hidden');
  cameraPage.classList.remove('hidden');

  try {
    await startCamera();
  } catch (error) {
    showError(`Camera error: ${error.message}`);
    console.error(error);
  }
}

async function detectSeekerDevice() {
  const hintString = await collectUserAgentHints();
  const keyword = SEEKER_KEYWORDS.find((needle) => hintString.includes(needle));
  return { isSeeker: Boolean(keyword) };
}

async function collectUserAgentHints() {
  const hints = [];
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua) hints.push(ua);

  const platform = (navigator.platform || '').toLowerCase();
  if (platform) hints.push(platform);

  const uaData = navigator.userAgentData;
  if (uaData) {
    const brands = uaData.brands || uaData.fullVersionList;
    if (Array.isArray(brands)) {
      hints.push(
        brands
          .map((entry) => (entry.brand || '').toLowerCase())
          .filter(Boolean)
          .join(' ')
      );
    }
    if (typeof uaData.getHighEntropyValues === 'function') {
      try {
        const values = await uaData.getHighEntropyValues(['platform', 'model']);
        ['platform', 'model'].forEach((key) => {
          if (values?.[key]) {
            hints.push(String(values[key]).toLowerCase());
          }
        });
      } catch (error) {
        console.warn('High-entropy UA lookup failed', error);
      }
    }
  }

  return hints.join(' ');
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not supported in this browser');
  }

  clearError();
  stopRenderer();
  shutdownStream();

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: state.facingMode } },
    audio: true,
  });

  state.stream = stream;
  video.srcObject = stream;
  await ensureVideoReady();
  startRenderer();
  setupMediaRecorder();
}

function startRenderer() {
  if (!state.renderCtx) return;
  const draw = () => {
    if (!video.videoWidth) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (state.renderCanvas.width !== width || state.renderCanvas.height !== height) {
      state.renderCanvas.width = width;
      state.renderCanvas.height = height;
    }

    state.renderCtx.drawImage(video, 0, 0, width, height);
    drawWatermark(state.renderCtx, width, height);
    state.animationFrameId = requestAnimationFrame(draw);
  };

  draw();
}

function stopRenderer() {
  if (state.animationFrameId) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }
}

function setupMediaRecorder() {
  if (typeof MediaRecorder === 'undefined') {
    recordBtn.disabled = true;
    showError('Recording is unavailable in this browser.');
    return;
  }

  if (!state.stream) return;

  const canvasStream = state.renderCanvas.captureStream(30);
  const mixedStream = new MediaStream();
  const [videoTrack] = canvasStream.getVideoTracks();
  if (videoTrack) mixedStream.addTrack(videoTrack);
  state.stream
    .getAudioTracks()
    .forEach((track) => mixedStream.addTrack(track));

  const mimeType = getSupportedMimeType();
  state.mediaRecorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);
  state.canvasStream = canvasStream;
  state.mixedStream = mixedStream;
  recordBtn.disabled = false;

  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      state.recordedChunks.push(event.data);
    }
  };

  state.mediaRecorder.onstop = () => {
    if (!state.recordedChunks.length) return;
    const blob = new Blob(state.recordedChunks, {
      type: state.mediaRecorder.mimeType || 'video/webm',
    });
    state.recordedChunks = [];
    downloadBlob(blob, `seeker-video-${timestamp()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
  };
}

function getSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

async function handleCapture() {
  if (cameraPage.classList.contains('hidden')) return;
  await ensureVideoReady();

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  await stampWatermark(ctx, canvas.width, canvas.height);

  await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Unable to export capture.'));
          return;
        }
        downloadBlob(blob, `seeker-photo-${timestamp()}.png`);
        resolve();
      },
      'image/png',
      0.95
    );
  });
}

async function ensureVideoReady() {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise((resolve) => {
    video.addEventListener('loadeddata', resolve, { once: true });
  });
}

async function stampWatermark(context, width, height) {
  if (!watermarkLoaded) {
    await watermarkReady.catch(() => {});
  }
  drawWatermark(context, width, height);
}

function drawWatermark(context, width, height) {
  if (!watermarkLoaded || !watermarkImage.naturalWidth) return;
  const margin = Math.round(width * 0.03);
  const maxWidth = width * 0.3;
  const ratio = watermarkImage.naturalWidth / watermarkImage.naturalHeight;
  const drawWidth = Math.min(maxWidth, watermarkImage.naturalWidth);
  const drawHeight = drawWidth / ratio;
  context.save();
  context.globalAlpha = 0.95;
  context.drawImage(
    watermarkImage,
    width - drawWidth - margin,
    height - drawHeight - margin,
    drawWidth,
    drawHeight
  );
  context.restore();
}

function startRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'recording') return;
  state.recordedChunks = [];
  state.mediaRecorder.start();
  setRecordingState(true);
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
  state.mediaRecorder.stop();
  setRecordingState(false);
}

function setRecordingState(isRecording) {
  state.isRecording = isRecording;
  recordBtn.classList.toggle('recording', isRecording);
  if (recordLabel) {
    recordLabel.textContent = isRecording ? 'Stop' : 'Record';
  }
}

async function switchCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  if (state.isRecording) {
    stopRecording();
  }
  switchBtn.disabled = true;
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  try {
    await startCamera();
  } catch (error) {
    showError(`Unable to switch camera: ${error.message}`);
    console.error(error);
  } finally {
    switchBtn.disabled = false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  requestAnimationFrame(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function showError(message) {
  if (!permissionError) return;
  permissionError.textContent = message;
  permissionError.classList.remove('hidden');
}

function clearError() {
  if (!permissionError) return;
  permissionError.textContent = '';
  permissionError.classList.add('hidden');
}

function shutdownStream() {
  stopRenderer();
  if (state.isRecording) {
    try {
      state.mediaRecorder?.stop();
    } catch (error) {
      console.warn('Recorder stop failed during shutdown', error);
    }
    state.isRecording = false;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  if (state.canvasStream) {
    state.canvasStream.getTracks().forEach((track) => track.stop());
    state.canvasStream = null;
  }
  if (state.mixedStream) {
    state.mixedStream.getTracks().forEach((track) => track.stop());
    state.mixedStream = null;
  }
  state.mediaRecorder = null;
  state.recordedChunks = [];
}
