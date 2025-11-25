const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const captureBtn = document.getElementById('capture');
const startRecordBtn = document.getElementById('start-record');
const stopRecordBtn = document.getElementById('stop-record');
const preview = document.getElementById('preview');
const cameraPage = document.getElementById('camera-page');
const notSeeker = document.getElementById('not-seeker');
const statusBadge = document.getElementById('status');
const uploadInput = document.getElementById('upload');
const permissionError = document.getElementById('permission-error');
const liveWatermark = document.getElementById('live-watermark');
const overrideBtn = document.getElementById('manual-override');

const SEEKER_KEYWORDS = [
  'seeker',
  'solana mobile',
  'solanamobile',
  'solana-mobile',
  'solana',
  'skr',
  'sm-skr',
];
const FORCE_QUERY_PARAM = 'forceSeeker';
const OVERRIDE_STORAGE_KEY = 'shotOnSeekerOverride';

const state = {
  mediaRecorder: null,
  recordedChunks: [],
  stream: null,
  isSeekerDevice: false,
};

const watermarkImage = new Image();
watermarkImage.src = 'watermark.png';

const watermarkReady = ('decode' in watermarkImage)
  ? watermarkImage.decode().catch(() => {})
  : new Promise((resolve, reject) => {
      watermarkImage.onload = () => resolve();
      watermarkImage.onerror = reject;
    });

init();
bindUIEvents();
setRecordingState(false);

async function init() {
  const detection = await detectSeekerDevice();
  state.isSeekerDevice = detection.isSeeker;
  updateStatus(detection);
  updateLiveWatermarkLabel();

  if (!detection.allowAccess) {
    notSeeker.classList.remove('hidden');
    return;
  }

  notSeeker.classList.add('hidden');
  cameraPage.classList.remove('hidden');

  try {
    await startCamera();
  } catch (error) {
    showError(`Camera error: ${error.message}`);
    console.error(error);
  }
}

function bindUIEvents() {
  captureBtn.addEventListener('click', handleCapture);
  startRecordBtn.addEventListener('click', startRecording);
  stopRecordBtn.addEventListener('click', stopRecording);
  uploadInput.addEventListener('change', handleUpload);
  window.addEventListener('beforeunload', shutdownStream);
  overrideBtn?.addEventListener('click', handleManualOverride);
}

async function detectSeekerDevice() {
  const params = new URLSearchParams(window.location.search);
  if (params.get(FORCE_QUERY_PARAM) === 'true') {
    return { isSeeker: true, reason: 'forced via URL flag', allowAccess: true };
  }

  let storedPreference = null;
  try {
    storedPreference = localStorage.getItem(OVERRIDE_STORAGE_KEY);
  } catch (error) {
    console.warn('Unable to read override preference', error);
  }

  if (storedPreference === 'force-seeker' || storedPreference === 'true') {
    return { isSeeker: true, reason: 'manual override saved', allowAccess: true };
  }

  if (storedPreference === 'allow-peek') {
    return { isSeeker: false, reason: 'manual peek override', allowAccess: true };
  }

  const hintString = await collectUserAgentHints();
  const keyword = SEEKER_KEYWORDS.find((needle) => hintString.includes(needle));
  const isSeeker = Boolean(keyword);

  return {
    isSeeker,
    reason: keyword ? `device hints matched "${keyword}"` : 'no Solana Mobile hints detected',
    allowAccess: isSeeker,
  };
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
        const highEntropy = await uaData.getHighEntropyValues(['platform', 'model']);
        ['platform', 'model'].forEach((key) => {
          if (highEntropy?.[key]) {
            hints.push(String(highEntropy[key]).toLowerCase());
          }
        });
      } catch (error) {
        console.warn('High-entropy UA lookup failed', error);
      }
    }
  }

  return hints.join(' ');
}

function updateStatus({ isSeeker, reason }) {
  if (!statusBadge) return;
  statusBadge.textContent = isSeeker
    ? `Seeker device detected (${reason})`
    : `Not a Seeker (${reason})`;
}

function updateLiveWatermarkLabel() {
  if (!liveWatermark) return;
  const label = state.isSeekerDevice ? 'Shot on Seeker' : 'Not Shot on a Seeker';
  liveWatermark.textContent = label;
  liveWatermark.classList.toggle('non-seeker', !state.isSeekerDevice);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is not supported in this browser');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: true,
  });

  state.stream = stream;
  video.srcObject = stream;
  clearError();
  setupMediaRecorder(stream);
}

function setupMediaRecorder(stream) {
  if (typeof MediaRecorder === 'undefined') {
    startRecordBtn.disabled = true;
    stopRecordBtn.disabled = true;
    console.warn('MediaRecorder is not supported in this browser.');
    return;
  }

  const mimeType = getSupportedMimeType();
  state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

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

    const url = URL.createObjectURL(blob);
    showVideoPreview(url);
  };
}

function getSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

async function handleCapture() {
  if (cameraPage.classList.contains('hidden')) return;
  await ensureVideoReady();

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);
  await stampWatermark(ctx, canvas.width, canvas.height);

  const snapshot = new Image();
  snapshot.src = canvas.toDataURL('image/png');
  snapshot.alt = 'Watermarked Seeker capture';
  snapshot.loading = 'lazy';
  resetPreview(snapshot);
}

async function ensureVideoReady() {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise((resolve) => {
    video.addEventListener('loadeddata', resolve, { once: true });
  });
}

async function stampWatermark(context, width, height) {
  await watermarkReady.catch(() => {});

  context.save();
  const margin = Math.round(width * 0.03);
  const isSeekerCapture = state.isSeekerDevice;
  const text = isSeekerCapture ? 'Shot on Seeker' : 'Not Shot on a Seeker';
  const fontSize = Math.max(24, Math.round(width * 0.04));

  if (isSeekerCapture && watermarkImage.complete && watermarkImage.naturalWidth) {
    const maxWidth = width * 0.25;
    const ratio = watermarkImage.naturalWidth / watermarkImage.naturalHeight;
    const drawWidth = Math.min(maxWidth, watermarkImage.naturalWidth);
    const drawHeight = drawWidth / ratio;
    context.globalAlpha = 0.95;
    context.drawImage(
      watermarkImage,
      width - drawWidth - margin,
      height - drawHeight - margin,
      drawWidth,
      drawHeight
    );
    context.globalAlpha = 1;
  }

  context.font = `600 ${fontSize}px "Space Grotesk", "Inter", sans-serif`;
  context.textBaseline = 'bottom';
  context.lineWidth = Math.max(6, Math.round(width * 0.004));
  context.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  context.fillStyle = isSeekerCapture ? '#ffffff' : '#ff9fb0';
  context.strokeText(text, margin, height - margin);
  context.fillText(text, margin, height - margin);
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
  startRecordBtn.disabled = isRecording;
  stopRecordBtn.disabled = !isRecording;
  if (liveWatermark) {
    liveWatermark.classList.toggle('recording', isRecording);
  }
}

function showVideoPreview(url) {
  const videoPreview = document.createElement('video');
  videoPreview.src = url;
  videoPreview.controls = true;
  videoPreview.playsInline = true;
  videoPreview.loop = false;
  videoPreview.autoplay = false;
  videoPreview.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
  resetPreview(videoPreview);
}

function resetPreview(node) {
  preview.innerHTML = '';
  preview.appendChild(node);
}

function handleUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  clearError();

  if (file.type.startsWith('image')) {
    renderUploadedImage(file);
  } else if (file.type.startsWith('video')) {
    renderUploadedVideo(file);
  } else {
    showError('Unsupported file type. Please pick an image or video.');
  }

  uploadInput.value = '';
}

function renderUploadedImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    await stampWatermark(ctx, canvas.width, canvas.height);

    const stamped = new Image();
    stamped.src = canvas.toDataURL('image/png');
    stamped.alt = `${file.name} with Seeker watermark`;
    stamped.loading = 'lazy';
    resetPreview(stamped);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showError('Unable to read that image file.');
  };
  img.src = url;
}

function renderUploadedVideo(file) {
  const url = URL.createObjectURL(file);
  const vid = document.createElement('video');
  vid.src = url;
  vid.controls = true;
  vid.playsInline = true;
  vid.loop = false;
  vid.autoplay = false;
  vid.addEventListener('loadeddata', () => URL.revokeObjectURL(url), { once: true });
  resetPreview(vid);
}

function showError(message) {
  permissionError.textContent = message;
  permissionError.classList.remove('hidden');
}

function clearError() {
  permissionError.textContent = '';
  permissionError.classList.add('hidden');
}

async function handleManualOverride() {
  try {
    localStorage.setItem(OVERRIDE_STORAGE_KEY, 'allow-peek');
  } catch (error) {
    console.warn('Unable to persist manual override', error);
  }

  state.isSeekerDevice = false;
  const detection = { isSeeker: false, reason: 'manual peek override', allowAccess: true };
  updateStatus(detection);
  updateLiveWatermarkLabel();
  notSeeker.classList.add('hidden');
  cameraPage.classList.remove('hidden');

  if (!state.stream) {
    try {
      await startCamera();
    } catch (error) {
      showError(`Camera error: ${error.message}`);
      console.error(error);
    }
  }
}

function shutdownStream() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
}
