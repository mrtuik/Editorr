# visuals: HTML/CSS visual engine (no photos)

- types, themes (10), motion (23 presets ported from open-motion by scripts/port-open-motion.mjs into motionPresets.json, + 5 hand-written fillers; MIT notice in THIRD_PARTY.md), fonts (data: URI), templates/ (14 types)
- render: HTML -> SVG foreignObject -> canvas (falls back to Canvas 2D in fallback2d.ts if the WebView taints it), bakeVisual (18 entrance frames + 1 still)
- beat: Visual -> DocuBeat (image + frames + framesMs, same path as Kallaway cards, so no native change). Lives in the docu lane.
- runner: Step A plan (grey placeholders), Step B one visual at a time, Stop keeps what is made, a failed slot is skipped
- ai: Antigravity plan + make-one prompts, every answer validated; local: offline planner (never 0 for speech)
- creatorLook: visualTheme + visualMix for every creator; preview: live tile frames; chip: "Visual 3/11 | Pause | Stop"
- UI is in screens/docuSheet.ts (Visuals: HTML | Photos & Video, + Visual at playhead, visual editor with Redo / Change style / Delete)

- v50: ease.ts = open-motion's cubic-bezier easing table; textAnim.ts = open-motion text animators (kinetic, wave/range selector, blur, pop, wipe reveal, typewriter, decode); templates use counter / barGrow / lineDraw / pieSweep / trim-path timings driven by ms; bake length = settleMs(v). Visuals are HTML/CSS/JS only (Photos & Video source removed).
- v52: reel graphics modelled on short-form talking-head edits: title_stack, pill_row, flow_diagram, geo_title (circles/squares/pixel blocks), cta_card, before_after, arrow_callout, window_card, halftone_frame; themes reel-dark / reel-light / reel-purple; local planner knows CTA / flow / before-after / arrow / app / tag-list sentences.

## Motion mode (B-roll pane > Motion)

Scenes are `Visual`s kept in `project.motion.scenes`. The pane (`src/screens/motionPane.ts`) plans them (`motionScript.ts`: Antigravity, or the built-in rules when it is not set up), shows them on the Live Canvas Monitor (`drawSceneFrame`), and **Render and place** turns each into a clip (`encode.ts`) that is placed as a full-frame `kind:'video'` B-roll beat with `motionSceneId`, so preview and the Media3 export need nothing new.

- Render path: WebCodecs H.264 + `mp4.ts` (small in-repo MP4 writer, no new dependency) -> `MediaRecorder` (real time) -> baked-frame picture beat in the docu lane. Frames are always `renderFrame()`, a pure function of time, so the file equals the monitor.
- Scenes last 1.5-5 s, stay out of docu/Kallaway ranges, and keep to the caption-safe zone unless "Use full frame" is on (`Visual.full`).
- New: types `radial_burst` (title) and `bracket_focus` (title, label = pill tag, items[0] = download badge); text animations `splitReveal`, `glitchIn`; theme `paper-red` (`textShadow`, `progressLine` theme fields).
- Clips live in `Directory.Data/broll/motion_<sceneId>_<stamp>.mp4`; deleting a beat/scene deletes its file when nothing else uses it, and `sweepClips` removes orphans when the sheet closes.
