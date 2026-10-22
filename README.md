# Editorr

Dual-video auto podcast editor for Android. Import two phone videos, auto sync audio, auto switch to whoever is speaking, tweak on a timeline, export MP4. Offline. Black theme only.

Brand: Tuik. Package: `com.tuik.editorr`. Stack: Capacitor + TypeScript + Vite, native Java plugin (Media3 Transformer).

## Upload to GitHub

1. Create an empty repo on GitHub.
2. Upload every file in this folder (keep the folder structure, including `.github/workflows`).
3. Open the Actions tab. The workflow `Build Editorr APK` runs on every push.
4. When it finishes, download `Editorr-debug-apk` from the run page and install it.

Optional signed release APK: add these repo secrets (Settings > Secrets and variables > Actions):
`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
Make the base64 with: `base64 -w0 my.jks`.

The `android/` folder is generated in CI (`cap add android` + `scripts/patch-android.py`), so you do not commit it.

## What works

| Feature | State |
| --- | --- |
| Home, Import, Sync, Analyze, Editor, Export, Settings screens | Built |
| Import 2 videos (system picker, copied to app cache), swap, duration/resolution warnings | Built |
| Audio extract (MediaCodec to mono 16 kHz PCM) | Built (native) |
| Auto sync (FFT cross-correlation of energy envelopes, confidence, nudge buttons, overlay) | Built |
| Speaker detect: mic loudness difference when mics differ; voice-print (MFCC 2-speaker) when both phones hear both people; uses the audio picked as Sound: Host/Const | Built, tested on synthetic audio only |
| Lips scan: samples face-area movement from both videos and fuses it with voice (Auto switch with lips) | Built, tested on synthetic data only |
| CapCut-style icon toolbar (auto, lips, split, layout, who is on screen, audio, merge, delete, swap, zoom) | Built |
| Timeline: ruler, 2 waveforms, layout track, fixed playhead, pinch zoom, tap select, long-press menu, boundary drag, split/merge/delete, undo/redo (50), autosave | Built |
| 4 layouts with live preview, popup corner/size/main | Built |
| Export via Media3 Transformer, progress, cancel, save to Movies/Editorr | Written, needs device spike |

## Known gaps (be honest, test these first)

1. Export is the PRD spike. The Media3 multi-sequence compositor code (`native/android/EditorrNativePlugin.java`) was written but never compiled or run here. Run a 30 s test on a real phone first. If the build fails in Actions, send me the log.
2. Side by side and Up/Down export currently use uniform 0.5 scale (letterboxed). True 50/50 crop needs a custom effect.
3. Popup export with Constant as main draws the popup behind. Compositor draw order is fixed by sequence index.
4. Normalize volume toggle is stored but not applied yet.
5. Export does not run as a foreground service yet. Keep Editorr open and the phone plugged in for long exports.
6. Projects are saved in localStorage and the copied videos live in cache. If Android clears cache, re-import the videos.
7. Sync uses an energy-envelope correlation at 5 ms steps. Accuracy is roughly +/- 10 ms; use the nudge buttons for fine tuning.
8. Preview uses the original videos (no 480p proxy yet). Fine for short clips, may stutter on long 1080p.
9. Negative sync offset (Constant starts before Host) is handled in export, but preview shows only Host for that early part.

## Dev

```
npm install
npm run typecheck
npm run dev        # browser preview (picker + sync + editor work; export needs the APK)
```
