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
| Autoframe: one tap finds faces (MediaPipe FaceLandmarker, 4 samples/s while the video plays fast, on device), cuts to whoever speaks (voice + real lip opening) and centres that person in every clip for the chosen ratio. Faces tool: tap which person to follow when a video shows more than one | Built, not yet tested on a phone |
| (removed) old pixel-based Lips scan: samples face-area movement from both videos and fuses it with voice (Auto switch with lips) | Built, tested on synthetic data only |
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

## v16.10.0: automatic Auto BGM, Auto SFX, music row on the timeline

- **Auto BGM is automatic.** Music > Auto BGM > Generate: the app listens to the voice (loudness, speed, ups and downs) and the captions, cuts the video into parts by mood (calm, emotional, energetic, funny, serious), and picks a song for each part. Language chips: English / Hindi / Telugu. Each song can be played (first 25 s) before Apply. Songs come from YouTube; if YouTube fails for any reason, music made on the phone (`src/core/synth.ts`) is used instead, so Generate always gives a result. The red hint shows why YouTube was skipped.
- **Search lives only in Music > Music** (top of the sheet).
- **Auto SFX.** Music > SFX > Auto add effects: a whoosh where the layout changes, a soft pop where the camera moves to the other person. Effects are made on the phone. Effect volume slider.
- **Music row on the timeline** (under the audio row): bars for Auto BGM parts (teal, with mood and song name and a waveform), hand-placed songs (blue) and effects (amber). Empty row shows "+ Add music". Tap the row to open Music.
- Files: `src/core/mood.ts` (mood sections), `src/core/synth.ts` (made-here music and effects), `src/core/bgm.ts` (clips can now have an end time and loop), `src/screens/musicSheet.ts`, `src/screens/editor.ts`.
- Not done yet: dragging or trimming the bars on the timeline; YouTube download still depends on the native YouTube code (see v16.9.1 notes).

## v16.9.3: one sheet design everywhere, lime only as a tiny accent

All bottom sheets share one look (end of `src/style.css`): flat black `#121212`, 24px top corners, grey pill buttons, ONE white pill for the main action, pill chips (selected = white with black text), rounded rows. Lime is only a tiny accent: slider fill and thumb, download progress, the added tick, the export tab underline. Covers: auto edit options, captions, text, zoom, reaction, face options / face pick, the CapCut tool panels, project menu, long-press menu, export settings, Music and YouTube. The in-progress task sheet keeps its own CapCut design.

## v16.9.1: YouTube always on, LoveMusic look

- **Nothing to tick any more.** The YouTube module is part of every build. The `youtube` checkbox in Run workflow and the `EDITORR_YOUTUBE` variable are gone (the build always uses the real module).
- **Search shows all songs.** The old "Creative Commons only" tick was ON by default, which hid almost every normal song. It is removed. Search always returns everything.
- **YouTube search is easy to find.** Music > Music has the search box at the top. Auto BGM has "Add from YouTube" above "Add songs from phone". If YouTube cannot be reached, a red message says why (before, the button was silently hidden).
- **Download is tougher.** Tries ANDROID_VR 1.65.10, then 1.60.19, then iOS. If YouTube refuses the Range header, the same piece is asked again with the `range=` link parameter.
- **Music and YouTube sheets use the LoveMusic look:** flat black, pill buttons and pill tiles, rounded song rows with a round + / % / tick button.
- Not compiled against Android and not run on a phone in this session (no network here).

## v16.9.0: optional YouTube songs (Music > Auto BGM > Add from YouTube)

Music sheet now has three tools (like CapCut's Audio menu): **Auto BGM** (songs under the whole video), **Music** (search YouTube or pick a song, it starts at the playhead, play once, can duck under the voice) and **SFX**. All three are mixed into one track by Apply.

Search a song on YouTube, tap it, the audio is saved on the phone and added to Auto BGM like a song from the phone. Everything is inside Editorr (pure Java, no extra library, no Kotlin, no JDK 21).

**Default build: ON.** Every build (push or Run workflow) includes it, and the APK name stays `Editorrr-vX.apk`, so updates install over the old one.

**Turn it OFF** (build without YouTube, same as before): Run workflow and untick `youtube`, or set the repo variable `EDITORR_YOUTUBE` = `0`. Then `native/android/youtube/stub/YouTubeBridge.java` is used and the YouTube search is hidden. Locally: `EDITORR_YOUTUBE=1 VITE_YOUTUBE=1`, then `npx vite build` and `python3 scripts/patch-android.py`.

Notes:
- Search has "Creative Commons only" ON by default. Turn it off for all results (Bollywood / English songs can get a claim or be muted when posted).
- Downloaded audio is kept in the app music folder for 2 days, then removed. The baked music track stays with the project.
- YouTube changes its app values often. If search works but download fails with "no audio", refresh the `CLIENT` / `*_VERSION` / `*_UA` constants at the top of `native/android/youtube/real/YouTubeBridge.java`.
- Not compiled against Android and not run on a phone yet. The Java was only syntax and type checked with a stand-in for `org.json`.


## Enhanced Audio (v16.11)

Editor > **Enhanced** (bottom bar) or Audio > *Enhanced Audio*. A see-through bottom sheet, so the video keeps playing while you tweak.

- Targets: **Host**, **Guest** (the Constant video) and **Master** (voice + music). Only the mic that is the audio source is heard / exported.
- 6-band parametric EQ on a 20 Hz - 20 kHz graph: low-cut, chest/body (60-300 Hz), boxiness (150-900 Hz), presence, crispness, air. Drag the dots, fine-tune with Frequency / Gain / Q sliders.
- De-noise slider inside Enhanced Audio (Host / Guest): the same value as the Denoise tool. Presets can set it.
- v16.11.3 redesign: real on/off switches, square preset tiles with a mini EQ curve, no Host/Guest tabs (the audio-source mic is used; a small Voice / Whole mix switch stays), new Enhanced tool icon, slider tracks fixed everywhere (the `--fill` colour variable in :root broke the gradient; sliders now use `--rf`), centered small task card and a small capsule above the tools for minimized tasks.
- **Gavin Radio Voice** preset: the Premiere Pro chain (boxiness cut at 800 Hz, chest boost at 150 Hz, presence, air -3 dB, de-ess, light de-noise, compressor, -1 dB limiter).
- De-esser, vocal compressor, output gain and a brickwall limiter (default ceiling -1 dBFS).
- Presets: Cinematic Studio, Warm Podcast, Crisp & Clear, Radio Broadcast, Clean & Intimate, plus your own (Save as preset, Overwrite, Rename, Delete, Reset). Your presets live in the phone's local storage.
- **A/B** = hear the original while you edit. Preview only; the export always has the effect.

How preview and export stay the same: `src/core/fx.ts` (settings + biquad maths), `src/core/fxWorklet.ts` (de-esser/compressor/limiter in the preview), and `FxProcessor` in `native/android/EditorrNativePlugin.java` (the same maths in the Media3 export). Change all three together. `fxToFfmpeg()` in fx.ts prints the equivalent FFmpeg `-af` string for desktop use; the phone export does not run FFmpeg.

### Audio tools (v16.11.1)
Tap the audio row (or the Audio tool): the bottom bar shows the sound tools of the mic that is the audio source: Volume, Split, Denoise, Enhanced, Silence, Delete. Back returns to the main tools.
