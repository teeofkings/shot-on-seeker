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
  renderSource: null,
  captureSource: null,
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
    if (!video.videoWidth) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    const { width: targetWidth, height: targetHeight } = getTargetDimensions();
    if (!targetWidth || !targetHeight) {
      state.animationFrameId = requestAnimationFrame(draw);
      return;
    }

    if (state.renderCanvas.width !== targetWidth || state.renderCanvas.height !== targetHeight) {
      state.renderCanvas.width = targetWidth;
      state.renderCanvas.height = targetHeight;
    }

    state.renderCtx.clearRect(0, 0, targetWidth, targetHeight);
    drawVideoToContext(state.renderCtx, video, targetWidth, targetHeight);
    drawOverlay(state.renderCtx, targetWidth, targetHeight);
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

  const { width: targetWidth, height: targetHeight } = getTargetDimensions();
  if (!targetWidth || !targetHeight) {
    showError('Capture unavailable: invalid viewbox size.');
    return;
  }

  const photoSource = await createHighResSource().catch((error) => {
    console.warn('High-res photo stream unavailable, falling back to preview', error);
    return null;
  });

  const sourceVideo = photoSource?.video || video;
  const exportSize = photoSource
    ? { width: photoSource.width, height: photoSource.height }
    : { width: targetWidth, height: targetHeight };

  canvas.width = exportSize.width;
  canvas.height = exportSize.height;
  drawVideoToContext(ctx, sourceVideo, exportSize.width, exportSize.height);
  await stampOverlay(ctx, exportSize.width, exportSize.height);

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

  if (photoSource) {
    releaseHighResSource(photoSource);
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
  try {
    state.captureSource = await createHighResSource();
    state.renderSource = state.captureSource.video;
  } catch (error) {
    console.warn('High-res recording stream unavailable, using preview feed', error);
    state.captureSource = null;
    state.renderSource = null;
  }

  state.recordedChunks = [];
  state.mediaRecorder.start();
  setRecordingState(true);
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
  state.mediaRecorder.stop();
  setRecordingState(false);
  if (state.captureSource) {
    releaseHighResSource(state.captureSource);
    state.captureSource = null;
  }
  state.renderSource = null;
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
  if (state.captureSource) {
    releaseHighResSource(state.captureSource);
    state.captureSource = null;
  }
  state.renderSource = null;
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
  drawSourceToContext(context, source, targetWidth, targetHeight);
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

function createHighResConstraints() {
  const facingMode = { ideal: state.facingMode };
  return [
    {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      facingMode,
    },
    {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      facingMode,
    },
    { facingMode },
  ];
}

async function createHighResSource() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not supported');
  }
  const variants = createHighResConstraints();
  let lastError = null;

  for (const videoConstraints of variants) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      const videoEl = document.createElement('video');
      Object.assign(videoEl, { autoplay: true, muted: true, playsInline: true });
      videoEl.srcObject = stream;
      await ensureVideoElementReady(videoEl);
      return {
        stream,
        video: videoEl,
        width: videoEl.videoWidth,
        height: videoEl.videoHeight,
      };
    } catch (error) {
      lastError = error;
      console.warn('High-res stream attempt failed', videoConstraints, error);
    }
  }
  if (lastError) throw lastError;
  throw new Error('Unable to create high-resolution stream');
}

function releaseHighResSource(source) {
  const stream = source?.stream;
  const videoEl = source?.video;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
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
      console.warn('Video element play failed', error);
    }
  }
}

function drawSourceToContext(context, source, targetWidth, targetHeight) {
  const sourceWidth = source?.videoWidth || source?.width || source?.naturalWidth;
  const sourceHeight = source?.videoHeight || source?.height || source?.naturalHeight;
  if (!sourceWidth || !sourceHeight) return;
  const mapping = computeDrawMapping(sourceWidth, sourceHeight, targetWidth, targetHeight);
  const mirror = state.facingMode === 'user';
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
