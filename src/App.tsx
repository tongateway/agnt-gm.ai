// App.tsx — hash routes over five screens + Telegram chrome wiring.
//   #/            Home     — idea box + my bots
//   #/bots/<id>   Bot      — chat-first: draft, building, live, rejected
//   #/bots/<id>/env · /plan  Keys · Plan
//   #/discover    Discover
// Owner identity is a silent Telegram auth (initData → JWT); every screen
// reads server state and polls it — nothing about a bot lives in localStorage.
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { tgTheme, Theme } from './theme';
import { syncChrome, telegramInitData, insideTelegram, backButtonOnClick, backButtonVisible } from './telegram';
import { authTelegram, setAuthToken, listDiscoverBots } from './api/client';
import { useT } from './i18n';
import { TGHeader, TabBar, Spinner, Card, TGIcon } from './ui';
import { useHashRoute, navigate, parentRoute, Route } from './router';
import { HomeScreen } from './screens/Home';
import { BotScreen } from './screens/Bot';
import { DiscoveryPage, DiscoverBot, discoverBotFromProject } from './manage/Discovery';

// Keys and Plan are reached only via navigation — load them on demand so the
// first paint (Home / Bot) stays small.
const BotEnv = lazy(() => import('./manage/BotEnv').then(m => ({ default: m.BotEnv })));
const BlueprintScreen = lazy(() => import('./manage/Blueprint').then(m => ({ default: m.BlueprintScreen })));

type AuthState = 'pending' | 'ok' | 'none';

export default function App() {
  const t = useT();
  const T: Theme = tgTheme();
  useEffect(() => { syncChrome(T.headerBg, T.pageBg); document.body.style.background = T.pageBg; }, []);
  const { route, dir } = useHashRoute();

  // ── owner identity: silent Telegram auth ──
  // POST /auth/telegram with WebApp initData → JWT; the owner is derived from
  // the session on every API call. Outside Telegram there is nothing to sign
  // with, so owner screens ask to open the app in Telegram.
  const [auth, setAuth] = useState<AuthState>(insideTelegram ? 'pending' : 'none');
  const [agentId, setAgentId] = useState<string | null>(null);
  const tryAuth = useCallback(async (): Promise<boolean> => {
    const initData = telegramInitData();
    if (!initData) { setAuth('none'); return false; }
    try {
      const r = await authTelegram(initData);
      const token = r.jwt || r.token;
      if (!token) { setAuth('none'); return false; }
      setAuthToken(token);
      setAgentId(r.agent?.id ?? null);
      setAuth('ok');
      return true;
    } catch {
      setAuth('none');
      return false;
    }
  }, []);
  useEffect(() => { void tryAuth(); }, [tryAuth]);

  // ── Discover feed (public) — loaded when the tab opens, kept for re-visits ──
  const [discoverBots, setDiscoverBots] = useState<DiscoverBot[] | null>(null);
  useEffect(() => {
    if (route.name !== 'discover' || discoverBots) return;
    let cancelled = false;
    listDiscoverBots()
      .then(list => { if (!cancelled) setDiscoverBots((list.projects || []).map(discoverBotFromProject).filter((b): b is DiscoverBot => b !== null)); })
      .catch(() => { if (!cancelled) setDiscoverBots([]); });
    return () => { cancelled = true; };
  }, [route.name, discoverBots]);

  // ── Back: Telegram's native BackButton inside the app, a header button in the browser ──
  const parent = parentRoute(route);
  const back = parent ? () => navigate(parent) : null;
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => backButtonOnClick(() => backRef.current?.()), []);
  useEffect(() => { backButtonVisible(!!back); }, [!!back]);

  // ── screen body ──
  const scroll = (node: React.ReactNode, pad = 0) => (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', paddingBottom: pad }}>
      {node}
    </div>
  );
  const ownerOnly = (node: React.ReactNode) => {
    if (auth === 'ok') return node;
    if (auth === 'pending') return <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner color={T.accent} size={22} /></div>;
    return scroll(
      <div style={{ padding: 16 }}>
        <Card T={T} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: T.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <TGIcon name="user" size={20} color={T.accent} stroke={1.9} />
          </div>
          <div>
            <div style={{ fontFamily: T.font, fontSize: 15, fontWeight: 600, color: T.text }}>{t('Open in Telegram', 'Откройте в Telegram')}</div>
            <div style={{ fontFamily: T.font, fontSize: 13, color: T.hint, marginTop: 2, lineHeight: '17px' }}>{t('Your bots are tied to your Telegram account — sign-in is automatic inside the mini-app.', 'Ваши боты привязаны к аккаунту Telegram — вход в мини-приложении автоматический.')}</div>
          </div>
        </Card>
      </div>);
  };
  const body = (() => {
    switch (route.name) {
      case 'home': return scroll(<HomeScreen T={T} authed={auth === 'ok'} agentId={agentId} tryAuth={tryAuth} />);
      case 'discover': return scroll(<DiscoveryPage T={T} bots={discoverBots || []} loading={discoverBots === null} />);
      case 'bot': return ownerOnly(<BotScreen key={route.id} T={T} projectId={route.id} />);
      case 'env': return ownerOnly(scroll(<BotEnv T={T} projectId={route.id} />));
      case 'plan': return ownerOnly(scroll(<BlueprintScreen T={T} projectId={route.id} />));
    }
  })();

  // ── header (browser only; Telegram draws its own chrome + BackButton) ──
  const headerFor = (r: Route): { title: string; subtitle?: string } | null => {
    switch (r.name) {
      case 'bot': return { title: t('Your bot', 'Ваш бот'), subtitle: t('chat to build and refine', 'собирайте и дорабатывайте в чате') };
      case 'env': return { title: t('Keys', 'Ключи'), subtitle: t('what your bot needs from you', 'что боту нужно от вас') };
      case 'plan': return { title: t('The plan', 'План'), subtitle: t('what we understood from your idea', 'что мы поняли из вашей идеи') };
      default: return null;
    }
  };
  const header = insideTelegram ? null : headerFor(route);
  const tabs = route.name === 'home' || route.name === 'discover';
  const animKey = route.name === 'bot' || route.name === 'env' || route.name === 'plan' ? `${route.name}-${route.id}` : route.name;

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', background: T.pageBg,
      // clip the screen slide-in (scrIn translates ±22px) — without this the
      // page widens for 0.32s per navigation and can rubber-band horizontally
      overflowX: 'hidden',
      // in Telegram fullscreen (mobile) clear the status bar + floating controls;
      // 0 everywhere else (var is only set inside fullscreen) — see telegram.ts
      paddingTop: 'var(--tg-fs-top, 0px)',
    }}>
      <style>{`
        @keyframes tgspin { to { transform: rotate(360deg); } }
        @keyframes tgpulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        @keyframes tgtype { 0%,60%,100% { transform: translateY(0); opacity:.5; } 30% { transform: translateY(-4px); opacity:1; } }
        @keyframes tgbubble { from { opacity:0; transform: translateY(8px) scale(.97); } to { opacity:1; transform:none; } }
        @keyframes scrIn { from { opacity:0; transform: translateX(var(--scr-dx)); } to { opacity:1; transform:none; } }
        textarea::placeholder, input::placeholder { color: ${T.hint}; }
        ::-webkit-scrollbar { width: 0; height: 0; }
      `}</style>

      {header && <TGHeader T={T} title={header.title} subtitle={header.subtitle} onBack={back} />}
      <div key={animKey} style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative',
        ['--scr-dx' as string]: dir > 0 ? '22px' : '-22px', animation: 'scrIn .32s cubic-bezier(.2,.8,.2,1)',
      }}>
        <Suspense fallback={
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '48px 0' }}>
            <Spinner color={T.accent} size={22} />
          </div>
        }>
          {body}
        </Suspense>
      </div>
      {tabs && (
        <TabBar T={T} tab={route.name === 'discover' ? 'discover' : 'home'}
          onTab={(tb) => navigate({ name: tb === 'discover' ? 'discover' : 'home' })} />
      )}
    </div>
  );
}
