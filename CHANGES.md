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
