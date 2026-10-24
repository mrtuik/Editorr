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

## v5 changes (CapCut-style pass)

- Slim timeline: ruler 16 px, two waveform rows 20 px, layout row 30 px. The preview takes the freed space and now fits the real aspect ratio.
- Aspect ratio: 16:9, 9:16, 1:1, 4:5, 4:3 (toolbar > ratio icon). Used by preview and export (`outputSize()` in `core/types.ts`).
- Crop: zoom + move for Host and Constant separately (toolbar > crop icon). Preview and Media3 `Crop` use the same math.
- Silence cut: finds parts where BOTH mics are quiet for N seconds (0.3 to 5 s), keeps a little padding, removes the same moment from both videos. Shown as red before cutting, striped gaps after. Undo works. Export skips cut parts (`exportProject` builds one clip per kept part).
- Home screen rebuilt with CapCut's layout: search, "Get started", New project + Continue cards, recent strip, 3-column tool grid, bottom tabs (Edit / Projects / Me). Colors stay black.

Still to do: IndexedDB storage + keeping the picked videos out of the cache folder, and a stable signing key so a new APK installs as an update.

## Updating the APK without uninstalling

Android only installs a new APK over an old one when both are signed with the SAME key and the new `versionCode` is higher. The workflow now does both:

- `versionCode` = GitHub run number, `versionName` = `16.3.1`.
- Every build (signed release APK) uses one fixed keystore.
- `applicationId` stays `com.tuik.editorr`.
- The only APK uploaded is `Editorrr-apk` (named `Editorrr-v16.3.1.apk`).

### Keystore: do this once (recommended)

1. Make a key on any computer with Java (or Termux): 
   `keytool -genkeypair -v -keystore release.jks -alias editorr -keyalg RSA -keysize 2048 -validity 36500`
2. Turn it into text: `base64 -w0 release.jks` (on Mac: `base64 -i release.jks`).
3. GitHub repo > Settings > Secrets and variables > Actions > New repository secret. Add 4 secrets:
   `KEYSTORE_BASE64` (the text from step 2), `KEYSTORE_PASSWORD`, `KEY_ALIAS` (editorr), `KEY_PASSWORD`.
4. Keep `release.jks` and the passwords safe. If you lose them you must uninstall once to change keys.

### No secrets set

The workflow creates a key on the first run and saves it in the GitHub Actions cache, so later builds reuse it. Two warnings:
GitHub deletes a cache that is not used for 7 days, and then the next build makes a NEW key (you must uninstall once).
So after the first run, download the `Editorr-keystore-BACKUP` artifact and put it in the secrets as above
(`base64 -w0 release.jks`, password `editorr-ci-pass`, alias `editorr`).

### One-time uninstall

Your currently installed APK was signed with a random debug key, so install the first new build after uninstalling the old app once. After that every build installs as an update.

## Storage (v7)

- Projects, settings and thumbnails are in IndexedDB (`core/store.ts`, async API). Old localStorage data is moved over once at first launch. `navigator.storage.persist()` is requested at start.
- Picked videos are copied to the app files folder (`filesDir/videos`), not the cache, so Android never clears them. Audio PCM, preview copies and export temp files stay in the cache and are rebuilt when needed.
- Opening a saved project checks both videos are still there, decodes the audio again, and goes straight to the editor. If a video is missing you get the Import screen.
- Deleting a project deletes its video copies. At launch, videos that no project uses (cancelled imports) are removed.
- Settings > Storage shows projects, saved videos, cache and free space. "Clear cache" only empties temporary files. "Delete all projects" removes projects and their video copies.
- Saved with the project: cut parts (segments with gaps), aspect ratio, crop of both videos, layouts, offset, audio choice.

## v8 (CapCut-style editor)

- No separate Sync / Analyze screens. Import -> Editor. Reading audio, syncing and auto switch run inside the editor and show as pills over the preview ("Reading audio 40%", "Syncing audio", "Detecting who is speaking").
- Timeline like CapCut: lane icons on the left (tap the speaker to pick that mic), Host clip and Constant clip with picture strips and waveforms, layout lane below. Time (00:34 / 10:22) sits top-left of the ruler.
- Sync inside the timeline: tap the green Constant clip (or the Sync tool), then drag it, or use -1s ... +1s buttons, or Auto sync. Snaps to Host start, playhead and common end (cyan line). Undo/redo covers sync too.
- Preview: Host video is the clock while playing, seeks are never queued, and heavy formats (HEVC, 50/60 fps, >1080p) get a small preview copy BEFORE playing, so nothing stalls halfway. If the WebView fails mid-play, it pauses, makes the copy and continues from the same spot.
- Import: tiles with first-frame picture, spinner + percent while the video is copied, pick both videos in one go.
- Crop: pinch and drag on the preview, cyan center guides.
- Native: multi-select picker with copy progress, timeline thumbnails (MediaMetadataRetriever), concurrent preview copies, faster audio decode.

Settings page: waiting for the CapCut reference screenshot.

## v11 (CapCut tool design)

- Bottom sheets now follow CapCut: a row of rounded icon tiles (selected = white outline), a thin divider, the title centered and a check on the right. Used by Ratio, Layout, On screen, Audio, Sync, Crop and Silence. The timeline stays visible above the sheet.
- Tap a segment (layout row) or the Host clip: the toolbar swaps to clip tools (Split, Layout, On screen, Audio, Crop, Merge, Delete, Swap) with CapCut's grey back chevron on the left. Tap empty space or the chevron to go back to the main tools.
- Main tools (nothing selected): Sync, Auto switch, Lips scan, Silence, Layout, On screen, Audio, Crop, Ratio, Zoom.
- Nothing is selected when the editor opens (it used to pre-select the first segment).

## v12 (videos stay saved, Settings redesign)

- Why videos vanished: they were only linked to the project when "Add to timeline" was pressed, and the launch cleanup deleted any video no project used. If the database could not be read once, the cleanup also saw "no projects" and deleted everything. Fixed: videos are saved into the project (IndexedDB) the moment they are picked or swapped; cleanup runs only when the project list was read successfully; and the app never deletes a video file younger than 24 h.
- Browser build: the video files themselves are now stored as Blobs in IndexedDB (`media` store, DB version 2), so they survive a reload. The Android app keeps files in its private folder (too big for a database) and stores the paths in IndexedDB.
- No localStorage is used. The old localStorage data is moved to IndexedDB once and removed.
- Settings page rebuilt in CapCut style: grouped rounded cards, option chips, storage bar with legend, action rows.
- New Sync and Swap icons.
