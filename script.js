const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const captureBtn = document.getElementById('capture');
const startRecordBtn = document.getElementById('start-record');
const stopRecordBtn = document.getElementById('stop-record');
const preview = document.getElementById('preview');
const cameraPage = document.getElementById('camera-page');
const notSeeker = document.getElementById('not-seeker');
const uploadInput = document.getElementById('upload');

let mediaRecorder;
let recordedChunks = [];

// --- Device detection ---
function isSeeker() {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("seeker"); // customize for Seeker UA
}

// if (!isSeeker()) {
//   notSeeker.classList.remove('hidden');
// } else {
//   cameraPage.classList.remove('hidden');

// For testing on PC, bypass Seeker detection
// Remove or comment out the isSeeker() check temporarily
cameraPage.classList.remove('hidden');

// Camera access
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(stream => {
    video.srcObject = stream;

    // Prepare MediaRecorder
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);

      const vid = document.createElement('video');
      vid.src = url;
      vid.controls = true;
      preview.innerHTML = '';
      preview.appendChild(vid);

      // Reset
      recordedChunks = [];
    };
  })
  .catch(err => {
    alert('Camera access denied!');
    console.error(err);
  });

  // Camera access
  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      video.srcObject = stream;

      // Prepare MediaRecorder
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);

        const vid = document.createElement('video');
        vid.src = url;
        vid.controls = true;
        preview.innerHTML = '';
        preview.appendChild(vid);

        // Reset
        recordedChunks = [];
      };
    })
    .catch(err => {
      alert('Camera access denied!');
      console.error(err);
    });


// --- Capture Image ---
captureBtn.addEventListener('click', () => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  // Add watermark
  const watermark = new Image();
  watermark.src = 'watermark.png';
  watermark.onload = () => {
    ctx.drawImage(watermark, canvas.width - watermark.width - 10, canvas.height - watermark.height - 10);
    const dataURL = canvas.toDataURL('image/png');

    const img = document.createElement('img');
    img.src = dataURL;
    preview.innerHTML = '';
    preview.appendChild(img);
  };
});

// --- Start Recording ---
startRecordBtn.addEventListener('click', () => {
  if (!mediaRecorder) return;
  mediaRecorder.start();
  startRecordBtn.disabled = true;
  stopRecordBtn.disabled = false;
});

// --- Stop Recording ---
stopRecordBtn.addEventListener('click', () => {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  startRecordBtn.disabled = false;
  stopRecordBtn.disabled = true;
});

// --- Upload ---
uploadInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  preview.innerHTML = '';

  if (file.type.startsWith("image")) {
    const img = document.createElement('img');
    img.src = url;
    preview.appendChild(img);
  } else if (file.type.startsWith("video")) {
    const vid = document.createElement('video');
    vid.src = url;
    vid.controls = true;
    preview.appendChild(vid);
  }
});