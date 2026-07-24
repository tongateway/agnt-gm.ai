// MyBots — "My Bots" tab: the post-launch feedback loop. The bot list is real
// (GET /builder/projects?owner_agent_id=…); the per-bot chat is the real
// project chat (history, deploy logs as role=system, owner messages).
import { Theme, btnReset, toneFor } from '../theme';
import { Project, ChatMessage } from '../api/client';
import { ChatThread } from '../chat/Chat';
import { useT, useLang, tr, Lang } from '../i18n';
import { TGIcon, Mark, Bubble, Spinner, BotTile, Pill, Dot, SwipeRow, SwipeAction, DANGER } from '../ui';

export interface MyBot {
  id: string;
  name: string;
  handle: string;
  tone: string;
  avatarUrl?: string; // generated bot avatar (falls back to the name monogram)
  version: string;
  status: string;
  inProgress: boolean; // not deployed yet — tapping resumes the build pipeline
  statusLabel: string;
  preview: string;
  // task_manager (living DAG) vs the legacy phase pipeline. From the project's
  // build_pipeline once it ships (gap #1); undefined today → the board/overview
  // fall back to probing /dag for node_kind. Drives which board/inbox to show.
  isTaskManager?: boolean;
}

// Status chrome. Keyed by raw project status; VALUES are user-facing → translated.
const STATUS_LABELS: Record<string, [string, string]> = {
  draft: ['Clarifying idea…', 'Уточняем идею…'],
  validating: ['Generating spec…', 'Генерация спеки…'],
  generating: ['Building…', 'Идёт сборка…'], // task_manager decompose/build state
  ready_to_publish: ['In progress', 'В процессе'],
  publishing: ['Publishing…', 'Публикация…'],
  live: ['Building…', 'Идёт сборка…'],
  completed: ['Build complete', 'Сборка готова'],
};

function statusLabel(lang: Lang, status: string): string {
  const pair = STATUS_LABELS[status];
  return pair ? tr(lang, pair[0], pair[1]) : status;
}

// Default descriptions when a bot carries no server description. Defined once so
// botFromProject and the render-site translation (previewText) stay byte-identical.
const DEPLOYED_FALLBACK = 'Your bot is deployed and running.';
const WIP_FALLBACK = 'Build in progress — open for status and changes.';

function previewText(lang: Lang, preview: string): string {
  if (preview === DEPLOYED_FALLBACK) return tr(lang, DEPLOYED_FALLBACK, 'Ваш бот развёрнут и работает.');
  if (preview === WIP_FALLBACK) return tr(lang, WIP_FALLBACK, 'Сборка идёт — откройте, чтобы увидеть статус и внести изменения.');
  return preview;
}

export function botFromProject(p: Project): MyBot {
  const isTaskManager = p.build_pipeline ? p.build_pipeline === 'task_manager' : undefined;
  // Phase is authoritative when the API provides it: a bot is "live" only once
  // its build reaches published (or bot_go_live_at is stamped).
  const runtimeLive = p.current_phase === 'published' || !!p.bot_go_live_at;
  // legacyLive is ONLY for old rows that carry no current_phase, where the
  // lifecycle status was the sole go-live signal. It must NOT fire when a phase
  // is present: whole_bot sets status='live' EARLY (at general→building), so a
  // still-building bot would otherwise show a green "Live" badge over a bot that
  // has not gone live (observed: traty — status='live', current_phase='building').
  const legacyLive = !p.current_phase && isTaskManager !== true && (p.status === 'live' || p.status === 'completed');
  const deployed = runtimeLive || legacyLive;
  const desc = p.short_description || p.goal_of_project || (deployed
    ? DEPLOYED_FALLBACK
    : WIP_FALLBACK);
  return {
    id: p.id,
    name: p.name,
    handle: p.bot_username || `${p.slug.replace(/-/g, '_')}_bot`,
    tone: toneFor(p.slug),
    avatarUrl: p.bot_avatar_url || p.logo_url || p.preview_image_url || undefined,
    version: 'v1.0',
    status: deployed ? 'live' : p.status,
    inProgress: !deployed,
    statusLabel: deployed ? 'Live' : statusLabel('en', p.status),
    preview: desc,
    // undefined until the DTO carries build_pipeline; the board/overview probe /dag otherwise
    isTaskManager,
  };
}

function botsSummary(lang: Lang, bots: MyBot[]): string {
  const deployed = bots.filter(b => !b.inProgress).length;
  const wip = bots.length - deployed;
  const parts: string[] = [];
  if (deployed) parts.push(tr(lang, `${deployed} deployed`, `${deployed} развёрнуто`));
  if (wip) parts.push(tr(lang, `${wip} in progress`, `${wip} в процессе`));
  const joined = parts.join(' · ');
  const more = deployed ? tr(lang, 'request an update or ', 'запросить обновление или ') : '';
  return tr(lang,
    `${joined}. Open one to ${more}continue building.`,
    `${joined}. Откройте бота, чтобы ${more}продолжить сборку.`);
}

// ── inbox list ────────────────────────────────────────────────
export function MyBotsList({ T, bots, loading, authed, pinned, onOpen, onBuildFirst, onDelete, onPin }: {
  T: Theme; bots: MyBot[]; loading: boolean; authed: boolean;
  pinned: Set<string>;
  onOpen: (id: string) => void; onBuildFirst: () => void;
  onDelete: (id: string) => void; onPin: (id: string) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  return (
    <div style={{ padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '2px 2px 0' }}>
        <div style={{ fontFamily: T.font, fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: -0.6 }}>
          {t('My bots', 'Мои боты')}
        </div>
        {authed && bots.length > 0 && (
          <button onClick={onBuildFirst} style={{
            ...btnReset, width: 44, height: 44, borderRadius: 14, flexShrink: 0, background: T.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: T.ctaShadow,
          }}>
            <TGIcon name="plus" size={24} color={T.accentText} stroke={2.4} />
          </button>
        )}
      </div>
      <div style={{ fontFamily: T.font, fontSize: 14, color: T.sub, lineHeight: '20px', padding: '6px 2px 0' }}>
        {loading ? t('Loading your bots…', 'Загрузка ваших ботов…') : bots.length
          ? botsSummary(lang, bots)
          : authed ? t('Nothing deployed yet.', 'Пока ничего не развёрнуто.') : t('Your bots are tied to your Telegram account.', 'Ваши боты привязаны к вашему аккаунту Telegram.')}
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 36 }}>
          <Spinner color={T.accent} size={22} />
        </div>
      )}

      {!loading && !authed && (
        <EmptyAction T={T} icon="user" label={t('Open in Telegram', 'Открыть в Telegram')} sub={t('Sign-in is automatic inside the mini-app', 'Вход выполняется автоматически в мини-приложении')} onClick={() => {}} />
      )}

      {!loading && authed && bots.length === 0 && (
        <EmptyAction T={T} icon="bolt" label={t('Build your first bot', 'Соберите своего первого бота')} sub={t('Describe it in plain words — we do the rest', 'Опишите его простыми словами — остальное сделаем мы')} onClick={onBuildFirst} />
      )}

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {bots.map(bot => {
          // Use the derived deploy flag, NOT the raw lifecycle status: a building
          // whole_bot carries status='live' but inProgress=true, and must show its
          // build state (gold "Building…"), not a green "Live".
          const liveB = !bot.inProgress;
          const isPinned = pinned.has(bot.id);
          // Swipe RIGHT (panel at the left edge) → delete. Swipe LEFT → pin, or
          // unpin when it's already pinned (the same gesture, reversed).
          const del: SwipeAction = { icon: 'trash', label: t('Delete', 'Удалить'), bg: DANGER, fg: '#fff' };
          const pin: SwipeAction = isPinned
            ? { icon: 'pinOff', label: t('Unpin', 'Открепить'), bg: T.sub, fg: '#fff' }
            : { icon: 'pin', label: t('Pin', 'Закрепить'), bg: T.green, fg: '#fff' };
          return (
            <SwipeRow key={bot.id} T={T} left={del} right={pin}
              onTriggerLeft={() => onDelete(bot.id)}
              onTriggerRight={() => onPin(bot.id)}
              onTap={() => onOpen(bot.id)}>
              <div style={{
                textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 13,
                padding: 15, borderRadius: T.cardRadius, background: T.cardBg,
                border: `1px solid ${T.sep}`, boxSizing: 'border-box',
              }}>
                <BotTile T={T} name={bot.name} tone={bot.tone} src={bot.avatarUrl} size={48} radius={15} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    fontFamily: T.font, fontSize: 16, fontWeight: 700, color: T.text, letterSpacing: -0.2,
                    whiteSpace: 'nowrap', overflow: 'hidden',
                  }}>
                    {isPinned && <TGIcon name="pin" size={13} color={T.hint} stroke={2} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{bot.name}</span>
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 12.5, color: T.hint, marginTop: 2 }}>@{bot.handle}</div>
                </div>
                <Pill T={T} tone={liveB ? 'green' : 'gold'} style={{ flexShrink: 0 }}>
                  <Dot color={liveB ? '#2f8f6f' : T.gold} size={6} pulse={!liveB} />
                  {liveB ? t('Live', 'Работает') : statusLabel(lang, bot.status)}
                </Pill>
              </div>
            </SwipeRow>
          );
        })}
      </div>
      {bots.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 12, fontFamily: T.font, fontSize: 11.5, color: T.hint }}>
          {t('Swipe a bot left to pin · right to delete', 'Свайп влево — закрепить · вправо — удалить')}
        </div>
      )}
    </div>
  );
}

function EmptyAction({ T, icon, label, sub, onClick }: {
  T: Theme; icon: string; label: string; sub: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      ...btnReset, marginTop: 18, display: 'flex', alignItems: 'center', gap: 13, padding: 16, textAlign: 'left',
      borderRadius: T.cardRadius, background: T.cardBg, border: `1px solid ${T.sep}`, boxShadow: T.shadow,
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, background: T.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <TGIcon name={icon} size={20} color={T.accent} stroke={1.9} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.font, fontSize: 15.5, fontWeight: 600, color: T.text }}>{label}</div>
        <div style={{ fontFamily: T.font, fontSize: 13, color: T.hint, marginTop: 1 }}>{sub}</div>
      </div>
      <TGIcon name="chevRight" size={20} color={T.hint} stroke={2} />
    </button>
  );
}

// ── the update conversation — the project's REAL chat feed ────
// showIdentity: inside Telegram our mocked header is hidden (Telegram draws
// its own chrome), so the bot identity moves into the chat body.
export function BotChat({ T, bot, messages, thinking, thinkingStatus, loading, showIdentity, onOption, onRetry }: {
  T: Theme; bot: MyBot; messages: ChatMessage[]; thinking: boolean; thinkingStatus?: string;
  loading?: boolean; showIdentity?: boolean; onOption?: (label: string) => void;
  onRetry?: (m: ChatMessage) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  return (
    <div style={{ padding: '16px 14px 18px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
      {showIdentity && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '0 2px 6px' }}>
          <BotTile T={T} name={bot.name} tone={bot.tone} src={bot.avatarUrl} size={38} radius={12} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.font, fontSize: 15.5, fontWeight: 700, color: T.text, letterSpacing: -0.2 }}>{bot.name}</div>
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.hint, marginTop: 1 }}>@{bot.handle} · {bot.version}</div>
          </div>
        </div>
      )}
      {/* intro context line */}
      <div style={{
        alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 999,
        background: T.nestedBg, marginBottom: 2,
      }}>
        <Mark T={T} size={17} radius={5} />
        <span style={{ fontFamily: T.font, fontSize: 12, color: T.hint, fontWeight: 500 }}>
          {t('Build agent · updates ship live', 'Агент сборки · обновления сразу в эфире')}
        </span>
      </div>

      {loading && messages.length === 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
          <Spinner color={T.accent} size={18} />
        </div>
      )}

      {!loading && messages.length === 0 && !thinking && (
        <Bubble T={T} from="bot">
          <span style={{ whiteSpace: 'pre-line' }}>{t(
            `I'm live 🟢 ${previewText(lang, bot.preview)} Tell me anything you'd like to change and I'll ship it.`,
            `Я в эфире 🟢 ${previewText(lang, bot.preview)} Скажите, что хотите изменить, и я выпущу обновление.`)}</span>
        </Bubble>
      )}

      <ChatThread T={T} messages={messages} thinking={thinking} thinkingStatus={thinkingStatus} onOption={onOption} onRetry={onRetry} />
    </div>
  );
}

// ── composer (sits above the tab bar) ─────────────────────────
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
    <div style={{ padding: '9px 10px 11px', background: T.headerBg, borderTop: `1px solid ${T.sep}`, position: 'relative', zIndex: 5 }}>
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
          placeholder={placeholder || (disabled ? t('Shipping your update…', 'Отправляем обновление…') : t('Describe an update to ship…', 'Опишите обновление для отправки…'))}
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
