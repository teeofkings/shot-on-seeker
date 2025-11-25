# Shot on Seeker

Solana Mobile’s Seeker device ships without a “Shot on Seeker” watermark, so this little web app fills the gap. Open it in the Seeker browser (or force-detect it on desktop) to capture photos, record clips, or upload existing media and instantly stamp a Seeker-branded overlay.

## Why this repo exists
- **Device-aware landing** – the UI detects Seeker hardware/User-Agent hints and hides the capture UI when you are on anything else.
- **Camera + MediaRecorder flow** – capture live video, take stills, or upload media straight from the browser without needing a native binary.
- **Automatic watermarking** – an SVG/PNG badge plus a “Shot on Seeker” typographic mark are burned directly into photos and imported images.
- **Share-friendly preview** – everything renders in-canvas first, so you can long-press/save the output from mobile without extra steps.

## Getting started
1. Serve the folder however you like (`npx serve`, GitHub Pages, Vercel, etc.).
2. Open the URL inside the Seeker browser or Companion app.
3. Accept camera + mic permissions so MediaRecorder can boot.
4. Capture a frame, record video, or upload an existing file to see the watermark preview.

### Desktop testing
- Append `?forceSeeker=true` to the URL to bypass user-agent detection.
- Your machine still needs camera permissions if you want to preview the overlay live.

## Tech stack
- Vanilla HTML/CSS/JS
- MediaDevices + MediaRecorder APIs
- Canvas 2D rendering for watermark compositing

## Notes
- The included `watermark.png` is a placeholder badge—swap it for an official Solana Mobile asset if you have one.
- Video recordings currently show the watermark in the live overlay; the export on recorded clips keeps the raw pixels so you can composite later if needed.
