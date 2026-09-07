// Chat — the owner↔AI chat plumbing + renderer behind the Bot page: intake
// questions, env questions, build events and post-build change requests are
// ONE thread. Backed by the real chat API: cursor polling, optimistic owner
// messages, ai_thinking typing indicator, quick-reply options, role=system
// build/deploy events.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Theme } from '../theme';
import { ChatMessage, getChatMessages, sendChatMessage } from '../api/client';
import { Bubble, TypingBubble, EventCard, QuickReplies, TGIcon } from '../ui';
import { ChatMarkdown } from './markdown';
import { pendingEnvAsk, maskSecret, EnvAsk } from './env';
import { useT, useLang, tr, Lang } from '../i18n';

// adaptive polling: tight while an AI turn is running (the answer can land
// any moment), relaxed when the chat is idle, and much slower while the
// mini-app is minimised (the owner is off in the t.me/newbot flow).
const POLL_FAST_MS = 1200;
const POLL_IDLE_MS = 4000;
const POLL_BG_MS = 12000;
// The first fetch pages the WHOLE thread (server cap 200/page) before the
// quick replies / env ask are judged — a built bot's thread is well past 50,
// and judging them on a truncated tail showed an old question's chips.
const FIRST_PAGE = 200;
const PAGE = 50;

export interface QuickOpts { msgId: number; options: string[]; multi: boolean }

export interface ChatState {
  messages: ChatMessage[];
  thinking: boolean;
  thinkingStatus: string; // what the AI is doing right now (ai_thinking_status)
  opts: QuickOpts | null; // quick replies of the open question (computed once here)
  envAsk: EnvAsk | null;  // the open env question, if any
  send: (text: string) => void;
  retry: (m: ChatMessage) => void; // re-send a failed optimistic message
}

// active: true = poll; 'once' = fetch what's there and stop (a closed thread
// — rejected/failed/archived — never changes again); false = nothing.
export function useChat(projectId: string | null, active: boolean | 'once', focused = true): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState('');
  const cursor = useRef(0);
  const seen = useRef<Set<number>>(new Set());
  const pollNow = useRef<() => void>(() => {});

  useEffect(() => {
    if (!projectId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One chain only: a pollNow() that lands while a tick is mid-await marks a
    // repoll instead of starting a second, self-rescheduling chain.
    let inFlight = false;
    let wantRepoll = false;
    const tick = async () => {
      if (cancelled) return;
      if (inFlight) { wantRepoll = true; return; }
      inFlight = true;
      let busy = false;
      try {
        let limit = cursor.current === 0 ? FIRST_PAGE : PAGE;
        for (let page = 0; page < 20; page++) {
          const r = await getChatMessages(projectId, cursor.current, limit);
          if (cancelled) return;
          const incoming = (r.messages || []).filter(m => !seen.current.has(m.id));
          if (incoming.length) {
            incoming.forEach(m => seen.current.add(m.id));
            cursor.current = Math.max(cursor.current, ...incoming.map(m => m.id));
            setMessages(prev => {
              // Drop optimistic copies (negative ids) the server has now echoed.
              // Normally that's a content match — but an answer to an env question
              // is stored MASKED (and, when rejected, not stored at all), so its
              // echo can never match. Anything arriving from the server means that
              // turn landed, so drop env echoes on progress instead of on match.
              const echoed = new Set(incoming.filter(m => m.role === 'owner').map(m => m.content));
              return [...prev.filter(m => !(m.id < 0 && (m.envEcho || echoed.has(m.content)))), ...incoming];
            });
          }
          busy = !!r.ai_thinking;
          setThinking(busy);
          setThinkingStatus(busy ? (r.ai_thinking_status || '') : '');
          if ((r.messages || []).length < limit) break; // caught up
          limit = FIRST_PAGE;
        }
      } catch { /* transient — next tick retries */ }
      finally { inFlight = false; }
      if (cancelled || active === 'once') return;
      timer = setTimeout(tick, wantRepoll ? 0 : !focused ? POLL_BG_MS : busy ? POLL_FAST_MS : POLL_IDLE_MS);
      wantRepoll = false;
    };
    pollNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    return () => { cancelled = true; pollNow.current = () => {}; if (timer) clearTimeout(timer); };
  }, [projectId, active, focused]);

  // Derived once per message list — the page, the thread and send() all read
  // the same answer instead of re-scanning the tail three times.
  const envAsk = useMemo(() => pendingEnvAsk(messages), [messages]);
  const opts = useMemo(() => activeOptions(messages), [messages]);

  const send = (text: string) => {
    const t = text.trim();
    if (!projectId || !t) return;
    const tempId = -Date.now();
    // While the chat is asking for one of the bot's settings, THIS message is
    // that value. The server never stores it as typed — only a mask — so the
    // optimistic copy must not render it either: otherwise the secret sits in
    // the thread, in the clear, for the rest of the session.
    // …unless they tapped one of the question's own chips ("Skip for now", "Use
    // my Telegram ID"): that's a button, not a value, and masking it would flash
    // "••••now" back at the owner.
    const tapped = !!opts?.options.includes(t);
    const optimistic: ChatMessage = envAsk?.secret && !tapped
      ? { id: tempId, role: 'owner', content: maskSecret(t), envEcho: true, raw: t }
      : { id: tempId, role: 'owner', content: t, envEcho: !!envAsk };
    setMessages(prev => [...prev, optimistic]);
    setThinking(true);
    // poll immediately once the server accepts — don't wait out the interval
    sendChatMessage(projectId, t)
      .then(() => pollNow.current())
      .catch(() => {
        // keep the failed copy visible with a retry affordance — a message
        // that silently vanishes reads as "the agent ignored me"
        setMessages(prev => prev.map(m => (m.id === tempId ? { ...m, failed: true } : m)));
        setThinking(false);
      });
  };

  // Retry re-sends what was TYPED, not what is displayed — for a masked env
  // answer those differ, and re-sending "••••1234" would store the mask as the
  // bot's API key.
  const retry = (m: ChatMessage) => {
    setMessages(prev => prev.filter(x => x.id !== m.id));
    send(m.raw ?? m.content);
  };

  return { messages, thinking, thinkingStatus, opts, envAsk, send, retry };
}

// quick replies belong to the LAST assistant message with no owner reply after it
export function activeOptions(messages: ChatMessage[]): QuickOpts | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'owner') return null;
    if (m.role === 'assistant') {
      if (!m.options?.length) return null;
      // multi_select rides in the message's generic `data` payload (no schema
      // change server-side). Absent on every question written before this
      // shipped → single-select, exactly as before. Needs 2+ chips to combine.
      const multi = !!(m.data as { multi_select?: boolean } | undefined)?.multi_select && m.options.length > 1;
      return { msgId: m.id, options: m.options, multi };
    }
  }
  return null;
}

// The env question's chips are server constants matched by EXACT text, so they
// are sent verbatim — but shown in the owner's language.
const CHIP_LABELS: Record<string, [string, string]> = {
  '⏭ Skip for now': ['⏭ Skip for now', '⏭ Пока пропустить'],
  '👤 Use my Telegram ID': ['👤 Use my Telegram ID', '👤 Использовать мой Telegram ID'],
};
function chipLabel(lang: Lang, o: string): string {
  const pair = CHIP_LABELS[o];
  return pair ? tr(lang, ...pair) : o;
}

// ── system events → owner-readable cards ──────────────────────
// The server's system lines are English-only and technical (pass numbers,
// image tags). They DO carry a stable `data.stage` / `kind` / `level`, so the
// card is titled from those and the raw text is only the fallback.
type Pal = 'amber' | 'green' | 'terracotta' | 'neutral';
const EVENT_KIND: Record<string, { palette: Pal; icon: string }> = {
  build_started: { palette: 'terracotta', icon: 'bolt' },
  spec_progress: { palette: 'amber', icon: 'beaker' },
  spec_ready: { palette: 'green', icon: 'check' },
  spec_failed: { palette: 'terracotta', icon: 'close' },
  phase: { palette: 'amber', icon: 'server' },
  bot_preview: { palette: 'green', icon: 'spark' },
  bot_deploy: { palette: 'green', icon: 'arrowUp' },
  app_deploy: { palette: 'green', icon: 'arrowUp' },
  ai_error: { palette: 'terracotta', icon: 'close' },
  test: { palette: 'amber', icon: 'beaker' },
  feedback: { palette: 'neutral', icon: 'refresh' },
  log_only: { palette: 'neutral', icon: 'chat' },
  pr_opened: { palette: 'amber', icon: 'code' },
  build: { palette: 'terracotta', icon: 'bolt' },
  deploy: { palette: 'green', icon: 'arrowUp' },
  pause: { palette: 'neutral', icon: 'pause' },
  resume: { palette: 'green', icon: 'play' },
};

interface EventData {
  kind?: string; action?: string; label?: string; title?: string; sub?: string; detail?: string; status?: string;
  level?: string; stage?: string; ok?: boolean; bot_username?: string; pass?: number;
}

function eventLook(d: EventData, content: string): { palette: Pal; icon: string } {
  // severity first: the server stamps `level` on every system row precisely so
  // a deploy FAILURE isn't styled as a green celebration
  if (d.level === 'error' || d.ok === false) return { palette: 'terracotta', icon: 'close' };
  const key = d.kind && d.kind !== 'action' ? d.kind : (d.action || '');
  if (key === 'bot_deploy') {
    // go-live: "published_with_gaps" reads amber (live, but polish me); a clean
    // publish / deploy stays green celebratory; owner actions (pause, resume,
    // retry requested) are informational
    if (d.stage === 'published_with_gaps') return { palette: 'amber', icon: 'spark' };
    if (d.stage === 'publishing' || d.ok === true) return { palette: 'green', icon: 'spark' };
    if (d.level === 'info') return { palette: 'neutral', icon: /^⏸/.test(content) ? 'pause' : /^▶/.test(content) ? 'play' : 'refresh' };
    return { palette: 'green', icon: 'spark' };
  }
  if (EVENT_KIND[key]) return EVENT_KIND[key];
  const probe = `${content} ${JSON.stringify(d)} ${d.status || ''}`.toLowerCase();
  return /fail|error|crash|broken|🔴|❌|⛔|✗/.test(probe)
    ? { palette: 'terracotta', icon: 'close' }
    : { palette: 'green', icon: 'check' };
}

// Titles keyed on the stable data.stage the whole_bot pipeline emits today.
// Unknown stages (env_panel, deploy_blocked, repo_gone, …) keep the raw text.
const STAGE_TITLES: Record<string, [string, string]> = {
  blueprint: ['Drafting your bot’s plan…', 'Готовим план бота…'],
  provisioning: ['Setting up your bot’s workspace…', 'Готовим рабочее место бота…'],
  ready: ['Plan ready — building your bot now', 'План готов — собираем бота'],
  pass_started: ['Writing your bot’s code…', 'Пишем код бота…'],
  pass_merged: ['Code is in — testing it next', 'Код готов — дальше тесты'],
  review_skipped: ['Code is in — testing it next', 'Код готов — дальше тесты'],
  gate_failed: ['Tests found issues — fixing them', 'Тесты нашли проблемы — исправляем'],
  gate_error: ['The build stopped on our side', 'Сборка остановилась по нашей вине'],
  publishing: ['Tests passed — your bot is ready', 'Тесты пройдены — бот готов'],
  published_with_gaps: ['Live — a few features still missing', 'В эфире — кое-что ещё не готово'],
  updating: ['Updating your bot…', 'Обновляем бота…'],
  rebuilding: ['Rebuilding your bot…', 'Пересобираем бота…'],
  env_refresh: ['Applying the new settings…', 'Применяем новые настройки…'],
};
const STAGE_SUBS: Record<string, [string, string]> = {
  gate_error: ['Not your bot’s fault — the team has been alerted. Ask me here to try again.', 'Это не из-за бота — команда уже в курсе. Попросите здесь попробовать ещё раз.'],
};
// Stage-less lines recognised by kind + leading emoji (owner actions, notes).
const LINE_TITLES: [RegExp, [string, string]][] = [
  [/^🚀 Idea locked in/, ['Idea locked in — building your bot', 'Идея принята — собираем бота']],
  [/^⏸/, ['Bot paused', 'Бот на паузе']],
  [/^▶/, ['Bot resumed — starting it up', 'Бот включён — запускаем']],
  [/^🚀 Deploy retry/, ['Deploy restarted', 'Деплой перезапущен']],
  [/^🔧 An update is already building/, ['A build is already running — send this again once the bot is live', 'Сборка уже идёт — отправьте это снова, когда бот будет в эфире']],
  [/^🚧/, ['A build is already running — send your update once the bot is live', 'Сборка уже идёт — отправьте изменение, когда бот будет в эфире']],
  [/^⏳ Starting the build without/, ['Building without the remaining settings — send them here any time', 'Собираем без остальных настроек — пришлите их сюда в любое время']],
  [/^✅ Tests passed/, ['Tests passed', 'Тесты пройдены']],
  [/^❌ Tests failing/, ['Tests found issues', 'Тесты нашли проблемы']],
];

function eventTitle(lang: Lang, d: EventData, content: string): { title: string; sub?: React.ReactNode } {
  const kind = d.kind && d.kind !== 'action' ? d.kind : (d.action || '');
  const u = d.bot_username ? `@${d.bot_username}` : '';
  // the body under a multi-line go-live message (the gaps list, the missing-key
  // note) is worth keeping — only the English headline is replaced
  const tail = content.split('\n').slice(1).join('\n').trim();
  const body = tail ? <span style={{ whiteSpace: 'pre-line' }}>{tail}</span> : undefined;
  if (d.title || d.label) return { title: (d.title || d.label)!, sub: d.sub || d.detail || undefined };
  if (kind === 'bot_deploy') {
    if (d.level === 'error' || d.ok === false) {
      return {
        title: u ? tr(lang, `${u} deploy hit a problem — retrying automatically`, `${u}: деплой споткнулся — повторим автоматически`)
          : tr(lang, 'Deploy hit a problem — retrying automatically', 'Деплой споткнулся — повторим автоматически'),
        sub: tr(lang, 'Tell me here if you want to change something.', 'Напишите здесь, если хотите что-то поменять.'),
      };
    }
    if (d.ok === true && u) return { title: tr(lang, `${u} is live`, `${u} в эфире`) };
  }
  if (kind === 'bot_preview' && u) {
    return { title: tr(lang, `${u} is reserved — it answers while we build`, `${u} зарезервирован — отвечает, пока мы собираем`) };
  }
  if (kind === 'ai_error') return { title: tr(lang, 'The assistant hit a snag — please send that again', 'Помощник споткнулся — отправьте ещё раз') };
  if (kind === 'spec_failed') return { title: tr(lang, 'The build couldn’t start', 'Сборка не запустилась'), sub: content };
  if (d.stage === 'pass_started' && (d.pass ?? 1) > 1) return { title: tr(lang, 'Improving the bot…', 'Дорабатываем бота…') };
  if (d.stage && STAGE_TITLES[d.stage]) {
    const sub = STAGE_SUBS[d.stage];
    return { title: tr(lang, ...STAGE_TITLES[d.stage]), sub: sub ? tr(lang, ...sub) : body };
  }
  for (const [re, pair] of LINE_TITLES) {
    if (re.test(content)) return { title: tr(lang, ...pair), sub: body };
  }
  return { title: content, sub: d.sub || d.detail || undefined };
}

// A system/agent event → full-width stage-coloured event card (Bold 1c).
function EventRow({ T, msg }: { T: Theme; msg: ChatMessage }) {
  const { lang } = useLang();
  const d = (msg.data || {}) as EventData;
  const look = eventLook(d, msg.content || '');
  const { title, sub } = eventTitle(lang, d, msg.content || '');
  return <EventCard T={T} palette={look.palette} icon={look.icon} title={title} sub={sub} />;
}

// One owner/assistant bubble. Memoised on the fields that can change for a
// given row — the page re-renders on every 4 s poll and a 100-message thread
// must not re-parse its markdown each time.
const MessageRow = memo(function MessageRow({ T, msg, ask, onRetry }: {
  T: Theme; msg: ChatMessage;
  // this row is the OPEN env question: 'secret' adds the never-shown caption
  ask: 'secret' | 'plain' | null;
  onRetry?: (m: ChatMessage) => void;
}) {
  const t = useT();
  const own = msg.role === 'owner';
  const secretAsk = ask === 'secret';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, opacity: msg.failed ? 0.65 : 1 }}>
      {ask && (
        <span style={{ alignSelf: 'flex-start', padding: '0 4px', fontFamily: T.font, fontSize: 12, fontWeight: 600, color: T.sub }}>
          {t('Your bot needs a key from you', 'Боту нужен ключ от вас')}
        </span>
      )}
      <Bubble T={T} from={own ? 'user' : 'bot'} animateIn={msg.id < 0}>
        {own
          ? <span style={{ whiteSpace: 'pre-line' }}>{msg.content}</span>
          : <ChatMarkdown T={T} text={msg.content} />}
      </Bubble>
      {secretAsk && (
        <span style={{
          alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 4px',
          fontFamily: T.font, fontSize: 12, color: T.hint,
        }}>
          <TGIcon name="lock" size={12} color={T.hint} stroke={2} />
          {t('Stored encrypted · never shown in this chat', 'Хранится в зашифрованном виде · в чате не показывается')}
        </span>
      )}
      {msg.failed && (
        <button onClick={onRetry ? () => onRetry(msg) : undefined} style={{
          alignSelf: 'flex-end', display: 'inline-flex', alignItems: 'center', gap: 5,
          border: 'none', background: 'none', padding: '0 4px', cursor: onRetry ? 'pointer' : 'default',
          fontFamily: T.font, fontSize: 12.5, fontWeight: 600, color: T.accent,
          WebkitTapHighlightColor: 'transparent',
        }}>
          <TGIcon name="refresh" size={13} color={T.accent} stroke={2} />
          {t('Not sent — tap to retry', 'Не отправлено — нажмите, чтобы повторить')}
        </button>
      )}
    </div>
  );
}, (a, b) => a.T === b.T && a.msg.id === b.msg.id && a.msg.content === b.msg.content
  && a.msg.failed === b.msg.failed && a.ask === b.ask && (!a.msg.failed || a.onRetry === b.onRetry));

export function ChatThread({ T, messages, thinking, thinkingStatus, opts, envAsk, onOption, onRetry, escape }: {
  T: Theme; messages: ChatMessage[]; thinking: boolean;
  thinkingStatus?: string; // what the AI is doing right now — shown in the typing bubble
  opts: QuickOpts | null;  // from useChat — the open question's quick replies
  envAsk: EnvAsk | null;   // from useChat — the open env question
  onOption?: (label: string) => void;
  onRetry?: (m: ChatMessage) => void; // re-send a failed owner message
  // a persistent escape chip rendered beside the quick replies (intake only):
  // "Just build it — you decide the rest"
  escape?: { label: string; onPick: () => void } | null;
}) {
  const { lang } = useLang();
  const chips = onOption ? opts : null;
  return (
    <>
      {messages.map(m => {
        const data = m.data as { kind?: string } | undefined;
        if (data?.kind === 'action' || m.role === 'system') return <EventRow key={m.id} T={T} msg={m} />;
        // The OPEN question for a secret says where the value goes, before it's
        // typed — this is the one place in the chat whose answer isn't kept.
        // Only the open one: on an answered question the note is just noise.
        const ask = envAsk && envAsk.msgId === m.id ? (envAsk.secret ? 'secret' : 'plain') : null;
        return <MessageRow key={m.id} T={T} msg={m} ask={ask} onRetry={onRetry} />;
      })}
      {thinking && <TypingBubble T={T} status={thinkingStatus} />}
      {/* quick replies live at the foot of the feed, terracotta bordered chips */}
      {chips && !thinking && onOption && (
        <QuickReplies T={T} options={chips.options} onPick={onOption} multi={chips.multi} display={o => chipLabel(lang, o)} />
      )}
      {chips && !thinking && escape && (
        <button onClick={escape.onPick} style={{
          alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 7,
          border: 'none', cursor: 'pointer', padding: '9px 16px', borderRadius: 999,
          background: T.accentSoft, color: T.accent,
          fontFamily: T.font, fontSize: 13.5, fontWeight: 600, WebkitTapHighlightColor: 'transparent',
        }}>
          {escape.label}
        </button>
      )}
    </>
  );
}
