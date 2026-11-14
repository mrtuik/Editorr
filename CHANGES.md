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
