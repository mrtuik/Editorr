import type { VisualTheme } from './types';

/** Fallback fonts keep Bengali and Hindi working (the face is the data: font, the Noto faces come from the phone). */
const SANS = "'EdPoppins','EdInter','Noto Sans Bengali','Noto Sans Devanagari','Noto Sans',sans-serif";
const SERIF = "'EdSerif','Noto Serif Bengali','Noto Serif Devanagari','Noto Serif',serif";
const MONO = "'EdMono','Noto Sans Mono','DejaVu Sans Mono',monospace";

const T = (t: Omit<VisualTheme, 'font' | 'serif' | 'mono'> & Partial<Pick<VisualTheme, 'font' | 'serif' | 'mono'>>): VisualTheme =>
  ({ font: SANS, serif: SERIF, mono: MONO, ...t });

export const VISUAL_THEMES: VisualTheme[] = [
  T({ id: 'kallaway', name: 'Kallaway', bg: '#0b0b0d', card: 'rgba(14,14,16,0.82)', text: '#f5f5f5', muted: '#9a9aa2', accent: '#ff3b30', highlight: '#ffffff',
    radius: 36, shadow: '0 24px 80px rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.10)',
    motionSet: { in: ['curtainRise', 'blurReveal', 'slideUp', 'reveal3d'], hold: ['float', 'breathingLight'], out: ['sinkExit', 'fadeOut'] , text: ['kinetic', 'blur']} }),
  T({ id: 'hormozi', name: 'Hormozi', bg: '#000000', card: '#000000', text: '#ffffff', muted: '#b8b8b8', accent: '#ffd400', highlight: '#ffd400',
    radius: 18, shadow: 'none', border: '4px solid #ffd400',
    motionSet: { in: ['elasticScale', 'kineticText', 'scaleIn'], hold: ['pulse', 'heartbeat'], out: ['collapseDown', 'zoomOut'] , text: ['pop', 'kinetic']} }),
  T({ id: 'vox', name: 'Vox', bg: '#1e3cff', card: '#1e3cff', text: '#ffffff', muted: '#c9d2ff', accent: '#ffe14d', highlight: '#ffe14d',
    radius: 6, shadow: '0 14px 0 rgba(0,0,0,0.25)', border: 'none',
    motionSet: { in: ['slideLeft', 'wipe', 'slideRight'], hold: ['shimmer', 'none'], out: ['slideOut', 'slideUpExit'] , text: ['reveal', 'kinetic']} }),
  T({ id: 'noir', name: 'Noir', bg: '#0a0a0a', card: 'rgba(10,10,10,0.9)', text: '#ededed', muted: '#8d8d8d', accent: '#d9d9d9', highlight: '#ffffff',
    radius: 4, shadow: '0 30px 90px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.18)', font: SERIF,
    motionSet: { in: ['slowFade', 'blurReveal'], hold: ['breathingLight', 'none'], out: ['fadeOut', 'dissolve'] , text: ['blur', 'reveal']} }),
  T({ id: 'keynote', name: 'Keynote', bg: '#f2f2f4', card: '#f2f2f4', text: '#1d1d1f', muted: '#6e6e73', accent: '#0a84ff', highlight: '#0a84ff',
    radius: 40, shadow: '0 20px 60px rgba(0,0,0,0.25)', border: 'none',
    motionSet: { in: ['scaleIn', 'slideUp', 'reveal3d'], hold: ['float', 'none'], out: ['fadeOut', 'sinkExit'] , text: ['wave', 'blur']} }),
  T({ id: 'swiss', name: 'Swiss', bg: '#ffffff', card: '#ffffff', text: '#111111', muted: '#666666', accent: '#e10600', highlight: '#e10600',
    radius: 0, shadow: 'none', border: '6px solid #111111',
    motionSet: { in: ['wipe', 'slideLeft', 'textReveal'], hold: ['none'], out: ['slideOut', 'fadeOut'] , text: ['reveal', 'kinetic']} }),
  T({ id: 'cyber', name: 'Cyber', bg: '#05060f', card: 'rgba(5,6,15,0.88)', text: '#e8fbff', muted: '#6fa8b8', accent: '#00f0ff', highlight: '#ff2bd6',
    radius: 14, shadow: '0 0 40px rgba(0,240,255,0.35)', border: '2px solid #00f0ff', font: MONO,
    motionSet: { in: ['blurReveal', 'kineticText', 'wipe'], hold: ['neonPulse', 'pulse'], out: ['dissolve', 'zoomOut'] , text: ['scramble', 'type']} }),
  T({ id: 'code', name: 'Code', bg: '#0d1117', card: '#0d1117', text: '#e6edf3', muted: '#8b949e', accent: '#58a6ff', highlight: '#3fb950',
    radius: 16, shadow: '0 20px 60px rgba(0,0,0,0.5)', border: '1px solid #30363d', font: MONO,
    motionSet: { in: ['textReveal', 'slideUp', 'fade'], hold: ['none', 'breathingLight'], out: ['fadeOut', 'sinkExit'] , text: ['type', 'scramble']} }),
  T({ id: 'minimal-light', name: 'Minimal light', bg: '#fafafa', card: '#fafafa', text: '#18181b', muted: '#71717a', accent: '#18181b', highlight: '#18181b',
    radius: 28, shadow: '0 16px 50px rgba(0,0,0,0.22)', border: 'none',
    motionSet: { in: ['slowFade', 'slideUp'], hold: ['none', 'float'], out: ['fadeOut'] , text: ['blur', 'kinetic']} }),
  T({ id: 'minimal-dark', name: 'Minimal dark', bg: '#111113', card: '#111113', text: '#f4f4f5', muted: '#a1a1aa', accent: '#f4f4f5', highlight: '#f4f4f5',
    radius: 28, shadow: '0 16px 50px rgba(0,0,0,0.5)', border: 'none',
    motionSet: { in: ['slowFade', 'slideUp'], hold: ['none', 'float'], out: ['fadeOut'] , text: ['wave', 'blur']} }),
  // reel looks, drawn after real short-form edits: dark + red box highlight, light + heavy red type, purple glass
  T({ id: 'reel-dark', name: 'Reel dark', bg: '#050505', card: '#050505', text: '#ffffff', muted: '#8a8a92', accent: '#e5192b', highlight: '#ffffff',
    radius: 0, shadow: 'none', border: 'none', motionSet: { in: ['fade', 'slideUp'], hold: ['none'], out: ['fadeOut'], text: ['kinetic', 'blur', 'wave'] } }),
  T({ id: 'reel-light', name: 'Reel light', bg: '#ecebef', card: '#ecebef', text: '#1b1b1d', muted: '#7d7d84', accent: '#c1121f', highlight: '#c1121f',
    radius: 0, shadow: 'none', border: 'none', motionSet: { in: ['scaleIn', 'slideUp'], hold: ['none'], out: ['fadeOut'], text: ['pop', 'kinetic', 'reveal'] } }),
  T({ id: 'reel-purple', name: 'Reel purple', bg: '#120a2e',
    card: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.045) 0px, rgba(255,255,255,0.045) 2px, transparent 2px, transparent 24px), linear-gradient(165deg, #2a1a66 0%, #0c0824 55%, #3a2290 100%)',
    cardSolid: '#160d38', text: '#ffffff', muted: '#b4a8e8', accent: '#8b5cf6', highlight: '#ffffff',
    radius: 36, shadow: '0 20px 70px rgba(80,40,200,0.35)', border: '1px solid rgba(255,255,255,0.12)', motionSet: { in: ['blurReveal', 'scaleIn'], hold: ['float'], out: ['fadeOut'], text: ['blur', 'kinetic', 'wave'] } }),
];

export const DEFAULT_THEME_ID = 'minimal-dark';
export const getTheme = (id: string): VisualTheme => VISUAL_THEMES.find(t => t.id === id) ?? VISUAL_THEMES.find(t => t.id === DEFAULT_THEME_ID)!;
