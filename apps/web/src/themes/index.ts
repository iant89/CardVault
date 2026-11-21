/**
 * Scene themes are pure configuration: CSS backgrounds and lighting layers.
 * Card components never read these — the <ThemeScene> wrapper applies them
 * as CSS variables. To use your own artwork, set `backgroundImage` to a file
 * in /public/themes (e.g. '/themes/pokemon.jpg'); it is layered under the
 * gradients. No third-party artwork ships with CardVault.
 */
export interface SceneTheme {
  id: string;
  name: string;
  background: string;
  backgroundImage?: string;
  surface: string;
  light: string;
  accent: string;
}

const felt = (c1: string, c2: string) => `radial-gradient(ellipse at 50% 120%, ${c1}, ${c2} 70%)`;

export const THEMES: Record<string, SceneTheme> = {
  default: {
    id: 'default',
    name: 'Card Table',
    background: `radial-gradient(1200px 600px at 50% -10%, #23314f, transparent 70%), ${felt('#1d3b34', '#0e1716')}`,
    surface: 'repeating-linear-gradient(45deg, rgba(255,255,255,.015) 0 2px, transparent 2px 6px)',
    light: 'radial-gradient(800px 380px at 50% 0%, rgba(255,240,200,.14), transparent 70%)',
    accent: '#6ea8ff',
  },
  pokemon: {
    id: 'pokemon',
    name: 'Pokémon',
    background:
      'radial-gradient(700px 400px at 10% 0%, rgba(255,203,5,.45), transparent 60%), radial-gradient(800px 500px at 100% 10%, rgba(59,130,246,.5), transparent 60%), radial-gradient(700px 500px at 50% 120%, rgba(239,68,68,.35), transparent 65%), linear-gradient(180deg, #1b2a5a, #0f1630)',
    surface: 'radial-gradient(circle at 20% 30%, rgba(255,255,255,.06) 0 2px, transparent 3px) 0 0 / 46px 46px',
    light: 'radial-gradient(900px 420px at 50% -5%, rgba(255,255,220,.22), transparent 70%)',
    accent: '#ffcb05',
  },
  magic: {
    id: 'magic',
    name: 'Arcane',
    background:
      'radial-gradient(600px 400px at 50% 0%, rgba(120,70,200,.35), transparent 70%), radial-gradient(900px 500px at 50% 130%, rgba(200,120,40,.18), transparent 70%), linear-gradient(180deg, #17121f, #0a080e)',
    surface:
      'repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 38px), repeating-linear-gradient(90deg, rgba(255,255,255,.02) 0 1px, transparent 1px 64px), radial-gradient(ellipse at 50% 120%, rgba(90,80,70,.35), transparent 70%)',
    light: 'radial-gradient(500px 300px at 50% -5%, rgba(255,190,110,.25), transparent 70%)',
    accent: '#c9a2ff',
  },
  yugioh: {
    id: 'yugioh',
    name: 'Duel Arena',
    background:
      'conic-gradient(from 210deg at 50% 40%, rgba(80,200,255,.18), rgba(170,80,255,.2), rgba(255,200,80,.14), rgba(80,200,255,.18)), linear-gradient(180deg, #121722, #05070b)',
    surface: 'repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 1px, transparent 1px 12px), linear-gradient(180deg, transparent 40%, rgba(120,140,170,.12))',
    light: 'radial-gradient(700px 300px at 50% 0%, rgba(140,220,255,.22), transparent 70%)',
    accent: '#7fd7ff',
  },
  football: {
    id: 'football',
    name: 'Stadium',
    background:
      'radial-gradient(400px 220px at 15% 0%, rgba(255,255,255,.35), transparent 70%), radial-gradient(400px 220px at 85% 0%, rgba(255,255,255,.35), transparent 70%), linear-gradient(180deg, #0c1424 0%, #0c1424 35%, #1f6b33 35.2%, #185a2a 100%)',
    surface: 'repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0 3px, transparent 3px 12%)',
    light: 'linear-gradient(180deg, rgba(255,255,255,.08), transparent 50%)',
    accent: '#7ee787',
  },
  baseball: {
    id: 'baseball',
    name: 'Ballpark',
    background:
      'radial-gradient(500px 260px at 50% 0%, rgba(255,255,255,.25), transparent 70%), radial-gradient(ellipse 60% 40% at 50% 105%, #b7794a 0 55%, transparent 56%), linear-gradient(180deg, #0f1a2e 0%, #0f1a2e 30%, #2f7d3b 30.2%, #23652e 100%)',
    surface: 'repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 22px, transparent 22px 44px)',
    light: 'linear-gradient(180deg, rgba(255,250,230,.1), transparent 55%)',
    accent: '#ffd28a',
  },
  basketball: {
    id: 'basketball',
    name: 'Hardwood',
    background: 'radial-gradient(600px 300px at 50% 0%, rgba(255,230,180,.28), transparent 70%), linear-gradient(180deg, #2a1a10, #6b4423 40%, #8a5a32)',
    surface: 'repeating-linear-gradient(90deg, rgba(0,0,0,.12) 0 2px, transparent 2px 60px), repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 1px, transparent 1px 9px)',
    light: 'radial-gradient(700px 300px at 50% 0%, rgba(255,240,210,.15), transparent 70%)',
    accent: '#ff9f43',
  },
  hockey: {
    id: 'hockey',
    name: 'Ice Rink',
    background: 'radial-gradient(700px 300px at 50% 0%, rgba(255,255,255,.35), transparent 70%), linear-gradient(180deg, #c9dbea, #9fbad1)',
    surface: 'linear-gradient(90deg, transparent 49.6%, rgba(200,30,30,.5) 49.6% 50.4%, transparent 50.4%), linear-gradient(90deg, transparent 24.7%, rgba(30,80,200,.4) 24.7% 25.3%, transparent 25.3% 74.7%, rgba(30,80,200,.4) 74.7% 75.3%, transparent 75.3%)',
    light: 'linear-gradient(180deg, rgba(255,255,255,.2), transparent 60%)',
    accent: '#4aa3ff',
  },
};

export const themeFor = (game?: string | null) => THEMES[game ?? ''] ?? THEMES.default!;
