// DOM Elements
const app = document.getElementById('app');
const notSeekerScreen = document.getElementById('not-seeker');
const cameraPage = document.getElementById('camera-page');
const resultPage = document.getElementById('result-page');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const capturedImage = document.getElementById('captured-image');
const flashOverlay = document.getElementById('flash');

// Buttons
const simulateSeekerBtn = document.getElementById('simulate-seeker');
const captureBtn = document.getElementById('capture-btn');
const flipBtn = document.getElementById('flip-camera');
const retakeBtn = document.getElementById('retake-btn');
const saveBtn = document.getElementById('save-btn');
const shareBtn = document.getElementById('share-btn');

// State
let stream = null;
let currentFacingMode = 'environment'; // Start with back camera if possible
let watermarkImg = null;

// --- Initialization ---
async function init() {
  // Preload watermark
  watermarkImg = new Image();
  watermarkImg.src = 'watermark.png';
  
  if (isSeekerDevice()) {
    startCamera();
  } else {
    notSeekerScreen.classList.remove('hidden');
  }
}

// --- Device Detection ---
function isSeekerDevice() {
  const ua = navigator.userAgent.toLowerCase();
  // Check for specific Seeker/Solana Mobile identifiers
  // This is a guess based on common patterns, user can simulate if needed
  return ua.includes('seeker') || ua.includes('solana') || ua.includes('saga');
}

// --- Camera Handling ---
async function startCamera() {
  notSeekerScreen.classList.add('hidden');
  cameraPage.classList.remove('hidden');

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  try {
    const constraints = {
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
  } catch (err) {
    console.error('Error accessing camera:', err);
    alert('Could not access camera. Please ensure permissions are granted.');
  }
}

// --- Actions ---

// Simulate Seeker (Dev Mode)
simulateSeekerBtn.addEventListener('click', () => {
  startCamera();
});

// Flip Camera
flipBtn.addEventListener('click', () => {
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  startCamera();
});

// Capture Photo
captureBtn.addEventListener('click', () => {
  // Flash effect
  flashOverlay.classList.add('flash-active');
  setTimeout(() => flashOverlay.classList.remove('flash-active'), 100);

  // Setup canvas
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Draw video frame
  // Check if we need to mirror for user facing camera
  if (currentFacingMode === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
  } else {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  // Add Watermark
  addWatermark(ctx, canvas.width, canvas.height);

  // Show result
  const dataURL = canvas.toDataURL('image/png');
  capturedImage.src = dataURL;
  
  cameraPage.classList.add('hidden');
  resultPage.classList.remove('hidden');
});

function addWatermark(ctx, width, height) {
  if (!watermarkImg.complete) return;

  // Calculate watermark size (e.g., 25% of screen width)
  const targetWidth = width * 0.25;
  const ratio = watermarkImg.height / watermarkImg.width;
  const targetHeight = targetWidth * ratio;

  // Padding
  const padding = width * 0.05;

  // Position: Bottom Right
  const x = width - targetWidth - padding;
  const y = height - targetHeight - padding;

  // Draw
  ctx.drawImage(watermarkImg, x, y, targetWidth, targetHeight);
}

// Retake
retakeBtn.addEventListener('click', () => {
  resultPage.classList.add('hidden');
  cameraPage.classList.remove('hidden');
  capturedImage.src = '';
});

// Save/Download
saveBtn.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `seeker-shot-${Date.now()}.png`;
  link.href = capturedImage.src;
  link.click();
});

// Share (Basic Web Share API)
shareBtn.addEventListener('click', async () => {
  if (navigator.share) {
    try {
      // Convert base64 to blob for sharing
      const res = await fetch(capturedImage.src);
      const blob = await res.blob();
      const file = new File([blob], 'seeker-shot.png', { type: 'image/png' });

      await navigator.share({
        title: 'Shot on Seeker',
        text: 'Check out this photo taken with my Solana Seeker!',
        files: [file]
      });
    } catch (err) {
      console.log('Error sharing:', err);
    }
  } else {
    alert('Sharing is not supported on this device/browser. Please save the image instead.');
  }
});

// Initialize
init();
