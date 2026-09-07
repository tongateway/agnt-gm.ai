// Usage — the live bot's usage card: today's headline, a 7-day sparkline and
// three compact tiles (total · new · online). Degrades to a friendly line when
// analytics haven't landed yet.
import { Theme } from '../theme';
import { BotAnalytics } from '../api/client';
import { Card, Sparkline, TGIcon } from '../ui';
import { useT, useLang } from '../i18n';

// human-readable count: 3100 → "3.1k", 12000 → "12k"
function human(n?: number | null): string {
  if (n == null) return '—';
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

function UsageTile({ T, label, value, tone, dot, up }: {
  T: Theme; label: string; value: string; tone?: string; dot?: string; up?: boolean;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: T.nestedBg, borderRadius: 14, padding: '10px 12px' }}>
      <div style={{ fontFamily: T.font, fontSize: 11.5, color: T.hint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, flexShrink: 0 }} />}
        <span style={{ fontFamily: T.font, fontSize: 18, fontWeight: 700, color: tone || T.text, letterSpacing: -0.4 }}>{value}</span>
        {up && <TGIcon name="arrowUp" size={12} color={T.green} stroke={2.6} />}
      </div>
    </div>
  );
}

export function UsageCard({ T, analytics }: { T: Theme; analytics: BotAnalytics | null }) {
  const t = useT();
  const { lang } = useLang();
  const a = analytics;
  // people_today = distinct people (headline "answered N people");
  // messages_today is a message count — honest fallback wording, not "people".
  const isPeople = a?.people_today != null;
  const todayCount = a?.people_today ?? a?.messages_today ?? null;
  const users7d = a?.users_7d && a.users_7d.length >= 2 ? a.users_7d : null;
  const usersTotal = a?.users_total ?? a?.active_users ?? null;
  const usersNew = a?.users_new_7d ?? null;
  const activeNow = a?.active_now ?? null;
  const delta = a?.delta_pct ?? null;
  const hasStats = usersTotal != null || usersNew != null || activeNow != null || delta != null;
  const peopleWord = (n: number) => lang === 'ru'
    ? (n % 10 === 1 && n % 100 !== 11 ? 'человеку' : 'людям')
    : (n === 1 ? 'person' : 'people');
  const newValue = usersNew != null ? `+${human(usersNew)}` : (delta != null ? `${delta > 0 ? '+' : ''}${delta}%` : '—');
  const newUp = usersNew != null ? usersNew > 0 : (delta != null ? delta > 0 : false);
  return (
    <Card T={T} pad={14}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {todayCount != null ? (
            <>
              <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.sub }}>
                {isPeople ? t('Today your bot answered', 'Сегодня бот ответил') : t('Messages today', 'Сообщений сегодня')}
              </div>
              <div style={{ fontFamily: T.font, fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: -0.6, marginTop: 1 }}>
                {human(todayCount)}{isPeople && <span style={{ fontSize: 14, fontWeight: 600, color: T.sub }}> {peopleWord(todayCount)}</span>}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 700, color: T.text }}>{t('Your bot is live', 'Бот в эфире')}</div>
              <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 2, lineHeight: '17px' }}>{t('Usage shows up here as people start chatting with it.', 'Статистика появится, как только им начнут пользоваться.')}</div>
            </>
          )}
        </div>
        {users7d && <Sparkline values={users7d} color={T.green} />}
      </div>
      {hasStats && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <UsageTile T={T} label={t('Total users', 'Всего')} value={human(usersTotal)} />
          <UsageTile T={T} label={t('New · 7d', 'Новых · 7д')} value={newValue} tone={newUp ? T.green : undefined} up={newUp} />
          <UsageTile T={T} label={t('Online now', 'Онлайн')} value={activeNow != null ? human(activeNow) : '—'} dot={activeNow ? T.green : undefined} />
        </div>
      )}
    </Card>
  );
}
