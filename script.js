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
const viewbox = document.querySelector('.viewbox');

const SEEKER_KEYWORDS = ['seeker', 'solana mobile', 'solanamobile', 'solana-mobile', 'sm-skr', 'skr'];
const FORCE_QUERY_PARAM = 'forceSeeker';

const MAX_RENDER_WIDTH = 2560;
const MAX_RENDER_HEIGHT = 2560;
const cropCache = {
  videoWidth: 0,
  videoHeight: 0,
  viewWidth: 0,
  viewHeight: 0,
  value: null,
};

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
video.addEventListener('loadedmetadata', syncViewboxAspect);
video.addEventListener('resize', syncViewboxAspect);
function handleViewportChange() {
  clearCropCache();
  syncViewboxAspect();
}

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
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('orientationchange', handleViewportChange);
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

  const stream = await openCameraStream();

  state.stream = stream;
  video.srcObject = stream;
  await maximizeTrackResolution(stream);
  await ensureVideoReady();
  syncViewboxAspect();
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

    const crop = getViewportCrop();
    const sourceX = crop?.cropX ?? 0;
    const sourceY = crop?.cropY ?? 0;
    const sourceWidth = crop?.cropWidth ?? video.videoWidth;
    const sourceHeight = crop?.cropHeight ?? video.videoHeight;
    const outputWidth = crop?.outputWidth ?? video.videoWidth;
    const outputHeight = crop?.outputHeight ?? video.videoHeight;

    if (
      state.renderCanvas.width !== outputWidth ||
      state.renderCanvas.height !== outputHeight
    ) {
      state.renderCanvas.width = outputWidth;
      state.renderCanvas.height = outputHeight;
    }

    state.renderCtx.clearRect(0, 0, outputWidth, outputHeight);
    state.renderCtx.drawImage(
      video,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      outputWidth,
      outputHeight
    );
    drawOverlay(state.renderCtx, outputWidth, outputHeight);
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

  const crop = getViewportCrop();
  if (crop) {
    canvas.width = crop.outputWidth;
    canvas.height = crop.outputHeight;
    ctx.drawImage(
      video,
      crop.cropX,
      crop.cropY,
      crop.cropWidth,
      crop.cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
  } else {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
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
}

async function ensureVideoReady() {
  if (video.readyState >= 2 && video.videoWidth > 0) {
    syncViewboxAspect();
    return;
  }
  await new Promise((resolve) => {
    video.addEventListener(
      'loadeddata',
      () => {
        syncViewboxAspect();
        resolve();
      },
      { once: true }
    );
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

async function openCameraStream() {
  const candidates = buildCameraConstraintSets();
  let lastError = null;

  for (const constraints of candidates) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      console.warn('Camera constraint attempt failed', error);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to access the camera with the requested constraints');
}

function buildCameraConstraintSets() {
  const facingMode = { ideal: state.facingMode };
  const resolutionHints = createResolutionHints();

  return [
    {
      video: {
        facingMode,
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        advanced: resolutionHints,
      },
      audio: true,
    },
    {
      video: {
        facingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: true,
    },
    {
      video: { facingMode },
      audio: true,
    },
  ];
}

function createResolutionHints() {
  const presets = [
    { width: 2560, height: 1440 },
    { width: 1920, height: 1080 },
    { width: 1600, height: 900 },
    { width: 1280, height: 720 },
  ];

  return presets.flatMap(({ width, height }) => [
    { width, height },
    { width: height, height: width },
  ]);
}

async function maximizeTrackResolution(stream) {
  const [videoTrack] = stream.getVideoTracks();
  if (!videoTrack?.getCapabilities || !videoTrack.applyConstraints) return;
  const capabilities = videoTrack.getCapabilities();
  const maxWidth = capabilities.width?.max;
  const maxHeight = capabilities.height?.max;
  if (!maxWidth || !maxHeight) return;
  const targetWidth = Math.min(maxWidth, MAX_RENDER_WIDTH);
  const targetHeight = Math.min(maxHeight, MAX_RENDER_HEIGHT);
  if (!targetWidth || !targetHeight) return;

  try {
    await videoTrack.applyConstraints({
      width: { ideal: targetWidth, max: targetWidth },
      height: { ideal: targetHeight, max: targetHeight },
    });
  } catch (error) {
    console.warn('Unable to maximize camera resolution', error);
  }
}

function syncViewboxAspect() {
  clearCropCache();
  if (!viewbox) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  viewbox.style.setProperty('--camera-aspect', `${width} / ${height}`);
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

function getViewportCrop() {
  if (!viewbox) return null;
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight) return null;

  const viewWidth = viewbox.clientWidth;
  const viewHeight = viewbox.clientHeight;
  if (!viewWidth || !viewHeight) return null;

  const cacheHit =
    cropCache.value &&
    cropCache.videoWidth === videoWidth &&
    cropCache.videoHeight === videoHeight &&
    cropCache.viewWidth === viewWidth &&
    cropCache.viewHeight === viewHeight;

  if (cacheHit) {
    return cropCache.value;
  }

  const widthRatio = viewWidth / videoWidth;
  const heightRatio = viewHeight / videoHeight;
  const scale = Math.max(widthRatio, heightRatio);

  const cropWidth = viewWidth / scale;
  const cropHeight = viewHeight / scale;
  const cropX = (videoWidth - cropWidth) / 2;
  const cropY = (videoHeight - cropHeight) / 2;

  const maxScale = Math.min(
    1,
    MAX_RENDER_WIDTH / cropWidth,
    MAX_RENDER_HEIGHT / cropHeight
  );
  const outputWidth = Math.max(1, Math.round(cropWidth * maxScale));
  const outputHeight = Math.max(1, Math.round(cropHeight * maxScale));
  const normalized = {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    outputWidth,
    outputHeight,
  };

  cropCache.value = normalized;
  cropCache.videoWidth = videoWidth;
  cropCache.videoHeight = videoHeight;
  cropCache.viewWidth = viewWidth;
  cropCache.viewHeight = viewHeight;

  return normalized;
}

function clearCropCache() {
  cropCache.value = null;
  cropCache.videoWidth = 0;
  cropCache.videoHeight = 0;
  cropCache.viewWidth = 0;
  cropCache.viewHeight = 0;
}
