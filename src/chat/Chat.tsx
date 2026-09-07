// Chat — the owner↔AI chat plumbing + renderer behind the Bot page: intake
// questions, env questions, build events and post-build change requests are
// ONE thread. Backed by the real chat API: cursor polling, optimistic owner
// messages, ai_thinking typing indicator, quick-reply options, role=system
// build/deploy events.
import { useEffect, useRef, useState } from 'react';
import { Theme } from '../theme';
import { ChatMessage, getChatMessages, sendChatMessage } from '../api/client';
import { Bubble, TypingBubble, Spinner, EventCard, QuickReplies, TGIcon } from '../ui';
import { ChatMarkdown } from './markdown';
import { pendingEnvAsk, maskSecret } from './env';
import { useT } from '../i18n';

// adaptive polling: tight while an AI turn is running (the answer can land
// any moment), relaxed when the chat is idle, and much slower when the chat
// isn't the focused view.
const POLL_FAST_MS = 1200;
const POLL_IDLE_MS = 4000;
const POLL_BG_MS = 12000;

export interface ChatState {
  messages: ChatMessage[];
  thinking: boolean;
  thinkingStatus: string; // what the AI is doing right now (ai_thinking_status)
  send: (text: string) => void;
  retry: (m: ChatMessage) => void; // re-send a failed optimistic message
}

export function useChat(projectId: string | null, active: boolean, focused = true): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState('');
  const cursor = useRef(0);
  const seen = useRef<Set<number>>(new Set());
  const pollNow = useRef<() => void>(() => {});

  // fresh thread per project
  useEffect(() => {
    setMessages([]); setThinking(false); setThinkingStatus('');
    cursor.current = 0; seen.current = new Set();
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      let busy = false;
      try {
        const r = await getChatMessages(projectId, cursor.current);
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
      } catch { /* transient — next tick retries */ }
      timer = setTimeout(tick, !focused ? POLL_BG_MS : busy ? POLL_FAST_MS : POLL_IDLE_MS);
    };
    pollNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    tick();
    return () => { cancelled = true; pollNow.current = () => {}; if (timer) clearTimeout(timer); };
  }, [projectId, active, focused]);

  const send = (text: string) => {
    const t = text.trim();
    if (!projectId || !t) return;
    const tempId = -Date.now();
    // While the chat is asking for one of the bot's settings, THIS message is
    // that value. The server never stores it as typed — only a mask — so the
    // optimistic copy must not render it either: otherwise the secret sits in
    // the thread, in the clear, for the rest of the session.
    const ask = pendingEnvAsk(messages);
    // …unless they tapped one of the question's own chips ("Skip for now", "Use
    // my Telegram ID"): that's a button, not a value, and masking it would flash
    // "••••now" back at the owner.
    const tapped = !!activeOptions(messages)?.options.includes(t);
    const optimistic: ChatMessage = ask?.secret && !tapped
      ? { id: tempId, role: 'owner', content: maskSecret(t), envEcho: true, raw: t }
      : { id: tempId, role: 'owner', content: t, envEcho: !!ask };
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

  return { messages, thinking, thinkingStatus, send, retry };
}

// quick replies belong to the LAST assistant message with no owner reply after it
export function activeOptions(messages: ChatMessage[]): { msgId: number; options: string[]; multi: boolean } | null {
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

// Map a system/action event to a Bold stage palette + icon. `data.kind`
// (README event kinds) drives it; otherwise fall back to content severity.
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
  log_only: { palette: 'neutral', icon: 'code' },
  pr_opened: { palette: 'amber', icon: 'code' },
  build: { palette: 'terracotta', icon: 'bolt' },
  deploy: { palette: 'green', icon: 'arrowUp' },
  pause: { palette: 'neutral', icon: 'pause' },
  resume: { palette: 'green', icon: 'play' },
};

interface EventData { kind?: string; action?: string; label?: string; title?: string; sub?: string; detail?: string; status?: string; metadata?: { stage?: string } }

function eventLook(msg: ChatMessage): { palette: Pal; icon: string } {
  const d = (msg.data || {}) as EventData;
  const key = d.kind && d.kind !== 'action' ? d.kind : (d.action || '');
  // go-live message: "published_with_gaps" reads amber (live, but polish me);
  // clean "publishing" stays green celebratory.
  if (key === 'bot_deploy') {
    return d.metadata?.stage === 'published_with_gaps'
      ? { palette: 'amber', icon: 'spark' }
      : { palette: 'green', icon: 'spark' };
  }
  if (EVENT_KIND[key]) return EVENT_KIND[key];
  const probe = `${msg.content || ''} ${JSON.stringify(msg.data ?? '')} ${d.status || ''}`.toLowerCase();
  return /fail|error|crash|broken|🔴|❌|⛔|✗/.test(probe)
    ? { palette: 'terracotta', icon: 'close' }
    : { palette: 'green', icon: 'check' };
}

// A system/agent event → full-width stage-coloured event card (Bold 1c).
function EventRow({ T, msg }: { T: Theme; msg: ChatMessage }) {
  const d = (msg.data || {}) as EventData;
  const look = eventLook(msg);
  return (
    <EventCard
      T={T} palette={look.palette} icon={look.icon}
      title={d.title || d.label || msg.content}
      sub={d.sub || d.detail || undefined}
    />
  );
}

export function ChatThread({ T, messages, thinking, thinkingStatus, onOption, onRetry, escape, pendingNote }: {
  T: Theme; messages: ChatMessage[]; thinking: boolean;
  thinkingStatus?: string; // what the AI is doing right now — shown in the typing bubble
  onOption?: (label: string) => void;
  onRetry?: (m: ChatMessage) => void; // re-send a failed owner message
  // a persistent escape chip rendered beside the quick replies (intake only):
  // "Just build it — you decide the rest"
  escape?: { label: string; onPick: () => void } | null;
  pendingNote?: string | null; // a spinner line under the thread
}) {
  const t = useT();
  const opts = onOption ? activeOptions(messages) : null;
  // The one open env question, if any — see the caption below.
  const envAsk = pendingEnvAsk(messages);
  return (
    <>
      {messages.map(m => {
        const data = m.data as { kind?: string } | undefined;
        if (data?.kind === 'action' || m.role === 'system') return <EventRow key={m.id} T={T} msg={m} />;
        const own = m.role === 'owner';
        // The OPEN question for a secret says where the value goes, before it's
        // typed — this is the one place in the chat whose answer isn't kept.
        // Only the open one: on an answered question the note is just noise.
        const secretAsk = !!envAsk?.secret && envAsk.msgId === m.id;
        return (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 5, opacity: m.failed ? 0.65 : 1 }}>
            <Bubble T={T} from={own ? 'user' : 'bot'} animateIn={m.id < 0}>
              {own
                ? <span style={{ whiteSpace: 'pre-line' }}>{m.content}</span>
                : <ChatMarkdown T={T} text={m.content} />}
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
            {m.failed && (
              <button onClick={onRetry ? () => onRetry(m) : undefined} style={{
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
      })}
      {thinking && <TypingBubble T={T} status={thinkingStatus} />}
      {/* quick replies live at the foot of the feed, terracotta bordered chips */}
      {opts && !thinking && onOption && (
        <QuickReplies T={T} options={opts.options} onPick={onOption} multi={opts.multi} />
      )}
      {opts && !thinking && escape && (
        <button onClick={escape.onPick} style={{
          alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 7,
          border: 'none', cursor: 'pointer', padding: '9px 16px', borderRadius: 999,
          background: T.accentSoft, color: T.accent,
          fontFamily: T.font, fontSize: 13.5, fontWeight: 600, WebkitTapHighlightColor: 'transparent',
        }}>
          {escape.label}
        </button>
      )}
      {pendingNote && !thinking && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, alignSelf: 'center', padding: '4px 0' }}>
          <Spinner color={T.hint} size={14} />
          <span style={{ fontFamily: T.font, fontSize: 13, color: T.hint }}>{pendingNote}</span>
        </div>
      )}
    </>
  );
}
