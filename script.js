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
const exportPage = document.getElementById('export-page');
const exportPreview = document.querySelector('[data-export-preview]');
const exportShareBtn = document.getElementById('export-share');
const exportSaveBtn = document.getElementById('export-save');
const exportRetakeBtn = document.getElementById('export-retake');
const liveWatermark = document.getElementById('live-watermark');
const recordIcon = document.querySelector('[data-record-icon]');

const SEEKER_KEYWORDS = ['seeker', 'solana mobile', 'solanamobile', 'solana-mobile', 'sm-skr', 'skr'];
const FORCE_QUERY_PARAM = 'forceSeeker';
const CAMERA_KEYWORDS = {
  environment: ['main', 'wide', 'ois', '108', 'back 0', 'camera 0'],
  user: ['front', 'selfie'],
};
const SHARE_TARGET_WIDTH = 480;
const SHARE_TARGET_HEIGHT = 640;
const SHARE_CAPTURE_FPS = 24;
const EXPORT_SCALE = 3;
const RECORDING_SCALE = 2;
const RENDER_FPS = 30;
const VIDEO_BITRATE = 6_000_000;
const SHARE_VIDEO_BITRATE = 5_000_000;
const PREVIEW_FILTERS = {
  environment: 'brightness(1.05) contrast(0.95)',
  user: 'brightness(1.1) contrast(0.88)',
};
const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

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
  shareCanvas: null,
  shareCtx: null,
  shareRecorder: null,
  shareChunks: [],
  shareStream: null,
  shareVideoStream: null,
  shareRecorderActive: false,
  shareFallbackPending: false,
  pendingShareBlob: null,
  activeOverlayMode: 'environment',
};

let watermarkMetrics = null;
let watermarkMetricsDirty = true;
const cachedDeviceIds = {
  environment: null,
  user: null,
};

const exportState = {
  type: '',
  originalBlob: null,
  shareBlob: null,
  originalName: '',
  shareName: '',
  previewUrl: '',
};

state.renderCtx = state.renderCanvas.getContext('2d', { alpha: true });
if (document.body) {
  document.body.classList.add('back-camera');
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
setupExportControls();

function bindUIEvents() {
  captureBtn.addEventListener('click', handleCapture);
  recordBtn.addEventListener('click', async () => {
    if (state.isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  });
  switchBtn.addEventListener('click', switchCamera);
  window.addEventListener('beforeunload', shutdownStream);
  video.addEventListener('loadedmetadata', handleVideoMetadata);
  window.addEventListener('resize', invalidateWatermarkMetrics);
  window.addEventListener('orientationchange', invalidateWatermarkMetrics);
}

function setupExportControls() {
  exportShareBtn?.addEventListener('click', () => handleExportAction('share'));
  exportSaveBtn?.addEventListener('click', () => handleExportAction('original'));
  exportRetakeBtn?.addEventListener('click', hideExportScreen);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !exportPage.classList.contains('hidden')) {
      hideExportScreen();
    }
  });
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

  const videoConstraints = await buildVideoConstraints();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: true,
  });

  state.stream = stream;
  const [videoTrack] = stream.getVideoTracks();
  if (videoTrack && 'contentHint' in videoTrack) {
    try {
      videoTrack.contentHint = 'motion';
    } catch (error) {
      console.warn('Unable to set contentHint', error);
    }
  }
  video.srcObject = stream;
  await ensureVideoReady();
  updateMirrorState();
  syncViewboxAspect();
  setupMediaRecorder();
}

async function buildVideoConstraints() {
  const mode = state.facingMode === 'environment' ? 'environment' : 'user';
  const base = getBaseVideoSettings(mode);
  const cachedId = cachedDeviceIds[mode];
  if (cachedId) {
    return {
      ...base,
      deviceId: { exact: cachedId },
    };
  }
  if (mode !== 'environment') {
    return {
      ...base,
      facingMode: { ideal: 'user' },
    };
  }
  try {
    const mainCamId = await getMainBackCameraDeviceId();
    if (mainCamId) {
      cachedDeviceIds.environment = mainCamId;
      return {
        ...base,
        deviceId: { exact: mainCamId },
      };
    }
  } catch (error) {
    console.warn('Main camera detection failed', error);
  }
  return {
    ...base,
    facingMode: { ideal: 'environment' },
  };
}

async function getMainBackCameraDeviceId() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((device) => device.kind === 'videoinput');
  if (!videoInputs.length) return null;

  const keywords = CAMERA_KEYWORDS.environment;
  const keywordMatch = videoInputs.find((device) =>
    keywords.some((keyword) => (device.label || '').toLowerCase().includes(keyword))
  );
  if (keywordMatch) return keywordMatch.deviceId;

  const backCams = videoInputs
    .filter((device) => (device.label || '').toLowerCase().includes('back'))
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  if (backCams.length) return backCams[0].deviceId;

  return videoInputs[0].deviceId;
}

function getBaseVideoSettings(mode) {
  if (mode === 'environment') {
    return {
      width: { ideal: 2560, max: 3840 },
      height: { ideal: 1440, max: 2160 },
      frameRate: { ideal: 24, max: 30 },
      advanced: [{ zoom: 1 }],
    };
  }
  return {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 24, max: 30 },
  };
}

function startRenderer() {
  if (!state.renderCtx || state.animationFrameId) return;
  const minInterval = 1000 / RENDER_FPS;
  let lastFrameTime = 0;
  const draw = (timestamp = performance.now()) => {
    if (!video.videoWidth) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }
    if (timestamp - lastFrameTime < minInterval) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }
    lastFrameTime = timestamp;

    const baseSize = getTargetDimensions();
    if (!baseSize.width || !baseSize.height) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    const hiSize = getHiResDimensions(baseSize.width, baseSize.height, RECORDING_SCALE);
    if (state.renderCanvas.width !== hiSize.width || state.renderCanvas.height !== hiSize.height) {
      state.renderCanvas.width = hiSize.width;
      state.renderCanvas.height = hiSize.height;
    }

    state.renderCtx.clearRect(0, 0, hiSize.width, hiSize.height);
    drawVideoToContext(state.renderCtx, video, hiSize.width, hiSize.height);
    drawOverlay(state.renderCtx, hiSize.width, hiSize.height, state.activeOverlayMode);
    if (state.shareRecorderActive && state.shareCtx && state.shareCanvas) {
      drawShareFrame();
    }
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

  const previewSize = getTargetDimensions();
  if (previewSize.width && previewSize.height) {
    const hiSize = getHiResDimensions(previewSize.width, previewSize.height, RECORDING_SCALE);
    if (hiSize.width && hiSize.height) {
      state.renderCanvas.width = hiSize.width;
      state.renderCanvas.height = hiSize.height;
    }
  }

  const canvasStream = state.renderCanvas.captureStream(RENDER_FPS);
  const mixedStream = new MediaStream();
  const [videoTrack] = canvasStream.getVideoTracks();
  if (videoTrack) mixedStream.addTrack(videoTrack);
  state.stream
    .getAudioTracks()
    .forEach((track) => mixedStream.addTrack(track));

  const recorderOptions = buildRecorderOptions('main');
  try {
    state.mediaRecorder = new MediaRecorder(mixedStream, recorderOptions);
  } catch (error) {
    console.warn('Primary recorder fallback to default configuration', error);
    state.mediaRecorder = new MediaRecorder(mixedStream);
  }
  state.canvasStream = canvasStream;
  state.mixedStream = mixedStream;
  recordBtn.disabled = false;

  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      state.recordedChunks.push(event.data);
    }
  };

  state.mediaRecorder.onstop = async () => {
    if (!state.recordedChunks.length) return;
    const blob = new Blob(state.recordedChunks, {
      type: state.mediaRecorder.mimeType || 'video/webm',
    });
    state.recordedChunks = [];
    const previewUrl = URL.createObjectURL(blob);
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const baseName = `seeker-video-${timestamp()}.${extension}`;
    showExportScreen({
      type: 'video',
      previewUrl,
      originalBlob: blob,
      shareBlob: null,
      originalName: baseName,
      shareName: baseName.replace(`.${extension}`, `-x.${extension}`),
      mimeType: blob.type,
    });
    if (state.shareFallbackPending) {
      prepareShareVideoBlob(blob, previewUrl);
      state.shareFallbackPending = false;
    }
  };
}

function getSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return VIDEO_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function buildRecorderOptions(kind = 'main') {
  const options = {};
  const mimeType = getSupportedMimeType();
  if (mimeType) {
    options.mimeType = mimeType;
  }
  const bitrate = kind === 'share' ? SHARE_VIDEO_BITRATE : VIDEO_BITRATE;
  if (bitrate) {
    options.bitsPerSecond = bitrate;
  }
  return options;
}

async function handleCapture() {
  if (cameraPage.classList.contains('hidden')) return;
  await ensureVideoReady();

  const baseSize = getTargetDimensions();
  if (!baseSize.width || !baseSize.height) {
    showError('Capture unavailable: invalid viewbox size.');
    return;
  }

  const hiSize = getHiResDimensions(baseSize.width, baseSize.height);
  const hiCanvas = document.createElement('canvas');
  hiCanvas.width = hiSize.width;
  hiCanvas.height = hiSize.height;
  const hiCtx = hiCanvas.getContext('2d');
  drawVideoToContext(hiCtx, video, hiSize.width, hiSize.height);
  await stampOverlay(hiCtx, hiSize.width, hiSize.height, state.facingMode);

  const originalBlob = await canvasToBlob(hiCanvas);
  const shareBlob = (await createSharePhotoBlob(hiCanvas)) || originalBlob;
  const previewUrl = URL.createObjectURL(originalBlob);
  const baseName = `seeker-photo-${timestamp()}.png`;

  showExportScreen({
    type: 'photo',
    previewUrl,
    originalBlob,
    shareBlob,
    originalName: baseName,
    shareName: baseName.replace('.png', '-x.png'),
  });
}

async function ensureVideoReady() {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise((resolve) => {
    video.addEventListener('loadeddata', resolve, { once: true });
  });
}

async function stampOverlay(context, width, height, facingMode = state.activeOverlayMode || state.facingMode) {
  if (!watermarkLoaded) {
    await watermarkReady.catch(() => {});
  }
  drawOverlay(context, width, height, facingMode);
}

function drawOverlay(context, width, height, facingMode = state.activeOverlayMode || state.facingMode) {
  drawGradientOverlay(context, width, height, facingMode);
  drawWatermarkImage(context, width, height, facingMode);
}

function drawGradientOverlay(context, width, height, facingMode = state.activeOverlayMode || state.facingMode) {
  const gradientHeight = Math.max(60, Math.round(height * (138 / 752)));
  const gradient = context.createLinearGradient(0, height - gradientHeight, 0, height);
  if (facingMode === 'user') {
    gradient.addColorStop(0, 'rgba(3, 3, 3, 0)');
    gradient.addColorStop(1, 'rgba(6, 6, 6, 0.55)');
  } else {
    gradient.addColorStop(0, 'rgba(20, 63, 62, 0)');
    gradient.addColorStop(1, '#143f3e');
  }
  context.save();
  context.fillStyle = gradient;
  context.fillRect(0, height - gradientHeight, width, gradientHeight);
  context.restore();
}

function drawWatermarkImage(context, width, height, facingMode = state.activeOverlayMode || state.facingMode) {
  if (!watermarkLoaded || !watermarkImage.naturalWidth) return;
  const ratio = watermarkImage.naturalWidth / watermarkImage.naturalHeight;
  const metrics = ensureWatermarkMetrics();
  context.save();
  context.globalAlpha = facingMode === 'user' ? 1 : 0.98;
  if (metrics) {
    const drawWidth = width * metrics.widthRatio;
    const drawHeight = drawWidth / ratio;
    const drawX = width * metrics.leftRatio;
    const bottomPadding = height * metrics.bottomRatio;
    const drawY = height - drawHeight - bottomPadding;
    context.drawImage(watermarkImage, drawX, drawY, drawWidth, drawHeight);
  } else {
    const edgePadding = Math.max(16, Math.round(width * (24 / 366)));
    const desiredWidth = Math.round(width * (103 / 366));
    const drawWidth = Math.min(desiredWidth, watermarkImage.naturalWidth);
    const drawHeight = drawWidth / ratio;
    context.drawImage(
      watermarkImage,
      edgePadding,
      height - drawHeight - edgePadding,
      drawWidth,
      drawHeight
    );
  }
  context.restore();
}

function ensureWatermarkMetrics() {
  if (!watermarkMetricsDirty && watermarkMetrics) {
    return watermarkMetrics;
  }
  if (!viewbox || !liveWatermark || cameraPage.classList.contains('hidden')) {
    return watermarkMetrics;
  }
  const viewboxRect = viewbox.getBoundingClientRect();
  const watermarkRect = liveWatermark.getBoundingClientRect();
  if (!viewboxRect.width || !viewboxRect.height || !watermarkRect.width || !watermarkRect.height) {
    return watermarkMetrics;
  }
  watermarkMetrics = {
    widthRatio: watermarkRect.width / viewboxRect.width,
    leftRatio: (watermarkRect.left - viewboxRect.left) / viewboxRect.width,
    bottomRatio: (viewboxRect.bottom - watermarkRect.bottom) / viewboxRect.height,
  };
  watermarkMetricsDirty = false;
  return watermarkMetrics;
}

function invalidateWatermarkMetrics() {
  watermarkMetricsDirty = true;
}

function syncViewboxAspect() {
  if (!viewbox || !video?.videoWidth || !video?.videoHeight) return;
  viewbox.style.setProperty('--camera-aspect', `${video.videoWidth} / ${video.videoHeight}`);
}

function handleVideoMetadata() {
  syncViewboxAspect();
  invalidateWatermarkMetrics();
}

async function startRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'recording') return;
  await ensureVideoReady();
  state.recordedChunks = [];
  const shareReady = setupShareRecording();
  state.shareFallbackPending = !shareReady;
  state.activeOverlayMode = state.facingMode;
  startRenderer();
  state.mediaRecorder.start();
  if (shareReady && state.shareRecorder) {
    try {
      state.shareRecorder.start();
      state.shareRecorderActive = true;
    } catch (error) {
      console.warn('Unable to start share recorder', error);
      cleanupShareRecording();
      state.shareFallbackPending = true;
    }
  }
  setRecordingState(true);
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
  state.mediaRecorder.stop();
  if (state.shareRecorder && state.shareRecorder.state === 'recording') {
    try {
      state.shareRecorder.stop();
    } catch (error) {
      console.warn('Unable to stop share recorder', error);
    }
  }
  setRecordingState(false);
  stopRenderer();
}

function setRecordingState(isRecording) {
  state.isRecording = isRecording;
  recordBtn.classList.toggle('recording', isRecording);
  if (recordLabel) {
    recordLabel.textContent = isRecording ? 'Stop' : 'Record';
  }
  if (recordIcon) {
    recordIcon.src = isRecording ? 'icons/camcorder_off_line.svg' : 'icons/camcorder_line.svg';
    recordIcon.alt = isRecording ? 'Stop recording' : 'Start recording';
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

function showExportScreen(config) {
  exportState.type = config.type;
  exportState.originalBlob = config.originalBlob;
  exportState.shareBlob = config.shareBlob || null;
  exportState.originalName = config.originalName;
  exportState.shareName = config.shareName || '';
  exportState.previewUrl = config.previewUrl;
  exportState.mimeType = config.mimeType || '';

  if (!exportState.shareBlob && exportState.type === 'video' && state.pendingShareBlob) {
    exportState.shareBlob = state.pendingShareBlob;
    state.pendingShareBlob = null;
  }

  if (config.type === 'photo') {
    exportPreview.innerHTML = `<img src="${config.previewUrl}" alt="Captured preview">`;
  } else {
    exportPreview.innerHTML = `
      <div class="video-preview">
        <video data-preview-video playsinline preload="metadata" src="${config.previewUrl}"></video>
        <button type="button" class="video-preview__play" data-preview-play aria-label="Play video">
          <img src="icons/play_circle_fill.svg" alt="" aria-hidden="true">
        </button>
      </div>
    `;
    wireVideoPreviewControls();
  }

  exportShareBtn.disabled = !exportState.shareBlob;
  cameraPage.classList.add('hidden');
  exportPage.classList.remove('hidden');
}

async function prepareShareVideoBlob(originalBlob, previewUrlSnapshot) {
  try {
    const shareBlob = await createShareVideoBlob(originalBlob);
    if (!shareBlob) return;
    if (exportState.previewUrl !== previewUrlSnapshot) {
      return;
    }
    exportState.shareBlob = shareBlob;
    if (exportShareBtn) {
      exportShareBtn.disabled = false;
    }
  } catch (error) {
    console.warn('Unable to create share-sized video', error);
  }
}

function setupShareRecording() {
  cleanupShareRecording();
  if (!state.stream) return false;
  const baseSize = getTargetDimensions();
  if (!baseSize.width || !baseSize.height) return false;
  const shareWidth = SHARE_TARGET_WIDTH * EXPORT_SCALE;
  const shareHeight = SHARE_TARGET_HEIGHT * EXPORT_SCALE;
  if (!shareWidth || !shareHeight) return false;

  if (!state.shareCanvas) {
    state.shareCanvas = document.createElement('canvas');
  }
  state.shareCanvas.width = shareWidth;
  state.shareCanvas.height = shareHeight;
  state.shareCtx = state.shareCanvas.getContext('2d');

  const videoStream = state.shareCanvas.captureStream(SHARE_CAPTURE_FPS);
  const mixedStream = new MediaStream();
  videoStream.getVideoTracks().forEach((track) => mixedStream.addTrack(track));
  state.stream
    .getAudioTracks()
    .forEach((track) => mixedStream.addTrack(track));

  const recorderOptions = buildRecorderOptions('share');
  try {
    state.shareRecorder = new MediaRecorder(mixedStream, recorderOptions);
  } catch (error) {
    console.warn('Share recorder unavailable', error);
    videoStream.getTracks().forEach((track) => track.stop());
    mixedStream.getTracks().forEach((track) => track.stop());
    state.shareRecorder = null;
    state.shareStream = null;
    state.shareVideoStream = null;
    return false;
  }

  state.shareVideoStream = videoStream;
  state.shareStream = mixedStream;
  state.shareChunks = [];
  state.shareRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      state.shareChunks.push(event.data);
    }
  };
  state.shareRecorder.onstop = handleShareRecordingStop;
  return true;
}

function handleShareRecordingStop() {
  state.shareRecorderActive = false;
  const chunks = state.shareChunks.slice();
  const mimeType = state.shareRecorder?.mimeType || state.mediaRecorder?.mimeType || 'video/mp4';
  cleanupShareRecording();
  if (!chunks.length) {
    if (
      exportState.type === 'video' &&
      exportState.originalBlob &&
      !state.shareFallbackPending
    ) {
      state.shareFallbackPending = true;
      prepareShareVideoBlob(exportState.originalBlob, exportState.previewUrl);
    }
    return;
  }
  state.shareFallbackPending = false;
  const shareBlob = new Blob(chunks, { type: mimeType });
  if (exportState.type === 'video') {
    exportState.shareBlob = shareBlob;
    if (exportShareBtn) {
      exportShareBtn.disabled = false;
    }
  } else {
    state.pendingShareBlob = shareBlob;
  }
}

function cleanupShareRecording() {
  if (state.shareRecorder) {
    state.shareRecorder.ondataavailable = null;
    state.shareRecorder.onstop = null;
    if (state.shareRecorder.state === 'recording') {
      try {
        state.shareRecorder.stop();
      } catch (error) {
        console.warn('Unable to stop active share recorder', error);
      }
    }
  }
  if (state.shareStream) {
    state.shareStream.getTracks().forEach((track) => track.stop());
  }
  if (state.shareVideoStream) {
    state.shareVideoStream.getTracks().forEach((track) => track.stop());
  }
  state.shareRecorder = null;
  state.shareStream = null;
  state.shareVideoStream = null;
  state.shareChunks = [];
  state.shareRecorderActive = false;
}

function drawShareFrame() {
  if (!state.shareCtx || !state.shareCanvas) return;
  const mapping = computeBottomCropMapping(
    state.renderCanvas.width,
    state.renderCanvas.height,
    state.shareCanvas.width,
    state.shareCanvas.height
  );
  state.shareCtx.clearRect(0, 0, state.shareCanvas.width, state.shareCanvas.height);
  state.shareCtx.drawImage(
    state.renderCanvas,
    mapping.sx,
    mapping.sy,
    mapping.sw,
    mapping.sh,
    0,
    0,
    state.shareCanvas.width,
    state.shareCanvas.height
  );
}

function hideExportScreen() {
  const videoEl = exportPreview.querySelector('video');
  if (videoEl) {
    videoEl.pause();
    URL.revokeObjectURL(videoEl.src);
  }
  if (exportState.previewUrl) {
    URL.revokeObjectURL(exportState.previewUrl);
  }
  exportPreview.innerHTML = '';
  exportPage.classList.add('hidden');
  cameraPage.classList.remove('hidden');
  exportState.type = '';
  exportState.originalBlob = null;
  exportState.shareBlob = null;
  exportState.originalName = '';
  exportState.shareName = '';
  exportState.previewUrl = '';
  exportState.mimeType = '';
}

async function handleExportAction(kind) {
  const blob = kind === 'share' ? exportState.shareBlob : exportState.originalBlob;
  const filename = kind === 'share' ? exportState.shareName : exportState.originalName;
  if (!blob || !filename) return;
  if (kind === 'share') {
    await shareToX(blob, filename);
  } else {
    downloadBlob(blob, filename);
  }
  hideExportScreen();
}

function wireVideoPreviewControls() {
  const videoEl = exportPreview.querySelector('video');
  const playButton = exportPreview.querySelector('[data-preview-play]');
  if (!videoEl || !playButton) return;
  videoEl.controls = true;
  videoEl.preload = 'auto';
  videoEl.playsInline = true;

  const updatePlayButton = () => {
    if (videoEl.paused || videoEl.ended) {
      playButton.classList.remove('hidden');
    } else {
      playButton.classList.add('hidden');
    }
  };

  playButton.addEventListener('click', () => {
    videoEl.play().catch(() => {});
  });
  videoEl.addEventListener('play', updatePlayButton);
  videoEl.addEventListener('pause', updatePlayButton);
  videoEl.addEventListener('ended', updatePlayButton);
  updatePlayButton();
}

function canvasToBlob(canvas, type = 'image/png', quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Unable to export canvas.'));
          return;
        }
        resolve(blob);
      },
      type,
      quality
    );
  });
}

async function createSharePhotoBlob(sourceCanvas) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null;
  const shareCanvas = document.createElement('canvas');
  shareCanvas.width = SHARE_TARGET_WIDTH * EXPORT_SCALE;
  shareCanvas.height = SHARE_TARGET_HEIGHT * EXPORT_SCALE;
  const shareCtx = shareCanvas.getContext('2d');
  shareCtx.fillStyle = '#000';
  shareCtx.fillRect(0, 0, shareCanvas.width, shareCanvas.height);
  const mapping = computeBottomCropMapping(
    sourceCanvas.width,
    sourceCanvas.height,
    shareCanvas.width,
    shareCanvas.height
  );
  shareCtx.drawImage(
    sourceCanvas,
    mapping.sx,
    mapping.sy,
    mapping.sw,
    mapping.sh,
    0,
    0,
    shareCanvas.width,
    shareCanvas.height
  );
  return canvasToBlob(shareCanvas);
}

async function createShareVideoBlob(originalBlob) {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  const videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.src = URL.createObjectURL(originalBlob);
  await ensureVideoElementPrepped(videoEl);

  const canvas = document.createElement('canvas');
  const targetWidth = SHARE_TARGET_WIDTH * EXPORT_SCALE;
  const targetHeight = SHARE_TARGET_HEIGHT * EXPORT_SCALE;
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  const mapping = computeBottomCropMapping(
    videoEl.videoWidth,
    videoEl.videoHeight,
    canvas.width,
    canvas.height
  );
  const videoStream = canvas.captureStream(SHARE_CAPTURE_FPS);
  const mixedStream = new MediaStream();
  videoStream.getVideoTracks().forEach((track) => mixedStream.addTrack(track));

  const playbackStream = videoEl.captureStream ? videoEl.captureStream() : null;
  if (playbackStream) {
    playbackStream.getAudioTracks().forEach((track) => mixedStream.addTrack(track));
  }
  let recorder;
  const recorderOptions = buildRecorderOptions('share');
  try {
    recorder = new MediaRecorder(mixedStream, recorderOptions);
  } catch (error) {
    console.warn('Unable to instantiate MediaRecorder for share video', error);
    URL.revokeObjectURL(videoEl.src);
    return null;
  }

  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const recordingPromise = new Promise((resolve) => {
    recorder.onstop = () => {
      const mimeType = recorder.mimeType || originalBlob.type || (recorderOptions && recorderOptions.mimeType) || 'video/webm';
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start();

  const drawFrame = () => {
    if (videoEl.paused || videoEl.ended) return;
    ctx.drawImage(
      videoEl,
      mapping.sx,
      mapping.sy,
      mapping.sw,
      mapping.sh,
      0,
      0,
      canvas.width,
      canvas.height
    );
    requestAnimationFrame(drawFrame);
  };
  await videoEl.play().catch(() => {});
  drawFrame();
  await waitForVideoEnd(videoEl);
  recorder.stop();
  const shareBlob = await recordingPromise;
  URL.revokeObjectURL(videoEl.src);
  videoEl.remove();
  return shareBlob;
}

function waitForVideoEnd(videoEl) {
  return new Promise((resolve) => {
    if (videoEl.ended) {
      resolve();
      return;
    }
    const handler = () => {
      videoEl.removeEventListener('ended', handler);
      resolve();
    };
    videoEl.addEventListener('ended', handler);
  });
}

async function ensureVideoElementPrepped(element) {
  if (element.readyState >= 2 && element.videoWidth > 0) return;
  await new Promise((resolve) => {
    element.addEventListener('loadeddata', resolve, { once: true });
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

async function shareToX(blob, filename) {
  downloadBlob(blob, filename);
  const tweetUrl = new URL('https://x.com/intent/tweet');
  tweetUrl.searchParams.set(
    'text',
    'Your Seeker isn’t complete until you try this...\n\nFlex your shots with Shot on Seeker.\n\nhttps://shot-on-seeker.vercel.app'
  );
  window.open(tweetUrl.toString(), '_blank', 'noopener');
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
  cleanupShareRecording();
  state.mediaRecorder = null;
  state.recordedChunks = [];
}

function updateMirrorState() {
  const shouldMirror = state.facingMode === 'user';
  video.classList.toggle('mirrored', shouldMirror);
  if (document.body) {
    document.body.classList.toggle('front-camera', shouldMirror);
    document.body.classList.toggle('back-camera', !shouldMirror);
  }
  state.activeOverlayMode = state.facingMode;
}

function getViewboxSize() {
  if (!viewbox) return { width: 0, height: 0 };
  const rect = viewbox.getBoundingClientRect();
  const width = Math.round(rect.width || 0);
  const height = Math.round(rect.height || 0);
  return { width, height };
}

function getTargetDimensions() {
  const { width, height } = getViewboxSize();
  if (width > 0 && height > 0) return { width, height };
  if (video.videoWidth && video.videoHeight) {
    return { width: video.videoWidth, height: video.videoHeight };
  }
  return { width: 0, height: 0 };
}

function drawVideoToContext(context, source, targetWidth, targetHeight) {
  const sourceWidth = source?.videoWidth || source?.width || source?.naturalWidth;
  const sourceHeight = source?.videoHeight || source?.height || source?.naturalHeight;
  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) return;
  const mapping = computeDrawMapping(sourceWidth, sourceHeight, targetWidth, targetHeight);
  const mirror = source === video && state.facingMode === 'user';
  context.save();
  context.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in context) {
    context.imageSmoothingQuality = 'high';
  }
  const isLiveSource = source === video;
  if ('filter' in context) {
    const filter = PREVIEW_FILTERS[state.facingMode] || 'none';
    context.filter = isLiveSource ? filter : 'none';
  }
  if (mirror) {
    context.translate(targetWidth, 0);
    context.scale(-1, 1);
  }
  context.drawImage(
    source,
    mapping.sx,
    mapping.sy,
    mapping.sw,
    mapping.sh,
    0,
    0,
    targetWidth,
    targetHeight
  );
  context.restore();
}

function computeDrawMapping(videoWidth, videoHeight, targetWidth, targetHeight) {
  if (!videoWidth || !videoHeight || !targetWidth || !targetHeight) {
    return { sx: 0, sy: 0, sw: videoWidth, sh: videoHeight };
  }

  const widthRatio = targetWidth / videoWidth;
  const heightRatio = targetHeight / videoHeight;
  const scale = Math.max(widthRatio, heightRatio);

  const sourceWidth = targetWidth / scale;
  const sourceHeight = targetHeight / scale;
  const sx = (videoWidth - sourceWidth) / 2;
  const sy = (videoHeight - sourceHeight) / 2;

  return {
    sx,
    sy,
    sw: sourceWidth,
    sh: sourceHeight,
  };
}

function computeBottomCropMapping(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight };
  }
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;

  let sw;
  let sh;
  let sx;
  let sy;

  if (sourceRatio > targetRatio) {
    sh = sourceHeight;
    sw = sh * targetRatio;
    sx = (sourceWidth - sw) / 2;
    sy = 0;
  } else {
    sw = sourceWidth;
    sh = sw / targetRatio;
    sx = 0;
    sy = Math.max(0, sourceHeight - sh); // crop from top, keep bottom
  }

  return { sx, sy, sw, sh };
}

function getHiResDimensions(baseWidth, baseHeight, scale = EXPORT_SCALE) {
  if (!baseWidth || !baseHeight) {
    return { width: baseWidth, height: baseHeight, scale: 1 };
  }
  const safeScale = Math.max(1, scale);
  return {
    width: Math.round(baseWidth * safeScale),
    height: Math.round(baseHeight * safeScale),
    scale: safeScale,
  };
}

