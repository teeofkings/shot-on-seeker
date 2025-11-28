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

const SEEKER_KEYWORDS = ['seeker', 'solana mobile', 'solanamobile', 'solana-mobile', 'sm-skr', 'skr'];
const FORCE_QUERY_PARAM = 'forceSeeker';
const SHARE_TARGET_WIDTH = 480;
const SHARE_TARGET_HEIGHT = 640;
const EXPORT_SCALE = 2;

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

const exportState = {
  type: '',
  originalBlob: null,
  shareBlob: null,
  originalName: '',
  shareName: '',
  previewUrl: '',
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
setupExportControls();

function bindUIEvents() {
  captureBtn.addEventListener('click', handleCapture);
  recordBtn.addEventListener('click', () => {
    state.isRecording ? stopRecording() : startRecording();
  });
  switchBtn.addEventListener('click', switchCamera);
  window.addEventListener('beforeunload', shutdownStream);
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

async function shareToX(blob, filename) {
  downloadBlob(blob, filename);
  const tweetUrl = new URL('https://x.com/intent/tweet');
  tweetUrl.searchParams.set('text', 'Shot on Seeker #ShotOnSeeker');
  window.open(tweetUrl.toString(), '_blank', 'noopener');
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
    if (!video.videoWidth) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    const baseSize = getTargetDimensions();
    if (!baseSize.width || !baseSize.height) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    const hiSize = getHiResDimensions(baseSize.width, baseSize.height);
    if (state.renderCanvas.width !== hiSize.width || state.renderCanvas.height !== hiSize.height) {
      state.renderCanvas.width = hiSize.width;
      state.renderCanvas.height = hiSize.height;
    }

    state.renderCtx.clearRect(0, 0, hiSize.width, hiSize.height);
    drawVideoToContext(state.renderCtx, video, hiSize.width, hiSize.height);
    drawOverlay(state.renderCtx, hiSize.width, hiSize.height);
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

  state.mediaRecorder.onstop = async () => {
    if (!state.recordedChunks.length) return;
    const blob = new Blob(state.recordedChunks, {
      type: state.mediaRecorder.mimeType || 'video/webm',
    });
    state.recordedChunks = [];
    const previewUrl = URL.createObjectURL(blob);
    let shareBlob = null;
    try {
      shareBlob = await createShareVideoBlob(blob);
    } catch (error) {
      console.warn('Unable to create share-sized video', error);
    }
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const baseName = `seeker-video-${timestamp()}.${extension}`;
    showExportScreen({
      type: 'video',
      previewUrl,
      originalBlob: blob,
      shareBlob: shareBlob || blob,
      originalName: baseName,
      shareName: baseName.replace(`.${extension}`, `-x.${extension}`),
      mimeType: blob.type,
    });
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
  await stampOverlay(hiCtx, hiSize.width, hiSize.height);

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
  shareCanvas.width = SHARE_TARGET_WIDTH;
  shareCanvas.height = SHARE_TARGET_HEIGHT;
  const shareCtx = shareCanvas.getContext('2d');
  shareCtx.fillStyle = '#000';
  shareCtx.fillRect(0, 0, shareCanvas.width, shareCanvas.height);
  const mapping = computeDrawMapping(
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
  canvas.width = SHARE_TARGET_WIDTH;
  canvas.height = SHARE_TARGET_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const mapping = computeDrawMapping(videoEl.videoWidth, videoEl.videoHeight, canvas.width, canvas.height);
  const stream = canvas.captureStream(30);
  let recorder;
  try {
    recorder = new MediaRecorder(stream, originalBlob.type ? { mimeType: originalBlob.type } : undefined);
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
      resolve(new Blob(chunks, { type: originalBlob.type || 'video/webm' }));
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

function updateMirrorState() {
  const shouldMirror = state.facingMode === 'user';
  video.classList.toggle('mirrored', shouldMirror);
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

function getHiResDimensions(baseWidth, baseHeight) {
  if (!baseWidth || !baseHeight) {
    return { width: baseWidth, height: baseHeight, scale: 1 };
  }
  const videoWidth = video?.videoWidth || baseWidth;
  const videoHeight = video?.videoHeight || baseHeight;
  const widthScale = videoWidth / baseWidth || EXPORT_SCALE;
  const heightScale = videoHeight / baseHeight || EXPORT_SCALE;
  const scale = Math.max(1, Math.min(EXPORT_SCALE, widthScale, heightScale));
  return {
    width: Math.round(baseWidth * scale),
    height: Math.round(baseHeight * scale),
    scale,
  };
}

