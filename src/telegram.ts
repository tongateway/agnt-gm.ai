// telegram.ts — thin wrapper over the Telegram WebApp bridge: lifecycle,
// chrome colours, viewport insets, the native BackButton, haptics and links.

interface SafeAreaInset { top: number; bottom: number; left: number; right: number }

interface TelegramWebApp {
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent(event: string, cb: () => void): void;
  offEvent(event: string, cb: () => void): void;
  openLink?(url: string): void;
  openTelegramLink?(url: string): void;
  initData?: string;
  platform?: string;
  version?: string;
  isVersionAtLeast?(version: string): boolean;
  // ── vertical swipe control (Bot API 7.7+) ──
  // The drag-down-to-minimise/close gesture. Absent on older clients.
  isVerticalSwipesEnabled?: boolean;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  isExpanded?: boolean;
  // Native haptics (Bot API 6.1+). Absent on old clients / plain browsers.
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  // ── fullscreen mode (Bot API 8.0+) ──
  isFullscreen?: boolean;
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  safeAreaInset?: SafeAreaInset;        // device chrome (status bar / notch)
  contentSafeAreaInset?: SafeAreaInset; // Telegram's own controls over the content
  initDataUnsafe?: { user?: { language_code?: string } };
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const webApp: TelegramWebApp | undefined = window.Telegram?.WebApp;

// telegram-web-app.js defines WebApp even in a plain browser; only trust it
// when we're actually running inside a Telegram container.
export const insideTelegram: boolean =
  !!webApp && (webApp.platform ?? 'unknown') !== 'unknown' && !!webApp.initData;

// Fullscreen is a mobile-only Bot API 8.0 feature. Desktop/web clients fire
// `fullscreenFailed` (UNSUPPORTED), so gate on platform + version up front.
const FULLSCREEN_PLATFORMS = new Set(['android', 'ios']);

function fullscreenCapable(): boolean {
  return (
    insideTelegram && !!webApp &&
    FULLSCREEN_PLATFORMS.has(webApp.platform ?? '') &&
    !!webApp.isVersionAtLeast?.('8.0') &&
    typeof webApp.requestFullscreen === 'function'
  );
}

// In fullscreen the native header is gone, so content sits under the status bar
// and Telegram's floating close/menu controls, and the home indicator overlaps
// the bottom edge (where the chat composer lives). Expose both insets as CSS
// variables: the app root pads by --tg-fs-top, the composer by --tg-fs-bottom.
// Outside fullscreen the variables are REMOVED (not zeroed) so a
// `var(--tg-fs-bottom, env(safe-area-inset-bottom))` still reaches its fallback.
function syncFullscreenInset(): void {
  if (!webApp) return;
  const root = document.documentElement.style;
  if (!webApp.isFullscreen) { root.removeProperty('--tg-fs-top'); root.removeProperty('--tg-fs-bottom'); return; }
  const top = (webApp.safeAreaInset?.top ?? 0) + (webApp.contentSafeAreaInset?.top ?? 0);
  const bottom = (webApp.safeAreaInset?.bottom ?? 0) + (webApp.contentSafeAreaInset?.bottom ?? 0);
  root.setProperty('--tg-fs-top', `${top}px`);
  root.setProperty('--tg-fs-bottom', `${bottom}px`);
}

// Stop the sheet from following the finger. Telegram's default is that a
// vertical drag anywhere in the Mini App minimises or closes it — which fights
// every gesture of our own: the bot rows swipe sideways, and a drag that starts
// even slightly off-axis grabs the whole app instead of the row, so the sheet
// slides half-way down the screen mid-swipe.
//
// disableVerticalSwipes() is the documented remedy (Bot API 7.7+). The docs ask
// that it only be used when the app has competing gestures — it does — and
// closing stays available the whole time through the header's Close button and
// the chevron, so nobody gets trapped inside.
//
// Older clients have no such method. There the fallback is to undo the drag:
// viewportChanged fires as the sheet is pulled, and re-expanding snaps it back
// instead of leaving it parked half-open.
function lockVerticalSwipes(): void {
  if (!insideTelegram || !webApp) return;
  if (webApp.isVersionAtLeast?.('7.7') && typeof webApp.disableVerticalSwipes === 'function') {
    try { webApp.disableVerticalSwipes(); return; } catch { /* fall through to the re-expand guard */ }
  }
  const reExpand = () => { if (webApp && webApp.isExpanded === false) webApp.expand(); };
  webApp.onEvent('viewportChanged', reExpand);
}

export function initTelegram(): void {
  if (!insideTelegram || !webApp) return;
  webApp.ready();
  webApp.expand();
  lockVerticalSwipes();
  if (!fullscreenCapable()) return;
  try { webApp.requestFullscreen!(); } catch { /* older client raced the gate — ignore */ }
  // insets land asynchronously (after fullscreenChanged) and can shift on
  // rotation, so re-read them on every relevant event.
  webApp.onEvent('fullscreenChanged', syncFullscreenInset);
  webApp.onEvent('safeAreaChanged', syncFullscreenInset);
  webApp.onEvent('contentSafeAreaChanged', syncFullscreenInset);
  syncFullscreenInset();
}

export function syncChrome(headerColor: string, bgColor: string): void {
  if (!insideTelegram) return;
  webApp?.setHeaderColor?.(headerColor);
  webApp?.setBackgroundColor?.(bgColor);
}

// ── native BackButton (replaces the mocked in-app header inside Telegram) ──
export function backButtonOnClick(cb: () => void): () => void {
  const bb = insideTelegram ? webApp?.BackButton : undefined;
  if (!bb) return () => {};
  bb.onClick(cb);
  return () => bb.offClick(cb);
}

export function backButtonVisible(visible: boolean): void {
  const bb = insideTelegram ? webApp?.BackButton : undefined;
  if (!bb) return;
  if (visible) bb.show(); else bb.hide();
}

export function telegramInitData(): string | null {
  return insideTelegram ? webApp?.initData || null : null;
}

// The user's Telegram language (e.g. 'ru', 'ru-RU', 'en') — drives the initial
// interface locale. Null outside Telegram; the i18n layer then falls back to the
// browser language. See src/i18n.tsx detectLang().
export function telegramLanguageCode(): string | null {
  return insideTelegram ? webApp?.initDataUnsafe?.user?.language_code || null : null;
}

// Telegram minimises the mini-app (rather than closing it) while the owner is
// off in another chat — e.g. the t.me/newbot flow after "Create your bot".
// `activated`/`deactivated` (Bot API 8.0+) say when; combined with the page's
// own visibilityState this drives "stop polling while nobody is looking".
export function onVisibility(cb: (visible: boolean) => void): () => void {
  const fromDoc = () => cb(document.visibilityState !== 'hidden');
  const on = () => cb(true);
  const off = () => cb(false);
  document.addEventListener('visibilitychange', fromDoc);
  const wa = insideTelegram ? webApp : undefined;
  wa?.onEvent('activated', on);
  wa?.onEvent('deactivated', off);
  return () => {
    document.removeEventListener('visibilitychange', fromDoc);
    wa?.offEvent('activated', on);
    wa?.offEvent('deactivated', off);
  };
}

// Native haptic feedback — the physical tick that makes a swipe feel real.
// A single seam over the two HapticFeedback methods, keyed by intent so callers
// say what happened, not which API to poke. No-op outside Telegram or on a
// client too old to have it (guarded so a throw can never break a gesture).
export function haptic(
  kind: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' | 'success' | 'warning' | 'error' | 'select',
): void {
  const h = insideTelegram ? webApp?.HapticFeedback : undefined;
  if (!h) return;
  try {
    switch (kind) {
      case 'success':
      case 'warning':
      case 'error':
        h.notificationOccurred(kind);
        break;
      case 'select':
        h.selectionChanged();
        break;
      default:
        h.impactOccurred(kind);
    }
  } catch { /* older client / unsupported — the gesture still works, just silent */ }
}

// t.me links stay inside Telegram (bot chats, the manager-bot deep link,
// share sheets). openTelegramLink is the mini-app API for this; openLink is
// the in-app fallback for older clients; window.open only outside Telegram.
export function openTgLink(url: string): void {
  if (insideTelegram && webApp?.openTelegramLink) { webApp.openTelegramLink(url); return; }
  if (insideTelegram && webApp?.openLink) { webApp.openLink(url); return; }
  window.open(url, '_blank', 'noopener');
}
