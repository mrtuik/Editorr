# visuals: HTML/CSS visual engine (no photos)

- types, themes (10), motion (23 presets ported from open-motion by scripts/port-open-motion.mjs into motionPresets.json, + 5 hand-written fillers; MIT notice in THIRD_PARTY.md), fonts (data: URI), templates/ (14 types)
- render: HTML -> SVG foreignObject -> canvas (falls back to Canvas 2D in fallback2d.ts if the WebView taints it), bakeVisual (18 entrance frames + 1 still)
- beat: Visual -> DocuBeat (image + frames + framesMs, same path as Kallaway cards, so no native change). Lives in the docu lane.
- runner: Step A plan (grey placeholders), Step B one visual at a time, Stop keeps what is made, a failed slot is skipped
- ai: Antigravity plan + make-one prompts, every answer validated; local: offline planner (never 0 for speech)
- creatorLook: visualTheme + visualMix for every creator; preview: live tile frames; chip: "Visual 3/11 | Pause | Stop"
- UI is in screens/docuSheet.ts (Visuals: HTML | Photos & Video, + Visual at playhead, visual editor with Redo / Change style / Delete)
