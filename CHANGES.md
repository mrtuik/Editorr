# Remove BG: SAM 2 + RVM, preview and export
- Tool **Remove BG** (main row, clip tools, segment tools). Sheet: engine (**SAM 2** or **RVM**), Host/Constant, quality, what goes behind the person (blur, black, white, green, custom), Restore original.
- **SAM 2** (`core/bgremove/sam.ts`): sharpest cut of one person; uses the face scan for its prompt points. Models download once (~150 MB, SharpAI/sam2-hiera-tiny-onnx).
- **RVM** (`core/bgremove/rvm.ts`): made for video, 4 recurrent tensors keep the edges steady, finds people by itself, no face scan. MobileNetV3 fp32 (~15 MB) is bundled by CI into `public/rvm` (GitHub release as fallback). GPL-3.0.
- Both write the same mask track (IndexedDB `bgmask:<project>:<role>`); `BgCutter` draws person-over-background on a canvas over the video in the preview (hold **Raw** to compare). RVM keeps its saved masks under ~120 MB (long videos get fewer masks per second).
- **Export**: `core/bgremove/bake.ts` renders each cut-out video to an H.264 file (WebCodecs, 60 s pieces) before exporting; new native `muxAudio` (EditorrNativePlugin.java) joins the pieces and copies the original sound; the exporter then uses that file for that video. The file is reused until the cut-out changes. If the WebView cannot play the original (4K, HEVC) a small H.264 copy (`makeProxy`) supplies the pictures. Progress is the first 40% of the export bar.
- New dependency `onnxruntime-web@1.20.1`; CI step `npm run ort-assets` (wasm files + RVM model).
- Not compiled or run on a phone here; `tsc` shows only the old missing-module errors, `muxAudio` (Java) is unchecked. Baking is slow (seeks every frame): roughly 1 to 3 min per minute of video.

# v55.2
- Shapes card (rings, orbiting dots, squares: `geo_title`) is never picked automatically any more (all templates, offline and AI). It stays in the manual picker only.
- New default caption style (from the reference "final video"): calm medium sans, one key word per line in bold italic serif, centred lower-middle (y 0.66), no heavy outline. Also a caption template "Final Cut"; Joseph Inspired uses the same. Other templates do not inherit its font pairing.
- Card text is never Hindi/Bengali script: AI prompt says English or Roman letters; offline text is romanized (visual cards, docu cards, Kallaway cards).

# v55.1: progress bar redesigned (full width, flat, thin progress line, no spinner)

# Editorr v55: Joseph Inspired template (from joseph_creator_template_spec.md)

New creator template **Joseph Inspired** (`joseph_inspired`, Templates > Talking Head, first tile). An original look inspired by the editing grammar of a reference reel; no creator name, logo, wording or app screen is copied.
- `core/creators.ts`: id, template (dark base, emerald accent as an editable default, neutral grade, safe-area caption y 0.74), card theme, calm fade/slide transitions, restrained 1.06 punch-in, music and SFX OFF by default, category entry. Existing ids untouched.
- `core/visuals/themes.ts`: new `joseph` theme (slow fades, no glitch). `creatorLook.ts`: proof number, roadmap, old-vs-new, generic app window, topic pills, CTA.
- `core/visuals/local.ts`: for this template only, posting steps (tag / location / upload / share) -> generic `window_card`; plain speech with nothing to prove stays a talking head. Other templates behave as before.
- `core/visuals/ai.ts`: extra Joseph rules in the plan prompt (numbers only if spoken, no names/logos, no filler cards).
- `screens/editor.ts` + `style.css`: **Raw** button on the preview. Hold = source video only (no cards, B-roll, texts, captions, grade, window move); release = edited. Same playhead and playback. Nothing in the project changes.
- `screens/docuSheet.ts`: a card now shows the spoken words it was made from, so it can be checked against them.
Not done (stay as they were): split-screen Raw/Edited export, per-edit accept/reject list, a CTA text field (the CTA card appears only when the speaker asks for a comment/follow, or you add it with + Visual), punch-in zooms are not hidden by Raw.
Android code: not compiled or run here. `tsc` run without node_modules: no new errors compared with v54 (missing-module errors are the same).

# Editorr v53: B-roll Motion mode

New: B-roll > "Search in" > **Motion** (Live Canvas Monitor, Generate motion, + Scene at playhead, Render and place).
Files: `src/core/visuals/{mp4,encode,motionScript}.ts`, `src/screens/motionPane.ts`; edited `types.ts`, `textAnim.ts`, `themes.ts`, `render.ts`, `fallback2d.ts`, `local.ts`, `ai.ts`, `preview.ts`, `templates/{index,util}.ts`, `core/{types,brollTypes}.ts`, `screens/brollSheet.ts`, `style.css`.
Model additions are all optional: `Project.motion`, `BrollBeat.{motionSceneId,renderFps,motionSig}`, `Visual.full`, `VisualTheme.{textShadow,progressLine}`.
No new npm dependency (a 150-line MP4 writer replaces mp4-muxer).
Known, pre-existing: `npm run typecheck` fails on `screens/analyze.ts` / `screens/sync.ts` (`'sync'`/`'analyze'` are not in `ScreenName`); same on v52.

## v53.1
- Docu-lane visuals are now full-screen (`Visual.bleed`): the card background fills the whole frame, text stays above the captions. Old visuals must be redone (Redo / regenerate) to bake the new look.
- Paper-red progress line was never drawn (bad hook); fixed.
- Choppy playback at cuts: the preview copy now has a key frame every 0.5 s (`makeProxy`, new cache name `proxyk_`), and the host always gets a preview copy when the project has cuts (`hasCuts()` in editor.ts). Android code: not compiled or run here.

## v54: glass-card motion graphics (from broll_motion_graphics_master_plan.md)
- 6 new scene types in `templates/glass.ts`: glass_card_hero, curved_arrow_callout, before_after_split, stat_pill_counter, workflow_steps, command_palette. New optional data: badge, subtitle, stat, arrowLabel.
- Full-screen backdrop now has soft accent glows, so cards float on a lit background instead of a flat wall (bleed stays on: no empty strips).
- Antigravity prompts (`ai.ts`) ask for the glass types and the new layers; the "never invent numbers" rule is kept. AI `trend` is now actually read.
- Offline planner prefers the new types (number -> stat pill, comparison -> old vs new, steps -> workflow, tool/app -> command bar).
- Not applied from the plan: removing the cut look-ahead (`lead`) and throttling `refresh()` (see reply).
