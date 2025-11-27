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
const CAMERA_RESOLUTION_STEPS = [
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
];
const FORCE_QUERY_PARAM = 'forceSeeker';

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
  renderSourceVideo: null,
  exportStream: null,
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
  recordBtn.addEventListener('click', async () => {
    if (state.isRecording) {
      stopRecording();
    } else {
      try {
        await startRecording();
      } catch (error) {
        showError(`Recording failed: ${error.message}`);
        console.error(error);
      }
    }
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
  const params = new URLSearchParams(window.location.search);
  if (params.get(FORCE_QUERY_PARAM) === 'true') {
    return { isSeeker: true };
  }

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
  updateMirrorState();
  startRenderer();
  setupMediaRecorder();
}

function startRenderer() {
  if (!state.renderCtx || state.animationFrameId) return;
  const draw = () => {
    const source = state.renderSourceVideo || video;
    if (!source.videoWidth) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    const width = source.videoWidth;
    const height = source.videoHeight;
    if (state.renderCanvas.width !== width || state.renderCanvas.height !== height) {
      state.renderCanvas.width = width;
      state.renderCanvas.height = height;
    }

    state.renderCtx.drawImage(source, 0, 0, width, height);
    drawOverlay(state.renderCtx, width, height);
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

  const exportSource = await createExportSource().catch(() => null);
  const source = exportSource?.video || video;
  await ensureVideoElementReady(source);

  canvas.width = source.videoWidth;
  canvas.height = source.videoHeight;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  await stampOverlay(ctx, canvas.width, canvas.height);

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

  if (exportSource) {
    releaseExportSource(exportSource);
  }
}

async function ensureVideoReady() {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise((resolve) => {
    video.addEventListener('loadeddata', resolve, { once: true });
  });
}

async function stampOverlay(context, width, height) {
  if (!watermarkLoaded) {
    await watermarkReady.catch(() => {});
  }
  drawOverlay(context, width, height);
}

function drawOverlay(context, width, height) {
  drawGradientOverlay(context, width, height);
  drawWatermarkImage(context, width, height);
}

function drawGradientOverlay(context, width, height) {
  const gradientHeight = Math.max(60, Math.round(height * (138 / 752)));
  const gradient = context.createLinearGradient(0, height - gradientHeight, 0, height);
  gradient.addColorStop(0, 'rgba(20, 63, 62, 0)');
  gradient.addColorStop(1, '#143f3e');
  context.save();
  context.fillStyle = gradient;
  context.fillRect(0, height - gradientHeight, width, gradientHeight);
  context.restore();
}

function drawWatermarkImage(context, width, height) {
  if (!watermarkLoaded || !watermarkImage.naturalWidth) return;
  const edgePadding = Math.max(16, Math.round(width * (24 / 366)));
  const desiredWidth = Math.round(width * (103 / 366));
  const ratio = watermarkImage.naturalWidth / watermarkImage.naturalHeight;
  const drawWidth = Math.min(desiredWidth, watermarkImage.naturalWidth);
  const drawHeight = drawWidth / ratio;
  context.save();
  context.globalAlpha = 0.98;
  context.drawImage(
    watermarkImage,
    edgePadding,
    height - drawHeight - edgePadding,
    drawWidth,
    drawHeight
  );
  context.restore();
}

async function startRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'recording') return;
  const exportSource = await createExportSource().catch(() => null);
  if (exportSource) {
    state.exportStream = exportSource.stream;
    state.renderSourceVideo = exportSource.video;
  } else {
    state.renderSourceVideo = null;
  }
  state.recordedChunks = [];
  startRenderer();
  state.mediaRecorder.start();
  setRecordingState(true);
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
  state.mediaRecorder.stop();
  setRecordingState(false);
  cleanupRecordingSource();
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
  cleanupRecordingSource();
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

function cleanupRecordingSource() {
  if (state.exportStream) {
    state.exportStream.getTracks().forEach((track) => track.stop());
    state.exportStream = null;
  }
  state.renderSourceVideo = null;
}

async function createExportSource() {
  const deviceId = getActiveDeviceId();
  const candidates = CAMERA_RESOLUTION_STEPS.map(({ width, height }) =>
    buildHighResolutionConstraint(width, height, deviceId)
  );

  const fallbackWidth = video.videoWidth || 1280;
  const fallbackHeight = video.videoHeight || 720;
  candidates.push(buildHighResolutionConstraint(fallbackWidth, fallbackHeight, deviceId));

  let lastError = null;
  for (const constraints of candidates) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const videoEl = document.createElement('video');
      Object.assign(videoEl, { autoplay: true, muted: true, playsInline: true });
      videoEl.srcObject = stream;
      await ensureVideoElementReady(videoEl);
      return { stream, video: videoEl };
    } catch (error) {
      lastError = error;
      console.warn('Export stream constraint failed', constraints.video, error);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to obtain a high-resolution export stream.');
}

function releaseExportSource(source) {
  source?.stream?.getTracks().forEach((track) => track.stop());
  if (source?.video) {
    source.video.srcObject = null;
  }
}

function buildHighResolutionConstraint(width, height, deviceId) {
  const videoConstraints = {
    width: { ideal: width, max: width },
    height: { ideal: height, max: height },
    facingMode: { ideal: state.facingMode },
  };
  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  }
  return {
    video: videoConstraints,
    audio: false,
  };
}

async function ensureVideoElementReady(element) {
  if (element.readyState >= 2 && element.videoWidth > 0) return;
  await new Promise((resolve) => {
    element.addEventListener('loadeddata', resolve, { once: true });
  });
  if (element.paused) {
    try {
      await element.play();
    } catch (error) {
      console.warn('Unable to autoplay export preview', error);
    }
  }
}

function updateMirrorState() {
  const shouldMirror = state.facingMode === 'user';
  video.classList.toggle('mirrored', shouldMirror);
}

function getActiveDeviceId() {
  const [track] = state.stream?.getVideoTracks() || [];
  if (!track || typeof track.getSettings !== 'function') return '';
  return track.getSettings().deviceId || '';
}
