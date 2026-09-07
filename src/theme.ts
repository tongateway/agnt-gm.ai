// theme.ts — Telegram Mini-App design tokens (ported from the design's theme.jsx).

export interface Theme {
  accent: string;
  accentText: string;
  accentSoft: string;
  accentBorder: string;
  pageBg: string;
  cardBg: string;
  headerBg: string;
  inputBg: string;
  text: string;
  hint: string;
  sub: string;
  sep: string;
  botBubble: string;
  userBubble: string;
  userBubbleText: string;
  green: string;
  red: string;
  redSoft: string;
  amber: string;
  shadow: string;
  font: string;
  mono: string;
  cardRadius: number;
  // ── Bold 1c extras ──
  nestedBg: string;     // nested tiles/chips inside a card
  accentPressed: string; // terracotta emphasis text (#A94A2F)
  gold: string;         // amber accent
  goldSoft: string;     // amber tint bg
  sage: string;         // sage chip bg
  heroShadow: string;   // dark hero card shadow
  ctaShadow: string;    // terracotta CTA shadow
  tabShadow: string;    // floating tab bar shadow
}

// Event-card palettes (system messages in the chat feed), Bold direction.
export interface EventPalette { bg: string; border: string; chip: string; accent: string; }
export const EVENT_PALETTES: Record<'amber' | 'green' | 'terracotta' | 'neutral', EventPalette> = {
  amber:      { bg: '#F6EFDD', border: '#E6D3A6', chip: '#EAD9AE', accent: '#B08D4C' },
  green:      { bg: '#E4EEE4', border: '#C2DAC7', chip: '#D0E3D3', accent: '#2f8f6f' },
  terracotta: { bg: '#F8E9E1', border: '#ECCBBB', chip: '#F1D5C7', accent: '#C15B3D' },
  neutral:    { bg: '#F1EADA', border: '#E4DAC0', chip: '#E7DDC6', accent: '#8C8168' },
};

export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// AGNTDEV "Bold 1c" — a single warm cream/terracotta/green palette (no
// dark variant in this design; the theme toggle is gone with it).
export function tgTheme(): Theme {
  return {
    accent: '#C15B3D',            // terracotta — primary CTA
    accentText: '#FBF8EF',        // cream text on terracotta
    accentSoft: '#F8E9E1',        // terracotta tint (soft fills)
    accentBorder: '#C15B3D',      // strong terracotta (selected chip / quick-reply)
    pageBg: '#ECE4CE',            // screen background
    cardBg: '#FBF8EF',            // raised card surface
    headerBg: '#FBF8EF',          // header / footer chrome
    inputBg: '#F6F1E3',           // flat card / composer field
    nestedBg: '#F1EADA',          // nested tiles/chips inside a card
    text: '#22402E',              // ink / primary green
    hint: '#B3A98C',
    sub: '#8C8168',
    sep: '#E4DAC0',               // borders
    botBubble: '#FBF8EF',         // assistant bubble (cream)
    userBubble: '#22402E',        // owner bubble (green)
    userBubbleText: '#F3ECD8',    // cream text
    green: '#3AA98B',             // success
    red: '#C15B3D',               // "needs fix" reads as terracotta here
    redSoft: '#F3DBCF',
    amber: '#B08D4C',             // gold
    accentPressed: '#A94A2F',
    gold: '#B08D4C',
    goldSoft: '#F1E7CF',
    sage: '#E1E8D6',
    shadow: '0 10px 26px -18px rgba(34,64,46,0.3)',
    heroShadow: '0 16px 32px -18px rgba(34,64,46,0.6)',
    ctaShadow: '0 9px 19px -9px rgba(193,91,61,0.7)',
    tabShadow: '0 12px 26px -14px rgba(34,64,46,0.4)',
    font: '"Onest", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
    cardRadius: 18,
  };
}

// ── per-bot tile colours (harmonious, share chroma/lightness) ──
const TILE: Record<string, string> = {
  blue: '#2A8BD9',
  teal: '#129B8B',
  green: '#1FA058',
  amber: '#CC8A1E',
  purple: '#7C5CFC',
  rose: '#E0533D',
  indigo: '#5B6CE0',
  slate: '#6B7585',
};
const TILE_KEYS = Object.keys(TILE);

export function tile(key: string): { fg: string; bg: string } {
  const fg = TILE[key] || TILE.slate;
  return { fg, bg: hexA(fg, 0.11) };
}

// deterministic tile colour for a real bot (hash of its slug)
export function toneFor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return TILE_KEYS[h % TILE_KEYS.length];
}

export const btnReset: React.CSSProperties = {
  border: 'none', background: 'none', padding: 0, margin: 0, font: 'inherit',
  cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
};
