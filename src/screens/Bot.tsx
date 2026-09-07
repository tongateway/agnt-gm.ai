// Bot (#/bots/<id>) — the chat-first bot page. One screen for a draft, a
// building bot, a live one and a rejected idea: a header card (avatar · name ·
// one server-owned status line · the single action that matters), usage once
// live, and the ONE chat thread (intake questions, env questions, build events,
// post-build change requests) with the composer pinned at the bottom.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Theme, btnReset, hexA, toneFor } from '../theme';
import {
  ApiError, Project, ProjectBot, BotAnalytics, Deployment,
  getProject, getProjectBot, getBotAnalytics, listDeployments, deployFailed,
  initiateBot, botIsLive, setBotPaused, setDiscoverable, regenerateBotAvatar, retryDeploy, deleteProject,
} from '../api/client';
import { useChat, ChatThread, activeOptions } from '../chat/Chat';
import { pendingEnvAsk } from '../chat/env';
import { Composer, isDraftSlug } from '../manage/MyBots';
import { UsageCard } from '../manage/Usage';
import { openTgLink, haptic } from '../telegram';
import { navigate } from '../router';
import { useT, useLang } from '../i18n';
import { relTime } from '../util/time';
import { TGIcon, BotTile, Spinner, Dot, EventCard, Sheet, SheetRow, Switch, ConfirmSheet } from '../ui';

// What the old "Good enough" button sent — the server recognises deferral in any
// wording, but this exact phrase is the one it was tuned on.
const JUST_BUILD_IT = 'Decide everything else yourself with sensible defaults and start building.';
const NAMING_RETRY_MS = 3000;
const NAMING_MAX_TRIES = 40; // ≈ 2 min of "Naming your bot…"

type CreateState = { step: 'idle' } | { step: 'naming'; tries: number } | { step: 'waiting'; deepLink?: string };
type Busy = 'pause' | 'discover' | 'avatar' | 'deploy' | 'delete' | null;

export function BotScreen({ T, projectId }: { T: Theme; projectId: string }) {
  const t = useT();
  const { lang } = useLang();
  const [project, setProject] = useState<Project | null>(null);
  const [bot, setBot] = useState<ProjectBot | null>(null);
  const [analytics, setAnalytics] = useState<BotAnalytics | null>(null);
  const [latestDeploy, setLatestDeploy] = useState<Deployment | null>(null);
  const [create, setCreate] = useState<CreateState>({ step: 'idle' });
  const [sheet, setSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const chat = useChat(projectId, true, true);

  // ── derived state (server truth) ──
  const status = project?.status ?? 'draft';
  const rejected = status === 'rejected';
  const bp = project?.build_progress ?? null;
  const hasBot = !!bot?.bot_username;
  const botLive = botIsLive(bot);
  // the build converged (the phase reached published) — independent of whether
  // the bot is answering: it can be live BEFORE this, and built without a bot.
  const buildDone = bp
    ? bp.phase === 'published' || bp.stage === 'live' || bp.stage === 'live_with_gaps' || bp.stage === 'awaiting_bot'
    : project?.current_phase === 'published' || !!project?.bot_go_live_at;
  const buildFailed = bp?.stage === 'failed' || status === 'failed';
  const building = !!project && !rejected && status !== 'draft' && !buildDone && !buildFailed;
  const live = botLive; // "answering users" — the only signal the usage card trusts
  const upSince = project?.bot_go_live_at || project?.preview_live_at;
  const envAsk = pendingEnvAsk(chat.messages);
  const opts = activeOptions(chat.messages);
  const name = project && !isDraftSlug(project.slug) ? project.name : t('New bot', 'Новый бот');

  // ── polling: project 4 s while draft/building, 20 s once live or rejected ──
  const fast = useRef(true);
  fast.current = !project || status === 'draft' || building;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const d = await getProject(projectId);
        if (cancelled) return;
        setProject(d.project);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { navigate({ name: 'home' }, true); return; }
      }
      timer = setTimeout(tick, fast.current ? 4000 : 20000);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [projectId]);

  // ── polling: bot 5 s until it exists, then 20 s (deployments ride along) ──
  const botFast = useRef(true);
  botFast.current = !hasBot;
  const pollBotNow = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      const b = await getProjectBot(projectId).catch(() => undefined);
      if (cancelled) return;
      if (b !== undefined) setBot(b);
      if (b?.bot_username) {
        const dep = await listDeployments(projectId).catch(() => null);
        if (cancelled) return;
        if (dep) setLatestDeploy(dep.deployments?.[0] ?? null);
      }
      timer = setTimeout(tick, botFast.current ? 5000 : 20000);
    };
    pollBotNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    return () => { cancelled = true; pollBotNow.current = () => {}; if (timer) clearTimeout(timer); };
  }, [projectId]);

  // ── analytics: once per open + every 60 s, only while live ──
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const load = () => getBotAnalytics(projectId).then(a => { if (!cancelled && a) setAnalytics(a); }).catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectId, live]);

  // a short note under the header (an action's outcome) — clears itself
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 7000);
    return () => clearTimeout(timer);
  }, [note]);

  // ── keep the thread pinned to the newest message (unless the owner scrolled up) ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = chat.messages[chat.messages.length - 1];
    if (!(last && last.id < 0) && !nearBottom.current) return; // reading history — don't yank
    // pin after paint: a synchronous scrollHeight can be stale before the bubbles settle
    const pin = () => { el.scrollTop = el.scrollHeight; };
    const r = requestAnimationFrame(() => { pin(); requestAnimationFrame(pin); });
    return () => cancelAnimationFrame(r);
  }, [chat.messages.length, chat.thinking, project?.id]);

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
      setNote({ error: true, text: e instanceof ApiError ? e.message : t('network error — try again', 'ошибка сети — попробуйте снова') });
    }
  }, [projectId, t]);
  useEffect(() => {
    if (create.step !== 'naming') return;
    if (rejected || create.tries >= NAMING_MAX_TRIES) {
      setCreate({ step: 'idle' });
      if (!rejected) setNote({ error: true, text: t('Still naming your bot — try again in a minute.', 'Всё ещё придумываем имя — попробуйте через минуту.') });
      return;
    }
    const timer = setTimeout(() => void createBot(), NAMING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [create, rejected, createBot, t]);

  // ── owner actions (all server-owned state; refetch after) ──
  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(kind); setNote(null);
    try { await fn(); haptic('success'); if (done) setNote({ text: done }); }
    catch (e) {
      haptic('error');
      setNote({ error: true, text: e instanceof ApiError ? (e.warning || e.message) : t('network error — try again', 'ошибка сети — попробуйте снова') });
    } finally { setBusy(null); }
  };
  const togglePause = () => run('pause', async () => {
    await setBotPaused(projectId, !bot?.paused);
    setBot(b => (b ? { ...b, paused: !b.paused } : b));
    pollBotNow.current();
  });
  const discoverable = project?.discoverable !== false;
  const toggleDiscover = () => run('discover', async () => {
    await setDiscoverable(projectId, !discoverable);
    setProject(p => (p ? { ...p, discoverable: !discoverable } : p));
  });
  const regenAvatar = () => run('avatar', () => regenerateBotAvatar(projectId),
    t('New avatar is on its way — it lands in a minute.', 'Новый аватар уже в пути — появится через минуту.'));
  const redeploy = () => run('deploy', () => retryDeploy(projectId),
    t('Deploy started — watching for it to come online.', 'Деплой запущен — ждём, когда бот выйдет в онлайн.'));
  const remove = () => run('delete', async () => { await deleteProject(projectId); navigate({ name: 'home' }, true); });

  // ── the one status line (server-owned when the build snapshot has one) ──
  const statusLine = rejected ? t("Can't build this one", 'Это не собрать')
    : status === 'failed' ? t("Build couldn't start — needs a look", 'Сборка не запустилась — нужно взглянуть')
    : botLive && !buildDone ? t('Live · still building', 'В эфире · ещё собирается')
    : bot?.paused ? t('Paused', 'На паузе')
    : bp?.stage_label ? bp.stage_label
    : status === 'draft' ? t('Tell me what to build', 'Расскажите, что собрать')
    : live ? t('Live', 'В эфире')
    : t('Getting started…', 'Начинаем…');
  const statusColor = rejected || buildFailed ? T.red : live ? '#2f8f6f' : bot?.paused ? T.hint : building ? T.gold : T.accent;
  const percent = bp && building ? Math.max(3, Math.min(100, bp.percent)) : null;

  const composerPlaceholder = envAsk
    ? (envAsk.key ? t(`Paste ${envAsk.key}…`, `Вставьте ${envAsk.key}…`) : t('Paste the value…', 'Вставьте значение…'))
    : status === 'draft' ? t('Describe the bot…', 'Опишите бота…')
    : building ? t("Ask or request a change — I'll apply it once it's live", 'Спросите или попросите изменение — применю, когда бот будет в эфире')
    : t('Ask for a change…', 'Попросите изменение…');
  const send = () => { const text = draft.trim(); if (!text) return; setDraft(''); chat.send(text); };
  const policyCardShown = chat.messages.some(m => m.role === 'system' && (m.data as { stage?: string } | undefined)?.stage === 'policy_rejected');

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
                  @{bot!.bot_username}{live && upSince ? ` · ${t('up', 'в сети')} ${relTime(upSince, lang)}` : ''}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
                <Dot color={statusColor} size={7} pulse={building && !botLive} />
                <span style={{ fontFamily: T.font, fontSize: 13.5, fontWeight: 600, color: statusColor, lineHeight: '18px' }}>{statusLine}</span>
              </div>
            </div>
          </div>
          {percent != null && (
            <div style={{ height: 4, borderRadius: 999, background: hexA(T.text, 0.1), overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: T.gold, transition: 'width .6s ease' }} />
            </div>
          )}

          {/* primary action — exactly one */}
          {rejected ? (
            <PrimaryButton T={T} icon="plus" label={t('Start a new bot', 'Начать нового бота')} onClick={() => navigate({ name: 'home' })} />
          ) : !hasBot ? (
            create.step === 'waiting' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 2px' }}>
                <Spinner color={T.accent} size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 600, color: T.text }}>{t('Finishing in Telegram…', 'Завершаем в Telegram…')}</div>
                  <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 1, lineHeight: '16px' }}>
                    {t('Confirm the bot in the window that opened — it starts answering within a minute.', 'Подтвердите бота в открывшемся окне — он начнёт отвечать через минуту.')}
                    {create.deepLink && <> <span onClick={() => openTgLink(create.deepLink!)} style={{ color: T.accent, fontWeight: 600, cursor: 'pointer' }}>{t('Open again', 'Открыть снова')}</span></>}
                  </div>
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
            <PrimaryButton T={T} icon="open" label={`${t('Open', 'Открыть')} @${bot!.bot_username}`} onClick={() => openTgLink(`https://t.me/${bot!.bot_username}`)} />
          )}

          {/* secondary row — only once the bot exists */}
          {hasBot && !rejected && (
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
        <ChatThread T={T} messages={chat.messages} thinking={chat.thinking} thinkingStatus={chat.thinkingStatus}
          onOption={rejected ? undefined : chat.send} onRetry={chat.retry}
          escape={status === 'draft' && opts && !envAsk
            ? { label: t('✨ Just build it — you decide the rest', '✨ Просто собери — реши сам'), onPick: () => chat.send(JUST_BUILD_IT) }
            : null} />
        {rejected && !policyCardShown && (
          <EventCard T={T} palette="terracotta" icon="close" title={t("Can't build this one", 'Это не собрать')}
            sub={project?.rejection_reason || t('It falls outside what we can build here. Start a new bot to try a different idea.', 'Это за рамками того, что мы можем собрать. Начните нового бота с другой идеей.')} />
        )}
        {status === 'failed' && (
          <EventCard T={T} palette="terracotta" icon="refresh" title={t("Build couldn't start", 'Сборка не запустилась')}
            sub={project?.rejection_reason || t('Something went wrong on our side. Tell me here and I’ll try again.', 'Что-то пошло не так с нашей стороны. Напишите здесь — попробую ещё раз.')} />
        )}
      </div>

      {!rejected && (
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
            sub={latestDeploy?.failure_reason || t('The last deploy failed', 'Последний деплой не удался')} busy={busy === 'deploy'}
            onClick={() => { setSheet(false); void redeploy(); }} />
        )}
        <SheetRow T={T} icon="trash" danger label={t('Delete bot', 'Удалить бота')}
          onClick={() => { setSheet(false); setConfirmDelete(true); }} />
      </Sheet>
      <ConfirmSheet T={T} open={confirmDelete} destructive icon="trash"
        title={t('Delete this bot?', 'Удалить этого бота?')}
        body={hasBot
          ? t(`Removes ${name} from your list. @${bot!.bot_username} keeps running in Telegram — to delete it completely, send /deletebot to @BotFather.`,
              `Удаляет ${name} из вашего списка. @${bot!.bot_username} продолжит работать в Telegram — чтобы удалить его полностью, отправьте /deletebot в @BotFather.`)
          : t(`Removes ${name} from your list.`, `Удаляет ${name} из вашего списка.`)}
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
