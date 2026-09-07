// MyBots — the owner's bot list on Home (GET /builder/agents/me/projects)
// plus the chat Composer the Bot page pins at the bottom.
import { Theme, btnReset, toneFor } from '../theme';
import { Project, projectIsLive } from '../api/client';
import { insideTelegram } from '../telegram';
import { useT, useLang, tr, Lang } from '../i18n';
import { TGIcon, Spinner, BotTile, Pill, Dot, SwipeRow, SwipeAction, DANGER } from '../ui';

export interface MyBot {
  id: string;
  name: string;
  handle: string;
  tone: string;
  avatarUrl?: string; // generated bot avatar (falls back to the name monogram)
  status: string;     // list state: live | awaiting_bot | stopped | failed | raw project status
  live: boolean;      // the bot is answering users (server truth: bot_is_live only)
  preview: string;
}

// Status chrome. Keyed by the list state; VALUES are user-facing → translated.
// `live` (the raw project status) means "the build is running" here — a
// whole_bot keeps status=live for its whole life; the phase says the rest.
const STATUS_LABELS: Record<string, [string, string]> = {
  draft: ['Tell me what to build', 'Расскажите, что собрать'],
  validating: ['Getting started…', 'Начинаем…'],
  generating: ['Building…', 'Собираем…'],
  live: ['Building…', 'Собираем…'],
  awaiting_bot: ['Ready — create bot', 'Готов — создайте бота'],
  stopped: ['Not running', 'Не запущен'],
  failed: ['Needs a look', 'Нужно взглянуть'],
};
// pulsing gold = something is happening; plain gold = waiting on the owner;
// neutral = stopped/needs a look
const PULSING = new Set(['draft', 'validating', 'generating', 'live']);
const NEUTRAL = new Set(['stopped', 'failed']);

export function statusLabel(lang: Lang, status: string): string {
  const pair = STATUS_LABELS[status];
  return pair ? tr(lang, pair[0], pair[1]) : status;
}

// A project not named yet (the first assistant turn is still running) carries
// the draft placeholder slug — show "New bot" rather than "Untitled".
export function isDraftSlug(slug?: string): boolean { return !slug || slug.startsWith('draft-'); }

export function botFromProject(p: Project): MyBot {
  // Live = the container runs (bot_is_live), nothing else. A converged build
  // with no Telegram bot is "create your bot"; one whose bot exists but isn't
  // running is stopped (paused, or the container died); a build that gave up
  // keeps status=live but current_phase=failed.
  const live = projectIsLive(p);
  const status = live ? 'live'
    : p.current_phase === 'failed' ? 'failed'
    : p.current_phase === 'published' ? (p.bot_username ? 'stopped' : 'awaiting_bot')
    : p.status;
  return {
    id: p.id,
    name: isDraftSlug(p.slug) ? '' : p.name,
    handle: p.bot_username || '',
    tone: toneFor(p.slug),
    avatarUrl: p.bot_avatar_url || p.logo_url || p.preview_image_url || undefined,
    status,
    live,
    preview: p.short_description || p.goal_of_project || '',
  };
}

// ── the list ──────────────────────────────────────────────────
export type AuthState = 'pending' | 'ok' | 'none';

export function MyBotsList({ T, bots, loading, auth, onRetryAuth, notice, pinned, onOpen, onDelete, onPin }: {
  T: Theme; bots: MyBot[]; loading: boolean;
  auth: AuthState;               // pending → spinner; none inside Telegram → retry
  onRetryAuth: () => void;
  notice?: string | null;        // a failed delete, say — one line above the list
  pinned: Set<string>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void; onPin: (id: string) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const liveCount = bots.filter(b => b.live).length;
  const pending = loading || auth === 'pending';
  return (
    <div style={{ padding: '26px 16px 24px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 4px' }}>
        <div style={{ fontFamily: T.font, fontSize: 12, fontWeight: 700, color: T.hint, textTransform: 'uppercase', letterSpacing: 1.4 }}>
          {t('My bots', 'Мои боты')}
        </div>
        {bots.length > 0 && (
          <span style={{ fontFamily: T.font, fontSize: 12, color: T.hint }}>
            {liveCount ? `${liveCount} ${t('live', 'в эфире')} · ` : ''}{bots.length}
          </span>
        )}
      </div>

      {notice && (
        <div style={{ fontFamily: T.font, fontSize: 13, color: T.amber, lineHeight: '18px', padding: '10px 4px 0' }}>{notice}</div>
      )}

      {pending && bots.length === 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <Spinner color={T.accent} size={20} />
        </div>
      )}

      {!pending && bots.length === 0 && (
        <div style={{ fontFamily: T.font, fontSize: 14, color: T.sub, lineHeight: '20px', padding: '10px 4px 0' }}>
          {auth === 'ok'
            ? t('No bots yet — describe your first one above.', 'Ботов пока нет — опишите первого выше.')
            : insideTelegram
              ? <button onClick={onRetryAuth} style={{ ...btnReset, fontFamily: T.font, fontSize: 14, fontWeight: 600, color: T.accent, textAlign: 'left' }}>
                  {t("Couldn't sign you in — tap to retry", 'Не удалось войти — нажмите, чтобы повторить')}
                </button>
              : t('Open this inside Telegram to see your bots.', 'Откройте в Telegram, чтобы увидеть своих ботов.')}
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {bots.map(bot => {
          const isPinned = pinned.has(bot.id);
          // Swipe LEFT → delete (the panel rides in from the right edge), the way
          // every iOS/Telegram list does it. Swipe RIGHT → pin, or unpin when
          // it's already pinned (the same gesture, reversed).
          const del: SwipeAction = { icon: 'trash', label: t('Delete', 'Удалить'), bg: DANGER, fg: '#fff' };
          const pin: SwipeAction = isPinned
            ? { icon: 'pinOff', label: t('Unpin', 'Открепить'), bg: T.sub, fg: '#fff' }
            : { icon: 'pin', label: t('Pin', 'Закрепить'), bg: T.green, fg: '#fff' };
          const name = bot.name || t('New bot', 'Новый бот');
          const tone = bot.live ? 'green' : NEUTRAL.has(bot.status) ? 'neutral' : 'gold';
          const pulse = !bot.live && PULSING.has(bot.status);
          return (
            <SwipeRow key={bot.id} T={T} left={pin} right={del}
              onTriggerLeft={() => onPin(bot.id)}
              onTriggerRight={() => onDelete(bot.id)}
              onTap={() => onOpen(bot.id)}>
              <div style={{
                textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 13,
                padding: 13, borderRadius: T.cardRadius, background: T.cardBg,
                border: `1px solid ${T.sep}`, boxSizing: 'border-box',
              }}>
                <BotTile T={T} name={name} tone={bot.tone} src={bot.avatarUrl} size={44} radius={14} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    fontFamily: T.font, fontSize: 15.5, fontWeight: 700, color: T.text, letterSpacing: -0.2,
                    whiteSpace: 'nowrap', overflow: 'hidden',
                  }}>
                    {isPinned && <TGIcon name="pin" size={13} color={T.hint} stroke={2} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                  </div>
                  <div style={{ fontFamily: bot.handle ? T.mono : T.font, fontSize: 12.5, color: T.hint, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {bot.handle ? `@${bot.handle}` : bot.preview || t('no bot yet', 'бота ещё нет')}
                  </div>
                </div>
                <Pill T={T} tone={tone} style={{ flexShrink: 0 }}>
                  <Dot color={bot.live ? '#2f8f6f' : tone === 'gold' ? T.gold : T.hint} size={6} pulse={pulse} />
                  {bot.live ? t('Live', 'В эфире') : statusLabel(lang, bot.status)}
                </Pill>
              </div>
            </SwipeRow>
          );
        })}
      </div>
      {bots.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 12, fontFamily: T.font, fontSize: 11.5, color: T.hint }}>
          {t('Swipe a bot left to delete · right to pin', 'Свайп влево — удалить · вправо — закрепить')}
        </div>
      )}
    </div>
  );
}

// ── composer (pinned under the chat) ──────────────────────────
export function Composer({ T, draft, onChange, onSend, disabled, placeholder, secret }: {
  T: Theme; draft: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean;
  placeholder?: string;
  // secret: the chat is asking for one of the bot's settings (an API key, a
  // token). Swap the textarea for a masked single-line field so the value isn't
  // sitting in the clear on a phone screen, and keep the browser's autofill,
  // autocorrect and spellcheck away from it.
  secret?: boolean;
}) {
  const t = useT();
  const can = !!draft.trim() && !disabled;
  const field: React.CSSProperties = {
    flex: 1, resize: 'none', maxHeight: 96, minHeight: 42, padding: '11px 15px', borderRadius: 21,
    background: T.inputBg, border: `1px solid ${T.sep}`, color: T.text,
    fontFamily: T.font, fontSize: 15, lineHeight: '20px', outline: 'none', boxSizing: 'border-box',
  };
  return (
    <div style={{
      padding: '9px 10px 11px', background: T.headerBg, borderTop: `1px solid ${T.sep}`, position: 'relative', zIndex: 5,
      // Telegram fullscreen exports the home-indicator inset as --tg-fs-bottom
      // (telegram.ts); everywhere else the browser's own safe-area applies
      paddingBottom: 'calc(11px + var(--tg-fs-bottom, env(safe-area-inset-bottom, 0px)))',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        {secret ? (
          <input
            type="password"
            value={draft}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (can) onSend(); } }}
            placeholder={placeholder || t('Paste the value…', 'Вставьте значение…')}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            style={field} />
        ) : (
        <textarea
          value={draft}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (can) onSend(); } }}
          placeholder={placeholder || (disabled ? t('One moment…', 'Секунду…') : t('Ask for a change…', 'Попросите изменение…'))}
          rows={1}
          style={field} />
        )}
        <button onClick={can ? onSend : undefined} style={{
          ...btnReset, width: 42, height: 42, borderRadius: 999, flexShrink: 0,
          background: can ? T.accent : T.nestedBg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background .15s', cursor: can ? 'pointer' : 'default',
        }}>
          <TGIcon name="send" size={20} color={can ? '#fff' : T.hint} stroke={2} />
        </button>
      </div>
    </div>
  );
}
