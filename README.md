# Shot on Seeker Camera App

A web-based camera application specifically designed for the Solana Seeker device (formerly Solana Mobile). This app automatically adds a "Shot on Seeker" watermark to photos taken with the device.

## Features

- **Device Detection**: Automatically detects if the user is on a Seeker/Solana Mobile device.
- **Watermark Overlay**: Adds a custom watermark to every photo taken.
- **Camera Controls**: Front/Back camera toggle, flash simulation.
- **Save & Share**: Easily download or share your branded photos.

## Development & Testing

Since most developers do not have a Seeker device handy, a **Simulation Mode** is included.

1. Open the app in your browser.
2. If you are not on a Seeker device, you will see a "Solana Seeker Only" lock screen.
3. Click the **"Simulate Seeker (Dev)"** button to bypass the check and test the camera functionality on your laptop or other mobile device.

## Tech Stack

- HTML5 / CSS3
- Vanilla JavaScript
- MediaDevices API (Camera access)
- Canvas API (Image processing & watermarking)
