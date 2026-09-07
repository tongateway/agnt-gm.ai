// Bot (#/bots/<id>) — the chat-first bot page. One screen for a draft, a
// building bot, a live one and a closed idea: a header card (avatar · name ·
// one status line · the single action that matters), usage once live, and the
// ONE chat thread (intake questions, env questions, build events, post-build
// change requests) with the composer pinned at the bottom.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Theme, btnReset, hexA, toneFor } from '../theme';
import {
  ApiError, Project, ProjectBot, BotAnalytics, Deployment, humanError,
  getProject, getProjectBot, getBotAnalytics, listDeployments, deployFailed,
  initiateBot, botIsLive, setBotPaused, setDiscoverable, regenerateBotAvatar, retryDeploy, rebuildBot, deleteProject,
} from '../api/client';
import { useChat, ChatThread } from '../chat/Chat';
import { Composer, isDraftSlug } from '../manage/MyBots';
import { UsageCard } from '../manage/Usage';
import { openTgLink, haptic } from '../telegram';
import { useVisible } from '../util/visible';
import { navigate } from '../router';
import { useT, useLang, tr } from '../i18n';
import { relTime } from '../util/time';
import { TGIcon, BotTile, Spinner, Dot, EventCard, Sheet, SheetRow, Switch, ConfirmSheet } from '../ui';

// What the old "Good enough" button sent — the server recognises deferral in
// any wording (and any language), so the owner sees it in their own.
const JUST_BUILD_IT: [string, string] = [
  'Decide everything else yourself with sensible defaults and start building.',
  'Реши всё остальное сам с разумными настройками по умолчанию и начинай собирать.',
];
const NAMING_RETRY_MS = 3000;
const NAMING_MAX_TRIES = 40;     // ≈ 2 min of "Naming your bot…"
const WAITING_TIMEOUT_MS = 90000; // "Finishing in Telegram…" before offering a way out
const POLL_HIDDEN_MS = 12000;     // all pollers while the mini-app is minimised

// The one status line, keyed on the stable build_progress.stage. The server's
// stage_label is English-only and names pass numbers / a Rebuild button v2
// doesn't have, so it is only a dev-mode fallback for a stage we don't know.
const STAGE_LINE: Record<string, [string, string]> = {
  blueprint: ['Drafting the plan…', 'Готовим план…'],
  building: ['Building your bot…', 'Собираем бота…'],
  reviewing: ['Checking the build…', 'Проверяем сборку…'],
  testing: ['Testing your bot…', 'Тестируем бота…'],
  deploying: ['Launching…', 'Запускаем…'],
  awaiting_bot: ['Built — create your bot to launch it', 'Собран — создайте бота, чтобы запустить'],
  awaiting_agent: ['Waiting to start the build…', 'Ждём начала сборки…'],
  live: ['Live', 'В эфире'],
  live_with_gaps: ['Live · a few features still missing — ask below', 'В эфире · кое-что ещё не готово — попросите ниже'],
  failed: ['The build hit a snag', 'Сборка споткнулась'],
};

type CreateState = { step: 'idle' } | { step: 'naming'; tries: number } | { step: 'waiting'; deepLink?: string };
type Busy = 'pause' | 'discover' | 'avatar' | 'deploy' | 'rebuild' | 'delete' | null;

// rejected / failed-before-build / archived: the server runs no AI turn and no
// bot can be created — the page is read-only with one way out (a new bot)
const isClosed = (status: string) => status === 'rejected' || status === 'failed' || status === 'archived';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function BotScreen({ T, projectId }: { T: Theme; projectId: string }) {
  const t = useT();
  const { lang } = useLang();
  const visible = useVisible();
  const [project, setProject] = useState<Project | null>(null);
  const [bot, setBot] = useState<ProjectBot | null>(null);
  const [analytics, setAnalytics] = useState<BotAnalytics | null>(null);
  const [latestDeploy, setLatestDeploy] = useState<Deployment | null>(null);
  const [create, setCreate] = useState<CreateState>({ step: 'idle' });
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [draft, setDraft] = useState('');

  // ── derived state (server truth) ──
  const status = project?.status ?? 'draft';
  const rejected = status === 'rejected';
  const closed = isClosed(status);
  const bp = project?.build_progress ?? null;
  // the project DTO (4 s poll) carries bot_username / bot_is_live too — don't
  // wait up to 20 s for the bot poll to notice what the page already knows
  const botUsername = bot?.bot_username || project?.bot_username || '';
  const hasBot = !!botUsername;
  const botLive = botIsLive(bot) || (!!project?.bot_is_live && !bot?.paused);
  // the build converged (the phase reached published) — independent of whether
  // the bot is answering: it can be live BEFORE this, and built without a bot.
  const buildDone = bp
    ? bp.phase === 'published' || bp.stage === 'live' || bp.stage === 'live_with_gaps' || bp.stage === 'awaiting_bot'
    : project?.current_phase === 'published' || !!project?.bot_go_live_at;
  const buildFailed = bp?.stage === 'failed' || status === 'failed';
  const building = !!project && !closed && status !== 'draft' && !buildDone && !buildFailed;
  const live = botLive; // "answering users" — the only signal the usage card trusts
  // bot_go_live_at is two-sided (published AND deployed), so during "Live ·
  // still building" the deploy history is the only stamp there is
  const upSince = project?.bot_go_live_at || project?.preview_live_at
    || (latestDeploy?.status === 'live' ? latestDeploy.deployed_at : undefined);
  const name = project && !isDraftSlug(project.slug) ? project.name : t('New bot', 'Новый бот');

  // a closed thread is fetched once and never polled again
  const chat = useChat(projectId, closed ? 'once' : true, visible);

  // ── polling: project 4 s while draft/building, 20 s once live; once when closed ──
  const fast = useRef(true);
  fast.current = !project || status === 'draft' || building;
  const visRef = useRef(visible);
  visRef.current = visible;
  // bumped by every owner mutation: a poll that started BEFORE it must not
  // overwrite the optimistic result with the pre-mutation snapshot
  const mutation = useRef(0);
  const pollProjectNow = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let wantRepoll = false;
    const tick = async () => {
      if (cancelled) return;
      if (inFlight) { wantRepoll = true; return; }
      if (!visRef.current) { timer = setTimeout(tick, POLL_HIDDEN_MS); return; }
      inFlight = true;
      const gen = mutation.current;
      let stop = false;
      try {
        const d = await getProject(projectId);
        if (cancelled) return;
        if (gen === mutation.current) setProject(prev => (same(prev, d.project) ? prev : d.project));
        stop = isClosed(d.project.status); // a closed project never changes again
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { navigate({ name: 'home' }, true); return; }
      } finally { inFlight = false; }
      if (cancelled || stop) return;
      timer = setTimeout(tick, wantRepoll ? 0 : fast.current ? 4000 : 20000);
      wantRepoll = false;
    };
    pollProjectNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    return () => { cancelled = true; pollProjectNow.current = () => {}; if (timer) clearTimeout(timer); };
  }, [projectId]);

  // ── polling: bot 5 s while one is expected (Create tapped, or the project says
  // it exists and this poll hasn't caught up), else 20 s; never when closed ──
  const botFast = useRef(false);
  botFast.current = !bot?.bot_username && (create.step !== 'idle' || !!project?.bot_username);
  const pollBotNow = useRef<() => void>(() => {});
  useEffect(() => {
    if (closed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let wantRepoll = false;
    const tick = async () => {
      if (cancelled) return;
      if (inFlight) { wantRepoll = true; return; }
      if (!visRef.current) { timer = setTimeout(tick, POLL_HIDDEN_MS); return; }
      inFlight = true;
      try {
        const b = await getProjectBot(projectId).catch(() => undefined);
        if (cancelled) return;
        if (b !== undefined) setBot(prev => (same(prev, b) ? prev : b));
        if (b?.bot_username) {
          const dep = await listDeployments(projectId).catch(() => null);
          if (cancelled) return;
          if (dep) { const d = dep.deployments?.[0] ?? null; setLatestDeploy(prev => (same(prev, d) ? prev : d)); }
        }
      } finally { inFlight = false; }
      if (cancelled) return;
      timer = setTimeout(tick, wantRepoll ? 0 : botFast.current ? 5000 : 20000);
      wantRepoll = false;
    };
    pollBotNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    return () => { cancelled = true; pollBotNow.current = () => {}; if (timer) clearTimeout(timer); };
  }, [projectId, closed]);

  // the project poll saw the bot appear / come up — re-read the bot row now
  useEffect(() => {
    if (project?.bot_is_live || project?.bot_username) pollBotNow.current();
  }, [project?.bot_is_live, project?.bot_username]);

  // back from the background (the t.me/newbot flow, another chat): catch up at once
  const wasHidden = useRef(false);
  useEffect(() => {
    if (!visible) { wasHidden.current = true; return; }
    if (!wasHidden.current) return;
    wasHidden.current = false;
    pollProjectNow.current();
    pollBotNow.current();
  }, [visible]);

  // ── analytics: once per open + every 60 s, only while live ──
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const load = () => getBotAnalytics(projectId).then(a => { if (!cancelled && a) setAnalytics(a); }).catch(() => {});
    void load();
    const timer = setInterval(() => { if (visRef.current) void load(); }, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectId, live]);

  // a short note under the header (an action's outcome) — clears itself
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 7000);
    return () => clearTimeout(timer);
  }, [note]);

  // ── scroll: a draft opens on its question; a built bot opens on its header
  // card (Open @bot, Pause/Keys/Plan, usage) — not on the last build log line.
  // After that, follow new arrivals only while the owner is near the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevLen = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !project) return; // the initial decision needs the status
    const len = chat.messages.length;
    const last = chat.messages[len - 1];
    const optimistic = !!last && last.id < 0;
    const initial = prevLen.current === 0 && len > 0;
    prevLen.current = len;
    const pin = optimistic || (initial
      ? status === 'draft' || !!chat.envAsk || !!chat.opts // a question is waiting at the foot
      : nearBottom.current);
    // opened on the header: the owner hasn't scrolled, so the ref would still
    // read "near bottom" and the next arrival would yank the header away
    if (initial && !pin) nearBottom.current = false;
    if (!pin) return;
    // pin after paint: a synchronous scrollHeight can be stale before the bubbles settle
    const doPin = () => { el.scrollTop = el.scrollHeight; };
    const r = requestAnimationFrame(() => { doPin(); requestAnimationFrame(doPin); });
    return () => cancelAnimationFrame(r);
  }, [chat.messages.length, chat.thinking, !!project]);

  // ── Create your bot: initiate → open the deep link → poll until it lands ──
  // 409 retry:true = the project isn't named yet (first turn still running):
  // retry every 3 s. 409 bot_username = a bot already exists: just poll it.
  const createBot = useCallback(async () => {
    setNote(null);
    try {
      const init = await initiateBot(projectId);
      setCreate({ step: 'waiting', deepLink: init.deep_link });
      if (init.deep_link) openTgLink(init.deep_link);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.botUsername) { setCreate({ step: 'waiting' }); pollBotNow.current(); return; }
      if (e instanceof ApiError && e.status === 409 && e.retry) {
        setCreate(prev => ({ step: 'naming', tries: prev.step === 'naming' ? prev.tries + 1 : 1 }));
        return;
      }
      setCreate({ step: 'idle' });
      setNote({ error: true, text: humanError(e, lang) });
    }
  }, [projectId, lang]);
  useEffect(() => {
    if (create.step !== 'naming') return;
    if (closed || create.tries >= NAMING_MAX_TRIES) {
      setCreate({ step: 'idle' });
      if (!closed) setNote({ error: true, text: t('Still naming your bot — try again in a minute.', 'Всё ещё придумываем имя — попробуйте через минуту.') });
      return;
    }
    const timer = setTimeout(() => void createBot(), NAMING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [create, closed, createBot, t]);
  // the native create-bot sheet was dismissed or failed: after 90 s with no bot,
  // offer a real way back to the button instead of a spinner forever
  useEffect(() => {
    if (create.step !== 'waiting' || hasBot) { setWaitedTooLong(false); return; }
    const timer = setTimeout(() => setWaitedTooLong(true), WAITING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [create.step, hasBot]);

  // ── owner actions (all server-owned state; refetch after) ──
  const busyRef = useRef<Busy>(null); // the guard reads a ref — two taps in one frame both saw busy=null
  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<unknown>, done?: string) => {
    if (busyRef.current) return;
    busyRef.current = kind; setBusy(kind); setNote(null);
    mutation.current++;
    try { await fn(); haptic('success'); if (done) setNote({ text: done }); }
    catch (e) {
      haptic('error');
      setNote({ error: true, text: e instanceof ApiError && e.warning ? e.warning : humanError(e, lang) });
    } finally { busyRef.current = null; setBusy(null); }
  };
  const togglePause = () => run('pause', async () => {
    await setBotPaused(projectId, !bot?.paused);
    setBot(b => (b ? { ...b, paused: !b.paused } : b));
    pollBotNow.current(); pollProjectNow.current();
  });
  const discoverable = project?.discoverable !== false;
  const toggleDiscover = () => run('discover', async () => {
    await setDiscoverable(projectId, !discoverable);
    setProject(p => (p ? { ...p, discoverable: !discoverable } : p));
    pollProjectNow.current();
  });
  const regenAvatar = () => run('avatar', () => regenerateBotAvatar(projectId),
    t('New avatar is on its way — it lands in a minute.', 'Новый аватар уже в пути — появится через минуту.'));
  const redeploy = () => run('deploy', async () => { await retryDeploy(projectId); pollBotNow.current(); },
    t('Deploy started — watching for it to come online.', 'Деплой запущен — ждём, когда бот выйдет в онлайн.'));
  const rebuild = () => run('rebuild', async () => { await rebuildBot(projectId); pollProjectNow.current(); },
    t('Rebuild started — watch the chat for progress.', 'Пересборка запущена — следите за ходом в чате.'));
  // Delete stops the bot first: an archive alone leaves the container answering
  // users with no way back to Pause (archived bots leave the list). A pause that
  // fails aborts the delete rather than orphaning a running bot.
  const remove = () => run('delete', async () => {
    if (hasBot && !bot?.paused) await setBotPaused(projectId, true);
    await deleteProject(projectId);
    navigate({ name: 'home' }, true);
  });

  // ── the one status line ──
  const stageLine = bp?.stage && STAGE_LINE[bp.stage] ? tr(lang, ...STAGE_LINE[bp.stage]) : (import.meta.env.DEV ? bp?.stage_label : undefined);
  const intakeLine = chat.thinking
    ? (chat.messages.length <= 1 ? t('Reading your idea…', 'Читаю вашу идею…') : t('Thinking…', 'Думаю…'))
    : chat.opts ? t('One quick question', 'Один вопрос')
    : t('Tell me what to build', 'Расскажите, что собрать');
  const statusLine = rejected ? t("Can't build this one", 'Это не собрать')
    : status === 'failed' ? t("Build couldn't start", 'Сборка не запустилась')
    : status === 'archived' ? t('Deleted', 'Удалён')
    : botLive && !buildDone ? t('Live · still building', 'В эфире · ещё собирается')
    : bot?.paused ? t('Paused', 'На паузе')
    : status === 'draft' ? intakeLine
    : bp?.stage === 'live' && !live ? (deployFailed(latestDeploy) ? t('The last deploy failed', 'Последний деплой не удался') : t('Starting up…', 'Запускается…'))
    : stageLine ? stageLine
    : live ? t('Live', 'В эфире')
    : t('Getting started…', 'Начинаем…');
  const statusColor = rejected || buildFailed ? T.red : live ? '#2f8f6f' : bot?.paused ? T.hint : building || (bp?.stage === 'live' && !live) ? T.gold : T.accent;
  const percent = bp && building ? Math.max(3, Math.min(100, bp.percent)) : null;

  const envAsk = chat.envAsk;
  const composerPlaceholder = envAsk
    ? (envAsk.key ? t(`Paste ${envAsk.key}…`, `Вставьте ${envAsk.key}…`) : t('Paste the value…', 'Вставьте значение…'))
    : status === 'draft' ? t('Describe the bot…', 'Опишите бота…')
    : buildFailed ? t('Tell me what to fix…', 'Напишите, что исправить…')
    // the server does NOT queue a change sent mid-build ("send it again once
    // live") — the field must not promise otherwise
    : building ? t("Ask me anything — send changes once it's live", 'Спрашивайте что угодно — изменения пришлите, когда бот будет в эфире')
    : t('Ask for a change…', 'Попросите изменение…');
  const send = () => { const text = draft.trim(); if (!text) return; setDraft(''); chat.send(text); };
  // the server's English "🚫 This idea can't be built here…" line is replaced by
  // the local (translated) card; the reason itself is LLM-written in the owner's language
  const thread = useMemo(
    () => chat.messages.filter(m => !(m.role === 'system' && (m.data as { stage?: string } | undefined)?.stage === 'policy_rejected')),
    [chat.messages]);

  const pillBtn = (icon: string, label: string, onClick: () => void, spinning = false) => (
    <button key={label} onClick={onClick} style={{
      ...btnReset, flex: 1, height: 42, borderRadius: 13, background: T.nestedBg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      fontFamily: T.font, fontSize: 13.5, fontWeight: 600, color: T.text, minWidth: 0,
    }}>
      {spinning ? <Spinner color={T.sub} size={15} /> : <TGIcon name={icon} size={16} color={T.sub} stroke={2} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
  const linkBtn = (label: string, onClick: () => void) => (
    <button onClick={onClick} style={{ ...btnReset, height: 34, padding: '0 12px', borderRadius: 10, background: T.nestedBg, fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.accent }}>
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scrollRef}
        onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: '14px 14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── header card ── */}
        <div style={{ background: T.cardBg, borderRadius: 20, border: `1px solid ${T.sep}`, boxShadow: T.shadow, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <BotTile T={T} name={name} tone={toneFor(project?.slug || projectId)} src={project?.bot_avatar_url} size={54} radius={17} fontSize={22} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: T.font, fontSize: 18, fontWeight: 700, color: T.text, letterSpacing: -0.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
              {hasBot && (
                <div style={{ fontFamily: T.mono, fontSize: 12.5, color: T.hint, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  @{botUsername}{live && upSince ? ` · ${t('up', 'в эфире')} ${relTime(upSince, lang)}` : ''}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
                <Dot color={statusColor} size={7} pulse={building && !botLive} />
                <span style={{
                  fontFamily: T.font, fontSize: 13.5, fontWeight: 600, color: statusColor, lineHeight: '18px',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>{statusLine}</span>
              </div>
            </div>
          </div>
          {percent != null && (
            <div style={{ height: 4, borderRadius: 999, background: hexA(T.text, 0.1), overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: T.gold, transition: 'width .6s ease' }} />
            </div>
          )}

          {/* primary action — exactly one */}
          {closed ? (
            <PrimaryButton T={T} icon="plus" label={t('Start a new bot', 'Начать нового бота')} onClick={() => navigate({ name: 'home' })} />
          ) : !hasBot ? (
            create.step === 'waiting' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                  <Spinner color={T.accent} size={18} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 600, color: T.text }}>{t('Finishing in Telegram…', 'Завершаем в Telegram…')}</div>
                    <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 1, lineHeight: '16px' }}>
                      {t('Confirm the bot in the window that opened. It starts answering about a minute after that.', 'Подтвердите бота в открывшемся окне. Примерно через минуту после этого он начнёт отвечать.')}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {create.deepLink && linkBtn(t('Open again', 'Открыть снова'), () => openTgLink(create.deepLink!))}
                  {waitedTooLong && linkBtn(t("Didn't work? Try again", 'Не получилось? Попробовать снова'), () => setCreate({ step: 'idle' }))}
                </div>
              </div>
            ) : (
              <div>
                <PrimaryButton T={T} icon="send" busy={create.step === 'naming'}
                  label={create.step === 'naming' ? t('Naming your bot…', 'Придумываем имя…') : t('Create your bot', 'Создать бота')}
                  onClick={() => void createBot()} />
                <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, lineHeight: '17px', marginTop: 8, textAlign: 'center' }}>
                  {t('One tap in Telegram — no BotFather, no tokens. Your bot answers while we build.', 'Одно нажатие в Telegram — без BotFather и токенов. Бот отвечает, пока мы собираем.')}
                </div>
              </div>
            )
          ) : (
            <PrimaryButton T={T} icon="open" label={`${t('Open', 'Открыть')} @${botUsername}`} onClick={() => openTgLink(`https://t.me/${botUsername}`)} />
          )}

          {/* secondary row — only once the bot exists */}
          {hasBot && !closed && (
            <div style={{ display: 'flex', gap: 8 }}>
              {pillBtn(bot?.paused ? 'play' : 'pause', bot?.paused ? t('Resume', 'Включить') : t('Pause', 'Пауза'), togglePause, busy === 'pause')}
              {pillBtn('lock', t('Keys', 'Ключи'), () => navigate({ name: 'env', id: projectId }))}
              {pillBtn('beaker', t('Plan', 'План'), () => navigate({ name: 'plan', id: projectId }))}
              <button onClick={() => setSheet(true)} aria-label={t('More', 'Ещё')} style={{ ...btnReset, width: 42, height: 42, borderRadius: 13, background: T.nestedBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <TGIcon name="dots" size={20} color={T.sub} />
              </button>
            </div>
          )}
          {note && <div style={{ fontFamily: T.font, fontSize: 12.5, color: note.error ? T.red : T.green, lineHeight: '17px', textAlign: 'center' }}>{note.text}</div>}
        </div>

        {live && <UsageCard T={T} analytics={analytics} />}

        {/* ── the thread ── */}
        {!project && chat.messages.length === 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 18 }}><Spinner color={T.hint} size={18} /></div>
        )}
        <ChatThread T={T} messages={thread} thinking={chat.thinking} thinkingStatus={chat.thinkingStatus}
          opts={chat.opts} envAsk={chat.envAsk}
          onOption={closed ? undefined : chat.send} onRetry={chat.retry}
          escape={status === 'draft' && chat.opts && !envAsk
            ? { label: t('✨ Just build it — you decide the rest', '✨ Просто собери — реши сам'), onPick: () => chat.send(tr(lang, ...JUST_BUILD_IT)) }
            : null} />
        {rejected && (
          <EventCard T={T} palette="terracotta" icon="close" title={t("Can't build this one", 'Это не собрать')}
            sub={project?.rejection_reason || t('It falls outside what we can build here. Start a new bot to try a different idea.', 'Это за рамками того, что мы можем собрать. Начните нового бота с другой идеей.')} />
        )}
        {status === 'failed' && (
          <EventCard T={T} palette="terracotta" icon="refresh" title={t("Build couldn't start", 'Сборка не запустилась')}
            sub={t('Something broke on our side before the build started. Start a new bot with the same idea — it usually works the second time.', 'Что-то сломалось у нас ещё до начала сборки. Начните нового бота с той же идеей — обычно со второго раза всё получается.')} />
        )}
        {status === 'archived' && (
          <EventCard T={T} palette="neutral" icon="trash" title={t('This bot was deleted', 'Этот бот удалён')}
            sub={t('Start a new bot from the home screen.', 'Начните нового бота с главного экрана.')} />
        )}
        {buildFailed && !closed && (
          // the build gave up (phase failed) but the project is open: a chat
          // message re-enters the build, so say so — the red line alone doesn't
          <EventCard T={T} palette="terracotta" icon="refresh" title={t('The build hit a snag', 'Сборка споткнулась')}
            sub={t("Tell me what to change — or just say “try again” — and I'll rebuild.", 'Напишите, что поменять, — или просто «попробуй ещё раз» — и я пересоберу.')} />
        )}
      </div>

      {!closed && (
        <Composer T={T} draft={draft} onChange={setDraft} onSend={send} disabled={chat.thinking}
          secret={!!envAsk?.secret} placeholder={composerPlaceholder} />
      )}

      {/* ── "…" overflow sheet ── */}
      <Sheet T={T} open={sheet} onClose={() => setSheet(false)}>
        <SheetRow T={T} icon="compass" label={t('Show in Discover', 'Показывать в Каталоге')}
          sub={t('Let others find and try your bot', 'Другие смогут найти и попробовать бота')} busy={busy === 'discover'}
          onClick={toggleDiscover} trailing={<Switch T={T} on={discoverable} busy={busy === 'discover'} onClick={toggleDiscover} />} />
        <SheetRow T={T} icon="refresh" label={t('Regenerate avatar', 'Обновить аватар')} busy={busy === 'avatar'}
          onClick={() => { setSheet(false); void regenAvatar(); }} />
        {deployFailed(latestDeploy) && (
          <SheetRow T={T} icon="arrowUp" label={t('Retry deploy', 'Повторить деплой')}
            sub={t('The last deploy failed', 'Последний деплой не удался')} busy={busy === 'deploy'}
            onClick={() => { setSheet(false); void redeploy(); }} />
        )}
        {bp?.stage === 'failed' && (
          <SheetRow T={T} icon="bolt" label={t('Rebuild', 'Пересобрать')}
            sub={t('Run the build again from where it stopped', 'Запустить сборку заново с того места, где она остановилась')} busy={busy === 'rebuild'}
            onClick={() => { setSheet(false); void rebuild(); }} />
        )}
        <SheetRow T={T} icon="trash" danger label={t('Delete bot', 'Удалить бота')}
          onClick={() => { setSheet(false); setConfirmDelete(true); }} />
      </Sheet>
      <ConfirmSheet T={T} open={confirmDelete} destructive icon="trash"
        title={t('Delete this bot?', 'Удалить этого бота?')}
        body={hasBot
          ? t(`Removes ${name} and stops @${botUsername}. This can't be undone.`, `Удаляет ${name} и останавливает @${botUsername}. Это нельзя отменить.`)
          : t(`Removes ${name}. This can't be undone.`, `Удаляет ${name}. Это нельзя отменить.`)}
        confirmLabel={t('Delete', 'Удалить')} cancelLabel={t('Cancel', 'Отмена')}
        onConfirm={() => { setConfirmDelete(false); void remove(); }} onCancel={() => setConfirmDelete(false)} />
    </div>
  );
}

function PrimaryButton({ T, icon, label, onClick, busy }: { T: Theme; icon: string; label: string; onClick: () => void; busy?: boolean }) {
  return (
    <button onClick={busy ? undefined : onClick} style={{
      ...btnReset, width: '100%', height: 50, borderRadius: 15, background: T.accent, color: T.accentText,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
      fontFamily: T.font, fontSize: 16, fontWeight: 700, letterSpacing: -0.2, boxShadow: T.ctaShadow,
      cursor: busy ? 'default' : 'pointer',
    }}>
      {busy ? <Spinner color={T.accentText} size={18} /> : <TGIcon name={icon} size={18} color={T.accentText} stroke={2.2} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}
