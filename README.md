# Shot on Seeker

Shot on Seeker is a browser-native camera and recorder built for Solana Mobile's Seeker device. It mirrors the framing of the stock camera, stamps a crisp "Shot on Seeker" watermark, and delivers the result straight from the web without a native binary.

## Highlights
- **Device-aware landing** – Detects Seeker hardware and hides capture controls elsewhere.
- **Live capture pipeline** – Uses `getUserMedia`, `MediaRecorder`, and Canvas rendering to shoot stills or record clips.
- **Consistent watermarking** – The same gradient + badge overlay from the live preview is burned into exports at 3× scale for sharp output.
- **Dual export flow** – Every capture yields both the full-resolution master and a share-optimized 480×640×3 version for X, with audio preserved.
- **Performance-minded** – Render loops and share encoders are throttled so previews appear quickly and long recordings do not freeze the page.

## Tech Stack
- Vanilla HTML, CSS, and JavaScript.
- MediaDevices + MediaRecorder APIs for streaming and recording.
- Canvas 2D for compositing gradients, badges, and share crops.

## Note
- The Share to X button downloads the share-sized export and opens `https://x.com/intent/tweet` pre-filled for posting.

## Status

The core product is complete and tuned for the Seeker. And sure there'll be future updates
