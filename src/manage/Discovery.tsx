// Discovery - a public list of live production bots built on the platform.
// Tapping a card opens the live bot in Telegram. The list comes from
// GET /builder/projects/discover; other users' bots cannot be enumerated
// client-side, so an empty API response stays empty.
import { Theme, btnReset, toneFor } from '../theme';
import { Project } from '../api/client';
import { openTgLink } from '../telegram';
import { useT } from '../i18n';
import { TGIcon, BotTile, Pill, Dot } from '../ui';

// Default preview shown when a discovered bot carries no server description.
// Defined once so botFromProject and the render-site translation stay byte-identical.
const DISCOVER_FALLBACK = 'A bot built on AgentBot.';

export interface DiscoverBot {
  id: string;
  name: string;
  username: string; // real managed-bot @username - drives the t.me link
  tone: string;
  avatarUrl?: string; // AI-generated bot avatar / logo (falls back to the name monogram)
  preview: string;
}

// A bot with no username cannot be opened, so omit it from the feed.
export function discoverBotFromProject(p: Project): DiscoverBot | null {
  if (!p.bot_username) return null;
  return {
    id: p.id,
    name: p.name,
    username: p.bot_username,
    tone: toneFor(p.slug),
    avatarUrl: p.bot_avatar_url || p.logo_url || p.preview_image_url || undefined,
    preview: p.short_description || p.goal_of_project || DISCOVER_FALLBACK,
  };
}

export function DiscoveryPage({ T, bots, loading }: {
  T: Theme; bots: DiscoverBot[]; loading: boolean;
}) {
  const t = useT();

  return (
    <div style={{
      minHeight: '100%',
      padding: '14px 20px 96px',
      background: T.pageBg,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <header>
        <h1 style={{
          margin: 0,
          fontFamily: T.font,
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: -0.6,
          color: T.text,
        }}>{t('Discover', 'Каталог')}</h1>
        <div style={{
          marginTop: 4,
          fontFamily: T.font,
          fontSize: 14,
          color: T.sub,
        }}>
          {loading
            ? t('loading live bots…', 'загружаем живых ботов…')
            : bots.length
              ? t('live bots from the community', 'живые боты сообщества')
              : t('no live bots yet', 'живых ботов пока нет')}
        </div>
      </header>

      {loading && <LoadingRows T={T} />}
      {!loading && bots.length === 0 && <EmptyDiscovery T={T} />}

      {!loading && bots.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {bots.map(bot => (
            <DiscoveryCard key={bot.id} T={T} bot={bot} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiscoveryCard({ T, bot }: { T: Theme; bot: DiscoverBot }) {
  const t = useT();
  const preview = bot.preview === DISCOVER_FALLBACK
    ? t(DISCOVER_FALLBACK, 'Бот, созданный на AgentBot.')
    : bot.preview;

  return (
    <button
      onClick={() => openTgLink(`https://t.me/${bot.username}`)}
      style={{
        ...btnReset,
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        background: T.cardBg,
        border: `1px solid ${T.sep}`,
        borderRadius: 20,
        boxShadow: T.shadow,
        padding: 16,
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <BotTile T={T} name={bot.name} tone={bot.tone} src={bot.avatarUrl} size={52} radius={16} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: T.font,
            fontSize: 17,
            fontWeight: 700,
            color: T.text,
            letterSpacing: -0.2,
          }}>{bot.name}</span>
          <Pill T={T} tone="green"><Dot color="#2f8f6f" size={6} /> {t('LIVE', 'В ЭФИРЕ')}</Pill>
        </div>

        <div style={{
          marginTop: 3,
          fontFamily: T.font,
          fontSize: 13.5,
          lineHeight: '18px',
          color: T.sub,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>{preview}</div>

        <div style={{
          marginTop: 5,
          fontFamily: T.mono,
          fontSize: 12.5,
          color: T.hint,
        }}>@{bot.username}</div>
      </div>

      <div style={{ flexShrink: 0 }}>
        <TGIcon name="chevRight" size={20} color={T.hint} stroke={2} />
      </div>
    </button>
  );
}

function EmptyDiscovery({ T }: { T: Theme }) {
  const t = useT();
  return (
    <div style={{
      background: T.cardBg,
      border: `1px solid ${T.sep}`,
      borderRadius: 20,
      boxShadow: T.shadow,
      padding: '40px 20px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap: 12,
    }}>
      <div style={{
        width: 52,
        height: 52,
        borderRadius: 16,
        background: T.nestedBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <TGIcon name="compass" size={24} color={T.hint} stroke={2} />
      </div>
      <div>
        <div style={{ fontFamily: T.font, fontSize: 17, fontWeight: 700, color: T.text, letterSpacing: -0.2 }}>{t('No public bots yet', 'Публичных ботов пока нет')}</div>
        <div style={{ marginTop: 4, fontFamily: T.font, fontSize: 13.5, lineHeight: '18px', color: T.sub }}>{t('The list opens when live bots have public handles.', 'Список откроется, когда у ботов в эфире появятся публичные @-адреса.')}</div>
      </div>
    </div>
  );
}

function LoadingRows({ T }: { T: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          background: T.cardBg,
          border: `1px solid ${T.sep}`,
          borderRadius: 20,
          boxShadow: T.shadow,
          padding: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 13,
        }}>
          <div style={{ width: 52, height: 52, borderRadius: 16, background: T.nestedBg, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ width: '52%', height: 15, borderRadius: 7, background: T.nestedBg }} />
            <div style={{ width: '88%', height: 12, borderRadius: 6, background: T.nestedBg }} />
            <div style={{ width: '34%', height: 11, borderRadius: 6, background: T.nestedBg }} />
          </div>
        </div>
      ))}
    </div>
  );
}
