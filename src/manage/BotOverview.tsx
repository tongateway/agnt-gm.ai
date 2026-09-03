// BotOverview — per-bot overview page (My Bots → bot). Everything real:
// build progress, task/PR stats from the project, Test bot via the managed
// bot's @username, Recent Activity from the chat's system events (full feed on
// the "View all" page). "Open chat" opens the owner ↔ build-agent chat. The
// platform's cloud agent is assigned automatically on bot creation — there is
// no agent-choice step.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Theme, btnReset, hexA } from '../theme';
import {
  ApiError, Project, TaskItem, ChatMessage, Deployment, DagInfo, TaskDetail, BotAnalytics, ProjectBot, BotInitiate, BuildProgress as BuildProgressDTO,
  getProject, fetchProjectTasks, getProjectBot, listDeployments, getTaskDetail, getBotAnalytics,
  botIsLive, retryDeploy, setAutoMerge, initiateBot, postFeedback, publishProject, regenerateBotAvatar,
  getBotEnv, type BotEnvPanel,
} from '../api/client';
import { openTgLink, openExternal } from '../telegram';
import { TGIcon, Card, Pill, Dot, BotTile, Spinner, ProgressRing, Sparkline } from '../ui';
import { MyBot } from './MyBots';
import { relTime } from './Activity';
import { useBlocked, BlockedBadge } from './TaskManagerInbox';
import { useT, useLang, tr, type Lang } from '../i18n';

// human-readable count: 3100 → "3.1k", 12000 → "12k"
function human(n?: number): string {
  if (n == null) return '—';
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

// hoisted so they aren't rebuilt on each scan iteration (js-hoist-regexp)
const RE_TEST_COUNT = /(\d+)\s*\/\s*(\d+)\s*(?:tests?|cases?|passing)/i;
const RE_COVERAGE = /(\d+)\s*%\s*cov/i;

// latest test results — structured (data.kind=test) or parsed from a system
// message like "38/38 passing · 94% cov"; null until CI results exist.
function latestTests(sys: ChatMessage[]): { passed: number; total: number; coverage?: number } | null {
  for (let i = sys.length - 1; i >= 0; i--) {
    const m = sys[i];
    const d = m.data as { kind?: string; passed?: number; failed?: number; coverage_pct?: number } | undefined;
    if (d?.kind === 'test' && typeof d.passed === 'number') {
      return { passed: d.passed, total: d.passed + (d.failed || 0), coverage: d.coverage_pct };
    }
    const t = RE_TEST_COUNT.exec(m.content);
    if (t) {
      const cov = RE_COVERAGE.exec(m.content);
      return { passed: +t[1], total: +t[2], coverage: cov ? +cov[1] : undefined };
    }
  }
  return null;
}

const TASK_DOT: Record<string, 'green' | 'accent' | 'hint'> = {
  done: 'green', in_progress: 'accent', in_review: 'accent', blocked: 'accent', failed: 'hint', open: 'hint',
};

// active work first, queued next, done last — the collapsed view shows
// what matters now
function orderTasks(tasks: TaskItem[]): TaskItem[] {
  const rank: Record<string, number> = { in_progress: 0, open: 1, done: 2 };
  return [...tasks].sort((a, b) => (rank[a.status] ?? 1) - (rank[b.status] ?? 1));
}

// the build pipeline's phases with the current one highlighted
const PHASES = ['general', 'design', 'details', 'dev', 'tests'];

function PhaseStrip({ T, dag, lang }: { T: Theme; dag: DagInfo; lang: Lang }) {
  const idx = PHASES.indexOf(dag.current_phase || '');
  const failed = dag.phase_status === 'failed';
  return (
    <div style={{ padding: '12px 14px 11px' }}>
      <div style={{ display: 'flex', gap: 5 }}>
        {PHASES.map((p, i) => (
          <div key={p} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: i < idx ? T.accent
              : i === idx ? (failed ? T.red : T.accent)
              : hexA(T.text, 0.1),
            opacity: i < idx ? 0.55 : 1,
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7 }}>
        <span style={{ fontFamily: T.font, fontSize: 12, fontWeight: 600, color: failed ? T.red : T.accent }}>
          {lang === 'ru' ? `фаза ${dag.current_phase}` : `${dag.current_phase} phase`}{failed ? tr(lang, ' · fixing issues', ' · исправление ошибок') : dag.phase_status && dag.phase_status !== 'open' ? ` · ${dag.phase_status}` : ''}
        </span>
        {idx >= 0 && (
          <span style={{ fontFamily: T.font, fontSize: 12, color: T.hint }}>{idx + 1} {tr(lang, 'of', 'из')} {PHASES.length}</span>
        )}
      </div>
    </div>
  );
}

type ProgressState = 'done' | 'active' | 'todo' | 'failed';
type ProgressStep = { label: string; state: ProgressState };

function BuildProgress({ T, steps }: { T: Theme; steps: ProgressStep[] }) {
  const colorFor = (state: ProgressState) =>
    state === 'done' ? T.green : state === 'failed' ? T.red : state === 'active' ? T.accent : T.hint;
  return (
    <Card T={T} pad={13}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`, gap: 8 }}>
        {steps.map((s, i) => {
          const color = colorFor(s.state);
          return (
            <div key={s.label} style={{ minWidth: 0 }}>
              <div style={{
                height: 4, borderRadius: 999,
                background: s.state === 'todo' ? hexA(T.text, 0.1) : color,
                opacity: s.state === 'done' ? 0.72 : 1,
              }} />
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                {s.state === 'done'
                  ? <TGIcon name="check" size={13} color={T.green} stroke={2.7} />
                  : <Dot color={color} size={6} pulse={s.state === 'active'} />}
                <span style={{
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontFamily: T.font, fontSize: 11.5, fontWeight: i === 0 || s.state !== 'todo' ? 600 : 500,
                  color: s.state === 'todo' ? T.hint : color,
                }}>{s.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// whole_bot 4-step mapping for the top stepper (blueprint→Plan, building→Build,
// tests→Test, published→Live).
function wholeBotSteps(bp: BuildProgressDTO | null, live: boolean, lang: Lang): ProgressStep[] {
  const ph = bp?.phase || (live ? 'published' : 'building');
  const failed = ph === 'failed';
  const done = live || ph === 'published';
  // awaiting_agent: the build hasn't actually started — no builder agent is
  // assigned yet. Don't pulse Build as "in progress"; it's still queued behind
  // the assign step, so leave it as a not-started 'todo'.
  const awaitingAgent = bp?.stage === 'awaiting_agent' && !done;
  return [
    { label: tr(lang, 'Plan', 'План'), state: 'done' },
    { label: tr(lang, 'Build', 'Сборка'), state: failed ? 'failed' : done || ph === 'tests' ? 'done' : awaitingAgent ? 'todo' : 'active' },
    { label: tr(lang, 'Test', 'Тест'), state: ph === 'tests' ? 'active' : done ? 'done' : 'todo' },
    { label: tr(lang, 'Live', 'В эфире'), state: done ? 'done' : failed ? 'failed' : 'todo' },
  ];
}

const PASS_TONE: Record<string, 'green' | 'accent' | 'hint' | 'red'> = {
  building: 'accent', merged: 'accent', reviewed: 'green', failed: 'red',
};

// one clean status word from the build stage (preferred) or phase — the card
// headline. We deliberately drop the "N of M passes" floor counter (it reads as
// a regression on a change/rebuild, where the count resets); the iteration
// number rides alongside, small + gray, as a secondary detail.
function buildStatusLabel(bp: BuildProgressDTO, lang: Lang): string {
  switch (bp.stage) {
    case 'blueprint': return tr(lang, 'Planning', 'Планирование');
    case 'building': return tr(lang, 'Building', 'Сборка');
    case 'reviewing': return tr(lang, 'Reviewing', 'Проверка');
    case 'testing': return tr(lang, 'Testing', 'Тестирование');
    case 'deploying': return tr(lang, 'Deploying', 'Деплой');
    case 'live': return tr(lang, 'Live', 'В эфире');
    case 'failed': return tr(lang, 'Failed', 'Ошибка');
    case 'awaiting_agent': return tr(lang, 'Waiting for agent', 'Ожидание агента');
    case 'awaiting_bot': return tr(lang, 'Connect your bot', 'Подключите бота');
  }
  switch (bp.phase) {
    case 'tests': return tr(lang, 'Testing', 'Тестирование');
    case 'published': return tr(lang, 'Live', 'В эфире');
    case 'failed': return tr(lang, 'Failed', 'Ошибка');
    default: return tr(lang, 'Building', 'Сборка');
  }
}

// eta_seconds → a human "≈ 5 min" / "≈ 45s" instead of the raw "≈ 1560с". Under a
// minute stays in seconds; a minute or more rounds to whole minutes (the ETA is
// approximate — the backend interpolates it over the pass's build_started_at).
function fmtEta(secs: number, lang: Lang): string {
  if (secs < 60) return `≈ ${secs}${tr(lang, 's', 'с')}`;
  const mins = Math.max(1, Math.round(secs / 60));
  return `≈ ${mins} ${tr(lang, 'min', 'мин')}`;
}

// whole_bot build card (one-pass model): the ring + the backend's stage_label +
// a compact per-step log. Usually a single pass → live.
function WholeBotBuildCard({ T, bp }: { T: Theme; bp: BuildProgressDTO }) {
  const t = useT();
  const { lang } = useLang();
  const pct = Math.max(3, Math.min(100, bp.percent));
  // one-pass model: the build is usually a single pass → live. The passes[]
  // timeline stays as a compact log; expand if it ever grows.
  const [showAllIters, setShowAllIters] = useState(false);
  const STEP_VISIBLE = 4;
  const allIters = bp.passes ?? [];
  const hiddenIters = allIters.length - STEP_VISIBLE;
  const visibleIters = showAllIters || hiddenIters <= 0 ? allIters : allIters.slice(-STEP_VISIBLE);
  const showIterToggle = hiddenIters > 0;
  // stage drives colour / branching only; stage_label is the ready status string.
  const failed = bp.stage === 'failed';
  const gaps = bp.stage === 'live_with_gaps';
  // awaiting_bot: built (phase=published) but NO Telegram bot connected — nothing
  // deployed, so it must NOT render as live; the connect-bot CTA below finishes it.
  const awaitingBot = bp.stage === 'awaiting_bot';
  const live = (bp.stage === 'live' || gaps || bp.phase === 'published') && !awaitingBot;
  const arc = failed ? T.red : (gaps || awaitingBot) ? T.gold : undefined;
  const dotColor = failed ? T.red : (gaps || awaitingBot) ? T.gold : live ? T.green : T.accent;
  const label = bp.stage_label || buildStatusLabel(bp, lang);
  const ringLabel = failed ? t('needs fix', 'правка')
    : awaitingBot ? t('needs bot', 'нужен бот')
    : gaps ? t('with gaps', 'с пробелами')
    : live ? t('complete', 'готово')
    : bp.eta_seconds > 0 ? fmtEta(bp.eta_seconds, lang)
    : t('building', 'сборка');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* dark-green build hero — ring + the backend's stage_label (verbatim) */}
      <div style={{ background: T.text, borderRadius: 20, boxShadow: T.heroShadow, padding: '20px 16px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: '100%' }}>
          <Dot color={dotColor} size={8} pulse={!live && !failed} />
          <span style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 700, color: T.accentText, letterSpacing: -0.2, textAlign: 'center', lineHeight: '19px' }}>
            {label}
          </span>
        </div>
        <ProgressRing T={T} value={pct} label={ringLabel} color={arc} />
      </div>
      {allIters.length > 0 && (
        <Card T={T} pad={0}>
          {showIterToggle && (
            <button onClick={() => setShowAllIters(v => !v)} style={{ ...btnReset, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 16px' }}>
              <span style={{ fontFamily: T.font, fontSize: 12.5, fontWeight: 600, color: T.accent }}>
                {showAllIters ? t('Show fewer', 'Свернуть') : t(`Show all ${allIters.length} steps`, `Показать все ${allIters.length} шагов`)}
              </span>
              <span style={{ display: 'inline-flex', transform: showAllIters ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }}>
                <TGIcon name="chevDown" size={14} color={T.accent} stroke={2.2} />
              </span>
            </button>
          )}
          {visibleIters.map((p, i) => {
            const tone = PASS_TONE[p.status] || 'hint';
            const color = tone === 'green' ? T.green : tone === 'red' ? T.red : tone === 'accent' ? T.accent : T.hint;
            return (
              <div key={p.pass_no} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: (i > 0 || showIterToggle) ? `0.5px solid ${T.sep}` : 'none' }}>
                {p.status === 'reviewed' && p.complete
                  ? <TGIcon name="check" size={15} color={T.green} stroke={2.6} />
                  : <Dot color={color} size={7} pulse={p.status === 'building'} />}
                {/* label is a ready-made row string — render as-is */}
                <span style={{ flex: 1, fontFamily: T.font, fontSize: 13.5, color: T.text }}>{p.label}</span>
                {p.pr_number != null && <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent }}>#{p.pr_number}</span>}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function deployFailed(d?: Deployment | null): boolean {
  if (!d) return false;
  return !!d.failure_reason || /fail|error|cancel/i.test(d.status || '');
}

function deployActive(d?: Deployment | null): boolean {
  if (!d) return false;
  return /queue|pending|build|deploy|progress|running|started/i.test(d.status || '');
}

// uppercase section label, reused across sections
function SectionLabel({ T, children, right }: { T: Theme; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 4px 11px' }}>
      <span style={{ fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.hint, textTransform: 'uppercase', letterSpacing: 0.3 }}>{children}</span>
      {right}
    </div>
  );
}

// one small usage stat inside the Usage card
function UsageTile({ T, label, value, tone, dot, up }: {
  T: Theme; label: string; value: string; tone?: string; dot?: string; up?: boolean;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: T.nestedBg, borderRadius: 14, padding: '11px 12px' }}>
      <div style={{ fontFamily: T.font, fontSize: 11.5, color: T.hint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, flexShrink: 0 }} />}
        <span style={{ fontFamily: T.font, fontSize: 18, fontWeight: 700, color: tone || T.text, letterSpacing: -0.4 }}>{value}</span>
        {up && <TGIcon name="arrowUp" size={12} color={T.green} stroke={2.6} />}
      </div>
    </div>
  );
}

// Last overview snapshot per bot. Re-opening a bot paints instantly from this
// cache, then the tick refreshes it — instead of six cold fetches every visit.
interface OvSnap {
  detail: Project | null; tasks: TaskItem[]; dag: DagInfo | null; deploys: Deployment[];
  botRow: ProjectBot | null; botUsername: string | null;
  analytics: BotAnalytics | null; isTaskManager: boolean;
}
const OV_CACHE = new Map<string, OvSnap>();

export function BotOverview({ T, bot, messages, onOpenChat, onOpenBoard, onOpenInbox, onOpenPlan, onOpenEnv, onDelete, onViewActivity, paused, onTogglePause, discoverable, onToggleDiscoverable }: {
  T: Theme; bot: MyBot; messages: ChatMessage[];
  onOpenChat: () => void; onOpenBoard: () => void; onOpenInbox?: () => void; onOpenPlan?: () => void; onOpenEnv?: () => void; onDelete: () => void;
  onViewActivity: () => void;
  paused: boolean; onTogglePause: () => void;
  discoverable: boolean; onToggleDiscoverable: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const seed = OV_CACHE.get(bot.id); // instant re-open from the last snapshot
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [detail, setDetail] = useState<Project | null>(seed?.detail ?? null);
  const [tasks, setTasks] = useState<TaskItem[]>(seed?.tasks ?? []);
  const [dag, setDag] = useState<DagInfo | null>(seed?.dag ?? null);
  const [deploys, setDeploys] = useState<Deployment[]>(seed?.deploys ?? []);
  const [botUsername, setBotUsername] = useState<string | null>(seed?.botUsername ?? null);
  const [botRow, setBotRow] = useState<ProjectBot | null>(seed?.botRow ?? null);
  const [analytics, setAnalytics] = useState<BotAnalytics | null>(seed?.analytics ?? null);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<Record<string, TaskDetail | 'loading' | 'none'>>({});
  const [isTaskManager, setIsTaskManager] = useState(seed?.isTaskManager ?? bot.isTaskManager ?? false); // verdict from cache → bot prop → /dag node_kind
  const blocked = useBlocked(bot.id, isTaskManager); // attention badge (owner /blocked)
  const [creatingBot, setCreatingBot] = useState(false);
  const [botInit, setBotInit] = useState<BotInitiate | null>(null); // deep link issued, waiting for Telegram
  const [createBotErr, setCreateBotErr] = useState<string | null>(null);
  const [regenAvatar, setRegenAvatar] = useState(false);   // avatar regenerate in flight
  const [regenAvatarErr, setRegenAvatarErr] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);          // redeploy in flight
  const [addingTask, setAddingTask] = useState(false); // "Add new task" input open
  const [taskDraft, setTaskDraft] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const addTaskRef = useRef<HTMLTextAreaElement>(null);
  // Env summary for the Settings row's badge. Fetched ONCE per open, not
  // polled: it changes only when the owner edits it, and the overview already
  // runs enough pollers.
  const [envSummary, setEnvSummary] = useState<BotEnvPanel['summary'] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await getBotEnv(bot.id);
        if (alive) setEnvSummary(p?.summary ?? null);
      } catch { /* the row just stays hidden — never block the overview on it */ }
    })();
    return () => { alive = false; };
  }, [bot.id]);

  // grow the add-task input to fit the text (descriptions can be long), up to a
  // cap, then scroll within it
  useEffect(() => {
    const el = addTaskRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, Math.max(38, el.scrollHeight)) + 'px';
  }, [taskDraft, addingTask]);

  // add a task: the owner's path into the living DAG is feedback (POST /feedback),
  // which the analyzer turns into task(s). The new task shows on the next poll.
  const submitNewTask = async () => {
    const text = taskDraft.trim();
    if (!text || addBusy) return;
    setAddBusy(true); setAddErr(null);
    try {
      await postFeedback(bot.id, text);
      setTaskDraft(''); setAddingTask(false);
      // nudge a refresh shortly after so the new task appears promptly
      setTimeout(() => {
        void fetchProjectTasks(bot.id).then(t => { setTasks(t.tasks); setDag(t.dag ?? null); }).catch(() => {});
      }, 3000);
    } catch (e) {
      setAddErr(e instanceof ApiError ? (e.status === 429 ? t('Too many requests — try again shortly.', 'Слишком много запросов — попробуйте чуть позже.') : e.message) : t('network error — try again', 'ошибка сети — попробуйте снова'));
    } finally { setAddBusy(false); }
  };

  // tap a task → expand with the full title + body fetched from the API
  const toggleTask = (slug: string) => {
    setExpandedTask(prev => (prev === slug ? null : slug));
    if (!taskDetails[slug]) {
      setTaskDetails(prev => ({ ...prev, [slug]: 'loading' }));
      getTaskDetail(bot.id, slug).then(d =>
        setTaskDetails(prev => ({ ...prev, [slug]: d ?? 'none' })));
    }
  };

  // provision the managed Telegram bot (the step the task_manager flow used to
  // reach via the spec wizard) — reserve a username + open the manager-bot deep
  // link; the poll below picks the bot up once it's created in Telegram.
  const createBot = async () => {
    if (creatingBot || botUsername) return;
    setCreatingBot(true); setCreateBotErr(null);
    try {
      const init = await initiateBot(bot.id);
      setBotInit(init);
      if (init.deep_link) openTgLink(init.deep_link);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setBotInit({}); // already exists — just poll
      else setCreateBotErr(e instanceof ApiError ? `${t("Couldn't start", 'Не удалось начать')} — ${e.message}` : t('network error — try again', 'ошибка сети — попробуйте снова'));
    } finally { setCreatingBot(false); }
  };

  // regenerate the AI avatar (owner): async 202, then the project poll below
  // lands the new bot_avatar_url. Show a brief "generating…" state meanwhile;
  // it clears when a different URL arrives (effect below) or after a cap so it
  // never spins forever if generation is slow/failed server-side.
  const avatarUrl = detail?.bot_avatar_url;
  const regenAvatarBaseline = useRef<string | undefined>(undefined);
  const regenAvatarTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onRegenAvatar = async () => {
    if (regenAvatar) return;
    setRegenAvatar(true); setRegenAvatarErr(null);
    regenAvatarBaseline.current = avatarUrl; // remember the pre-regen URL
    try {
      await regenerateBotAvatar(bot.id);
      // safety floor: stop the spinner after a while even if no new URL lands
      if (regenAvatarTimer.current) clearTimeout(regenAvatarTimer.current);
      regenAvatarTimer.current = setTimeout(() => setRegenAvatar(false), 90000);
    } catch (e) {
      setRegenAvatar(false);
      setRegenAvatarErr(e instanceof ApiError ? (e.status === 429 ? 'Too many requests — try again shortly.' : e.message) : 'network error — try again');
    }
  };
  // clear the "generating" state once the poll lands a new (different) avatar URL
  useEffect(() => {
    if (regenAvatar && avatarUrl && avatarUrl !== regenAvatarBaseline.current) {
      setRegenAvatar(false);
      if (regenAvatarTimer.current) clearTimeout(regenAvatarTimer.current);
    }
  }, [avatarUrl, regenAvatar]);
  // tidy the safety timer on unmount
  useEffect(() => () => { if (regenAvatarTimer.current) clearTimeout(regenAvatarTimer.current); }, []);

  // after initiate, poll quickly until the managed-bot poller lands the row
  useEffect(() => {
    if (!botInit || botUsername) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const b = await getProjectBot(bot.id).catch(() => null);
      if (cancelled) return;
      if (b?.bot_username) {
        setBotRow(b); setBotUsername(b.bot_username);
        // build trigger: creating the bot is the last onboarding step (the agent
        // was assigned first), so publish now to kick off the build. task_manager
        // projects auto-build, so a publish there 409s — skip it. Errors mean it's
        // already building/published; the status poll reconciles either way.
        if (!isTaskManager) void publishProject(bot.id).catch(() => { /* already building */ });
        return;
      }
      timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [botInit, botUsername, bot.id, isTaskManager]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const [d, t, dep, b, an] = await Promise.all([
        getProject(bot.id).catch(() => null),
        fetchProjectTasks(bot.id).catch(() => null),
        listDeployments(bot.id).catch(() => null),
        getProjectBot(bot.id).catch(() => null),
        getBotAnalytics(bot.id).catch(() => null),
      ]);
      if (cancelled) return;
      if (d) setDetail(d.project);
      if (t) { setTasks(t.tasks); setDag(t.dag ?? null); }
      if (dep) setDeploys(dep.deployments || []);
      if (b) { setBotRow(b); if (b.bot_username) setBotUsername(b.bot_username); }
      if (an) setAnalytics(an);
      // route old vs new: build_pipeline (once it ships) else node_kind off the
      // DAG fetchProjectTasks already loaded — no second /dag round-trip.
      // upgrade-only: don't flip a known task_manager verdict back to false off an
      // empty DAG mid-decompose (which would nuke the create-bot CTA + loader).
      if (d?.project.build_pipeline) setIsTaskManager(d.project.build_pipeline === 'task_manager');
      else if (t?.isTaskManager) setIsTaskManager(true);
      // refresh the snapshot cache (keep prior values where a fetch failed)
      const prev = OV_CACHE.get(bot.id);
      OV_CACHE.set(bot.id, {
        detail: d?.project ?? prev?.detail ?? null,
        tasks: t?.tasks ?? prev?.tasks ?? [],
        dag: t?.dag ?? prev?.dag ?? null,
        deploys: dep?.deployments ?? prev?.deploys ?? [],
        botRow: b ?? prev?.botRow ?? null,
        botUsername: b?.bot_username ?? prev?.botUsername ?? null,
        analytics: an ?? prev?.analytics ?? null,
        isTaskManager: d?.project.build_pipeline ? d.project.build_pipeline === 'task_manager' : (t?.isTaskManager || prev?.isTaskManager || bot.isTaskManager || false),
      });
      // while a task_manager bot is still decomposing (no tasks) or its managed
      // bot hasn't landed, poll quickly so the overview fills in fast; relax once settled
      const tmHint = bot.isTaskManager === true || t?.isTaskManager === true || isTaskManager;
      const settling = tmHint && ((t?.tasks?.length ?? 0) === 0 || !b?.bot_username);
      timer = setTimeout(tick, settling ? 6000 : 20000);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [bot.id]);

  const repoUrl = detail?.github_repo_url;
  // the bot's blueprint (build brief) lives in the repo; the "Spec" action links it
  const blueprintUrl = repoUrl ? `${repoUrl.replace(/\/$/, '')}/blob/main/docs/blueprint.md` : null;

  const onRetry = () => { if (retrying) return; setRetrying(true); retryDeploy(bot.id).catch(() => {}).finally(() => setTimeout(() => setRetrying(false), 4000)); };

  const sys = messages.filter(m => m.role === 'system');
  // count only real work tasks (exclude epics = display-only containers, and
  // cancelled) so the overview total matches the board. Phase projects: count all.
  const countable = isTaskManager ? tasks.filter(t => t.node_kind !== 'epic' && t.status !== 'cancelled') : tasks;
  const done = countable.filter(t => t.status === 'done').length;
  const total = countable.length;
  const allDone = total > 0 && done >= total;
  const latestDeploy = deploys[0] ?? null;
  const latestDeployFailed = deployFailed(latestDeploy);
  const latestDeployActive = deployActive(latestDeploy);
  const since = detail?.published_at || detail?.created_at;
  const uptime = since ? relTime(since, lang) : null;
  // the real go-live signal (NOT project.status): current_phase==='published'
  // OR the managed bot's container_state. Drives the feedback channel.
  const live = dag?.current_phase === 'published' || detail?.current_phase === 'published' || botIsLive(botRow);
  // whole_bot N-pass build: no tasks/DAG — the build screen shows a stage/%/ETA
  // card + pass timeline (from project.build_progress) instead of the task list.
  const wholeBot = detail?.build_pipeline === 'whole_bot' || !!detail?.build_progress;
  const bp = detail?.build_progress ?? null;
  // whole_bot build that failed to converge — must override the stale "Live"
  // label inherited from the My Bots list (which keys off project.status and
  // can't see build_progress, a detail-only field).
  const buildFailed = bp?.phase === 'failed' || bp?.stage === 'failed';
  const wholeBotBuilding = wholeBot && !live;
  // a whole_bot build/redeploy is actively in flight — the initial build, or a
  // rebuild on a still-live bot (bp.phase building/tests). The backend rejects a
  // new change until it's live again, so the "Ask for change" CTA is paused while
  // this is true rather than letting the tap fail in chat.
  const buildRunning = wholeBot && (wholeBotBuilding || bp?.phase === 'building' || bp?.phase === 'tests');
  const pausedEffective = paused || !!botRow?.paused;
  const needsBot = isTaskManager && !botUsername;          // managed bot not provisioned yet
  // non-task_manager bot with no Telegram bot connected yet — suggest wiring it
  // up. NOT gated on `live`: a build can finish (phase=published ⇒ live=true)
  // without a bot ever being connected, and hiding the CTA then LOSES the state —
  // nothing is deployed and the owner has no button left (the reported bug). With
  // no bot_username there is nothing actually live, so the CTA must persist.
  // `!!detail` still gates the flash before the first poll lands.
  const suggestConnect = !isTaskManager && !!detail && !botUsername;
  // onboarding on the overview: `needsCreate` is the pre-bot state (either
  // pipeline) that shows the single "Create bot" step. The platform's cloud
  // agent is assigned automatically on bot creation — no agent-choice step.
  const needsCreate = needsBot || suggestConnect;
  // whole_bot build that CAN'T start because no bot is connected (→ no cloud agent).
  // The ~5% "building" ring/health is a lie here — nothing runs until the owner
  // connects a bot. Surface the create-bot CTA instead (the reported stuck-at-5% bug).
  const awaitingBotConnect = wholeBot && bp?.stage === 'awaiting_agent';
  const decomposing = isTaskManager && tasks.length === 0; // DAG still being built
  const testResult = latestTests(sys);
  const testsFailed = !!testResult && testResult.passed < testResult.total;
  const statusState = (() => {
    if (pausedEffective) return { label: `${t('Paused', 'На паузе')} · ${bot.version}`, tone: 'neutral' as const, color: T.hint, pulse: false };
    if (live) return { label: `${t('Live', 'В эфире')}${uptime ? ` · ${t('up', 'работает')} ${uptime}` : ''} · ${bot.version}`, tone: 'green' as const, color: T.green, pulse: false };
    if (needsBot) return { label: t('Create bot to continue', 'Создайте бота, чтобы продолжить'), tone: 'accent' as const, color: T.accent, pulse: true };
    if (awaitingBotConnect) return { label: t('Connect your bot', 'Привяжите бота'), tone: 'accent' as const, color: T.accent, pulse: true };
    if (latestDeployFailed || testsFailed || buildFailed) return { label: t('Needs a fix', 'Нужна правка'), tone: 'neutral' as const, color: T.red, pulse: false };
    if (blocked.items.length > 0) return { label: t('Needs you', 'Требуется ваше внимание'), tone: 'accent' as const, color: T.accent, pulse: true };
    if (latestDeployActive) return { label: t('Deploying', 'Деплой'), tone: 'accent' as const, color: T.accent, pulse: true };
    if (allDone && botUsername) return { label: t('Testing & deploy', 'Тесты и деплой'), tone: 'accent' as const, color: T.accent, pulse: true };
    if (decomposing) return { label: t('Planning build', 'Планирование сборки'), tone: 'accent' as const, color: T.accent, pulse: true };
    return { label: bot.statusLabel || t('Building', 'Сборка'), tone: 'accent' as const, color: T.accent, pulse: true };
  })();
  // One plain-language health line that folds container / status / build-stage /
  // pause into a single actionable status (priority: awaiting → FAILED →
  // building → paused → live-with-gaps → live → other). Failed must outrank
  // building: a failed whole_bot still matches wholeBotBuilding (it isn't live),
  // and must not read as an eternally running build.
  const gapsLive = wholeBot && bp?.stage === 'live_with_gaps';
  const health: { label: string; color: string; bg: string; pulse: boolean; action?: { label: string; icon: string; onClick: () => void } } = (() => {
    if (buildFailed || testsFailed || latestDeployFailed) return { label: t('Build needs a fix', 'Сборка требует правки'), color: T.red, bg: T.redSoft, pulse: false,
      action: { label: t('Fix in chat', 'Исправить в чате'), icon: 'chat', onClick: onOpenChat } };
    // Nothing is actually building — the bot isn't connected. Don't show a fake %.
    if (awaitingBotConnect) return { label: t('Connect your bot to start', 'Привяжите бота, чтобы начать'), color: T.accent, bg: T.accentSoft, pulse: true,
      action: { label: t('Create bot', 'Создать бота'), icon: 'send', onClick: () => void createBot() } };
    if (buildRunning || wholeBotBuilding) {
      const p = bp ? Math.max(3, Math.min(100, bp.percent)) : null;
      return { label: `${t('Building your bot', 'Собираю бота')}${p != null ? ` · ${p}%` : '…'}`, color: T.gold, bg: T.goldSoft, pulse: true };
    }
    if (pausedEffective) return { label: t('Paused', 'На паузе'), color: T.hint, bg: T.nestedBg, pulse: false,
      action: { label: t('Resume', 'Возобновить'), icon: 'play', onClick: onTogglePause } };
    if (gapsLive) return { label: t('Live · a few things to polish', 'В эфире · есть что доработать'), color: T.gold, bg: T.goldSoft, pulse: false,
      action: { label: t('Refine in chat', 'Доработать в чате'), icon: 'chat', onClick: onOpenChat } };
    if (live) return { label: `${t('Live', 'В эфире')} · ${t('running', 'работает')}`, color: '#2f8f6f', bg: T.sage, pulse: false };
    return { label: statusState.label, color: statusState.color, bg: T.nestedBg, pulse: statusState.pulse };
  })();
  const progressSteps: ProgressStep[] = wholeBot ? wholeBotSteps(bp, live, lang) : [
    { label: t('Plan', 'План'), state: total > 0 || !decomposing ? 'done' : 'active' },
    { label: t('Build', 'Сборка'), state: latestDeployFailed ? 'failed' : allDone ? 'done' : (total > 0 || decomposing ? 'active' : 'todo') },
    { label: t('Test', 'Тест'), state: testsFailed ? 'failed' : testResult ? 'done' : allDone ? 'active' : 'todo' },
    { label: t('Live', 'В эфире'), state: live ? 'done' : latestDeployFailed ? 'failed' : latestDeployActive ? 'active' : 'todo' },
  ];


  return (
    <div style={{ padding: '14px 16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* identity — avatar · name / @username · regenerate */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
          <BotTile T={T} name={bot.name} tone={bot.tone} src={avatarUrl} size={64} radius={20} fontSize={26} />
          {regenAvatar && (
            <div style={{
              position: 'absolute', inset: 0, borderRadius: 20,
              background: hexA('#000000', 0.4),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Spinner color="#fff" size={20} />
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: T.font, fontSize: 20, fontWeight: 700, color: T.text, letterSpacing: -0.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bot.name}</div>
          <div style={{ marginTop: 6 }}>
            {botUsername
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: T.sage, borderRadius: 999, padding: '4px 11px' }}>
                  <Dot color="#2f8f6f" size={6} />
                  <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 600, color: '#2f8f6f' }}>@{botUsername}</span>
                </span>
              : <span style={{ fontFamily: T.font, fontSize: 13, color: T.hint }}>{t('Bot not created yet', 'Бот ещё не создан')}</span>}
          </div>
        </div>
        <button onClick={() => void onRegenAvatar()} disabled={regenAvatar} aria-label={t('Regenerate avatar', 'Обновить аватар')} style={{
          ...btnReset, width: 40, height: 40, borderRadius: 12, flexShrink: 0,
          background: T.nestedBg, border: `1px solid ${T.sep}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: regenAvatar ? 'default' : 'pointer',
        }}>
          <TGIcon name="refresh" size={18} color={regenAvatar ? T.hint : T.sub} stroke={2} />
        </button>
      </div>
      {regenAvatarErr && (
        <div style={{ fontFamily: T.font, fontSize: 11.5, color: T.amber, lineHeight: '15px' }}>{regenAvatarErr}</div>
      )}

      {/* one smart health status (plain language + the single action that matters) */}
      {botUsername && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, borderRadius: 999, padding: '8px 14px',
              background: health.bg, color: health.color, fontFamily: T.font, fontSize: 14.5, fontWeight: 700, letterSpacing: -0.2,
            }}>
              <Dot color={health.color} size={8} pulse={health.pulse} />
              {health.label}
            </span>
            {health.action && (
              <button onClick={health.action.onClick} style={{
                ...btnReset, display: 'inline-flex', alignItems: 'center', gap: 5,
                fontFamily: T.font, fontSize: 13.5, fontWeight: 700, color: health.color,
              }}>
                <TGIcon name={health.action.icon} size={15} color={health.color} stroke={2.2} /> {health.action.label}
              </button>
            )}
          </div>
          {live && (
            <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 7, padding: '0 2px' }}>
              {bot.version}{uptime ? ` · ${t('up', 'в сети')} ${uptime}` : ''}
            </div>
          )}
        </div>
      )}

      {/* live_with_gaps — bot is live, but the blueprint isn't fully covered.
          Not a failure: refine it by chatting (the one-pass "fix later" flow). */}
      {bp?.stage === 'live_with_gaps' && (
        <button onClick={onOpenChat} style={{
          ...btnReset, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12,
          padding: '13px 15px', borderRadius: 16, background: T.goldSoft, border: `1px solid ${hexA(T.gold, 0.4)}`,
        }}>
          <div style={{ width: 36, height: 36, borderRadius: 11, background: hexA(T.gold, 0.18), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <TGIcon name="spark" size={18} color={T.gold} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.font, fontSize: 14, fontWeight: 700, color: T.gold }}>{t('Live — a few things to polish', 'В эфире — есть что доработать')}</div>
            <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.sub, marginTop: 1, lineHeight: '17px' }}>{t('Your bot is running. Ask me here to fix or add anything.', 'Бот уже работает. Напишите здесь, что исправить или добавить.')}</div>
          </div>
          <TGIcon name="chevRight" size={18} color={T.gold} stroke={2} />
        </button>
      )}

      {/* Onboarding (either pipeline) before the bot exists: a single step —
          create the bot. Creating it publishes the project and kicks off the
          build (see the create poll above); the platform's cloud agent is
          assigned automatically on creation, so there's no agent-choice step. */}
      {needsCreate && (
        <Card T={T} pad={0} style={{ border: `1px solid ${T.accentBorder}` }}>
          {botInit ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px' }}>
              <Spinner color={T.accent} size={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 600, color: T.text }}>{t('Finishing in Telegram…', 'Завершаем в Telegram…')}</div>
                <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 1, lineHeight: '16px' }}>{t('Create the bot in the window that opened — your bot starts building once it’s set up.', 'Создайте бота в открывшемся окне — сборка начнётся, как только он будет настроен.')}</div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => void createBot()}
              disabled={creatingBot}
              style={{ ...btnReset, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', cursor: creatingBot ? 'default' : 'pointer' }}
            >
              <div style={{ width: 38, height: 38, borderRadius: 11, background: T.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {creatingBot ? <Spinner color={T.accent} size={18} /> : <TGIcon name="send" size={19} color={T.accent} stroke={1.9} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.font, fontSize: 15, fontWeight: 600, color: T.text }}>{t('Create bot', 'Создать бота')}</div>
                <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 1 }}>
                  {t('Your bot is building now — connect a Telegram bot to put it live when it’s ready. No BotFather or tokens.', 'Бот уже собирается — привяжите Telegram-бота, чтобы запустить его, когда будет готов. Без BotFather и токенов.')}
                </div>
              </div>
              {!creatingBot && <TGIcon name="chevRight" size={16} color={T.accent} stroke={2} />}
            </button>
          )}
          {createBotErr && (
            <div style={{ padding: '0 16px 12px', fontFamily: T.font, fontSize: 12.5, color: T.amber, lineHeight: '17px' }}>{createBotErr}</div>
          )}
        </Card>
      )}

      {/* primary action — the Lovable-style feedback loop. While a build is in
          flight the change CTA is paused (the backend rejects changes mid-build)
          and there's nothing to show here — the build card below is the single
          status surface. It returns the moment the bot is live again. */}
      {buildRunning ? null : (() => {
        const label = live ? t('Ask for change', 'Запросить изменение') : latestDeployFailed || testsFailed || buildFailed ? t('Fix with agent', 'Исправить с агентом') : t('Message agent', 'Написать агенту');
        return (
        <button onClick={onOpenChat} style={{
          ...btnReset, width: '100%', height: 54, borderRadius: 15, background: T.accent, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          fontFamily: T.font, fontSize: 17, fontWeight: 600, boxShadow: `0 6px 18px ${hexA(T.accent, 0.32)}`,
        }}>
          <TGIcon name="chat" size={20} color="#fff" stroke={2} /> {label}
        </button>
        );
      })()}

      {/* secondary — Pause/Resume · Retry (two tiles, per the prototype) */}
      {live && botUsername && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onTogglePause} style={{
            ...btnReset, flex: 1, height: 48, borderRadius: 14, background: T.cardBg,
            border: `1px solid ${T.sep}`, boxShadow: T.shadow,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            fontFamily: T.font, fontSize: 15, fontWeight: 600, color: T.text,
          }}>
            <TGIcon name={paused ? 'play' : 'pause'} size={18} color={T.sub} stroke={2} />
            {paused ? t('Resume', 'Возобновить') : t('Pause', 'Пауза')}
          </button>
          <button onClick={onRetry} disabled={retrying} style={{
            ...btnReset, flex: 1, height: 48, borderRadius: 14, background: T.cardBg,
            border: `1px solid ${T.sep}`, boxShadow: T.shadow,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            fontFamily: T.font, fontSize: 15, fontWeight: 600, color: T.text,
            cursor: retrying ? 'default' : 'pointer',
          }}>
            {retrying ? <Spinner color={T.sub} size={17} /> : <TGIcon name="refresh" size={17} color={T.sub} stroke={2} />}
            {t('Retry', 'Повтор')}
          </button>
        </div>
      )}
      {/* Test bot · Show in Discover — one row */}
      {botUsername && live && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => openTgLink(`https://t.me/${botUsername}`)} style={{
            ...btnReset, display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 15px',
            borderRadius: 999, background: T.nestedBg, border: `1px solid ${T.sep}`,
            fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.text,
          }}>
            <TGIcon name="open" size={16} color={T.accent} stroke={2} /> {t('Test bot', 'Тест бота')}
          </button>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 9,
            height: 36, padding: '0 8px 0 13px', borderRadius: 999,
            background: T.nestedBg, border: `1px solid ${T.sep}`,
          }}>
            <TGIcon name="compass" size={15} color={discoverable ? T.accent : T.hint} stroke={2} />
            <span style={{ fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.sub }}>{t('Show in Discover', 'В Каталоге')}</span>
            <Switch T={T} on={discoverable} onClick={onToggleDiscoverable} size="compact" />
          </div>
        </div>
      )}

      {/* task_manager: attention inbox — amber/red badge when something needs the
          owner, else a neutral "all clear" entry point */}
      {isTaskManager && onOpenInbox && (
        blocked.items.length > 0
          ? <BlockedBadge T={T} state={blocked} onClick={onOpenInbox} />
          : (
            <button onClick={onOpenInbox} style={{
              ...btnReset, width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              borderRadius: 13, background: T.cardBg, border: `0.5px solid ${T.sep}`, boxShadow: T.shadow,
            }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: 9,
                background: T.nestedBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <TGIcon name="check" size={15} color={T.green} stroke={2.2} />
              </div>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontFamily: T.font, fontSize: 14, fontWeight: 650, color: T.text }}>{t('Inbox clear', 'Входящие пусты')}</div>
                <div style={{ fontFamily: T.font, fontSize: 12.2, color: T.hint, marginTop: 1 }}>{t('No questions or failed tasks', 'Нет вопросов и неудавшихся задач')}</div>
              </div>
              <TGIcon name="chevRight" size={16} color={T.hint} stroke={2} />
            </button>
          )
      )}

      {/* Build progress — for whole_bot the build card IS the single status
          surface (status word + bar + % + iteration timeline), so the Plan→Build→
          Test→Live stepper is dropped to avoid stacking three redundant status
          indicators. The stepper stays for task_manager/phase bots, which have no
          build card. */}
      {(!wholeBot || (buildRunning && bp)) && !awaitingBotConnect && (
        <div>
          <SectionLabel T={T}>{t('Build progress', 'Прогресс сборки')}</SectionLabel>
          {wholeBot && bp
            ? <WholeBotBuildCard T={T} bp={bp} />
            : <BuildProgress T={T} steps={progressSteps} />}
        </div>
      )}

      {/* shipping a change lives in the chat (the "Ask for change" button above),
          same as task_manager bots — no separate composer here. A live chat
          message routes to the build/feedback flow and the bot rebuilds. */}

      {/* stats — one compact 3-up row (build progress · unique users · last
          update). Hidden while a whole_bot is building (the build card above
          carries the live status). */}
      {/* Usage — live summary of who's using the bot (degrades gracefully) */}
      {!wholeBotBuilding && (() => {
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
        // ru plural: 1 релиз · 2–4 релиза · 5+ релизов (with 11–14 exception)
        const releasesWord = (n: number) => lang === 'ru'
          ? (n % 10 === 1 && n % 100 !== 11 ? 'релиз' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'релиза' : 'релизов')
          : (n === 1 ? 'release' : 'releases');
        const newValue = usersNew != null ? `+${human(usersNew)}` : (delta != null ? `${delta > 0 ? '+' : ''}${delta}%` : '—');
        const newUp = usersNew != null ? usersNew > 0 : (delta != null ? delta > 0 : false);
        return (
        <div>
          <SectionLabel T={T}>{t('Usage', 'Использование')}</SectionLabel>
          <Card T={T} pad={16}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {todayCount != null ? (
                  <>
                    <div style={{ fontFamily: T.font, fontSize: 13, color: T.sub }}>
                      {isPeople ? t('Today your bot answered', 'Сегодня бот ответил') : t('Messages today', 'Сообщений сегодня')}
                    </div>
                    <div style={{ fontFamily: T.font, fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: -0.6, marginTop: 2 }}>
                      {human(todayCount)}{isPeople && <span style={{ fontSize: 15, fontWeight: 600, color: T.sub }}> {peopleWord(todayCount)}</span>}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontFamily: T.font, fontSize: 15, fontWeight: 700, color: T.text }}>{live ? t('Your bot is live', 'Бот в эфире') : t('Getting ready', 'Готовимся')}</div>
                    <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 3, lineHeight: '17px' }}>{t('Usage shows up here as people start chatting with it.', 'Статистика появится, как только им начнут пользоваться.')}</div>
                  </>
                )}
              </div>
              {users7d && <Sparkline values={users7d} color={T.green} />}
            </div>
            {hasStats && (
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <UsageTile T={T} label={t('Total users', 'Всего')} value={human(usersTotal ?? undefined)} />
                <UsageTile T={T} label={t('New · 7d', 'Новых · 7д')} value={newValue} tone={newUp ? T.green : undefined} up={newUp} />
                <UsageTile T={T} label={t('Online now', 'Онлайн')} value={activeNow != null ? human(activeNow) : '—'} dot={activeNow ? T.green : undefined} />
              </div>
            )}
            <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 14 }}>
              {live ? t('Live', 'В сети') : t('In progress', 'В процессе')}
              {latestDeploy?.deployed_at ? ` · ${t('last update', 'обновлено')} ${relTime(latestDeploy.deployed_at, lang)}` : ''}
              {deploys.length ? ` · ${deploys.length} ${releasesWord(deploys.length)}` : ''}
            </div>
          </Card>
        </div>
        );
      })()}

      {/* The plan — the readable "what we understood" spec (in-app viewer) */}
      {(onOpenPlan || blueprintUrl) && (
        <button onClick={() => { if (onOpenPlan) onOpenPlan(); else if (blueprintUrl) openExternal(blueprintUrl); }} style={{
          ...btnReset, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13,
          padding: 14, borderRadius: 16, background: T.cardBg, border: `1px solid ${T.sep}`, boxShadow: T.shadow,
        }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: T.sage, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <TGIcon name="check" size={19} color="#2f8f6f" stroke={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.font, fontSize: 15, fontWeight: 700, color: T.text }}>{t('The plan', 'План')}</div>
            <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 1 }}>{t('what we understood from your idea', 'что мы поняли из вашей идеи')}</div>
          </div>
          <TGIcon name="chevRight" size={18} color={T.hint} stroke={2} />
        </button>
      )}

      {/* Bot settings — the owner-supplied keys. The missing count is fetched
          once (not polled): without it nothing tells the owner a key the bot
          needs is absent, and a silently half-working bot is the failure this
          screen exists to prevent. */}
      {onOpenEnv && envSummary && envSummary.total > 0 && (
        <button onClick={onOpenEnv} style={{
          ...btnReset, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13,
          padding: 14, borderRadius: 16, background: T.cardBg, border: `1px solid ${T.sep}`, boxShadow: T.shadow,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 11, background: envSummary.missing > 0 ? T.goldSoft : T.nestedBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <TGIcon name="lock" size={19} color={envSummary.missing > 0 ? T.gold : T.sub} stroke={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.font, fontSize: 15, fontWeight: 700, color: T.text }}>{t('Settings', 'Настройки')}</div>
            <div style={{ fontFamily: T.font, fontSize: 12.5, color: envSummary.missing > 0 ? T.gold : T.hint, marginTop: 1 }}>
              {envSummary.missing > 0
                ? t(`${envSummary.missing} key${envSummary.missing > 1 ? 's' : ''} the bot still needs`,
                    `не задано ключей: ${envSummary.missing}`)
                : t('keys the bot uses', 'ключи, которые использует бот')}
            </div>
          </div>
          <TGIcon name="chevRight" size={18} color={T.hint} stroke={2} />
        </button>
      )}

      {/* blueprint is reachable via the "Spec" action under the message button */}

      {/* task_manager: owner-safe retry deploy control. */}
      {isTaskManager && (
        <TaskManagerControls T={T} projectId={bot.id} live={live}
          autoMergeEnabled={detail?.auto_merge_enabled} hasBot={!!botRow} specOnly />
      )}

      {/* tasks — compact: phase stepper + one-line rows, expandable.
          Hidden for whole_bot (no tasks — the build card above shows progress). */}
      {!wholeBot && (
      <div>
        <SectionLabel T={T} right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {total > 0 && <span style={{ fontFamily: T.font, fontSize: 12, color: T.hint }}>{done}/{total} {t('done', 'готово')}</span>}
            <button onClick={onOpenBoard} style={{ ...btnReset, display: 'inline-flex', alignItems: 'center', gap: 1, fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.accent }}>
              {t('Board', 'Доска')} <TGIcon name="chevRight" size={15} color={T.accent} stroke={2} />
            </button>
          </div>
        }>{t('Tasks', 'Задачи')}</SectionLabel>
        <Card T={T} pad={0}>
          {/* phases are a phase-pipeline concept — task_manager is epics + tasks, no phase strip */}
          {dag?.current_phase && !isTaskManager && <PhaseStrip T={T} dag={dag} lang={lang} />}
          {tasks.length === 0 && (
            decomposing ? (
              <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Spinner color={T.accent} size={15} />
                <span style={{ fontFamily: T.font, fontSize: 13.5, color: T.sub, lineHeight: '18px' }}>
                  {t("Decomposing your idea into tasks — this can take a minute. They'll stream in here as they're built.", 'Разбиваем вашу идею на задачи — это может занять минуту. Они появятся здесь по мере готовности.')}
                </span>
              </div>
            ) : (
              <div style={{ padding: 14, fontFamily: T.font, fontSize: 13.5, color: T.hint }}>
                {t('Build starting — your plan and tasks will appear here in a moment.', 'Сборка начинается — ваш план и задачи скоро появятся здесь.')}
              </div>
            )
          )}
          {orderTasks(tasks).slice(0, showAllTasks ? undefined : 4).map((t, i) => {
            const tone = TASK_DOT[t.status] || 'hint';
            const color = tone === 'green' ? T.green : tone === 'accent' ? T.accent : T.hint;
            const slug = t.slug || t.id;
            const open = expandedTask === slug;
            const detail = taskDetails[slug];
            return (
              <div key={slug} style={{ borderTop: i || (dag?.current_phase && !isTaskManager) ? `0.5px solid ${T.sep}` : 'none' }}>
                <button onClick={() => toggleTask(slug)} style={{
                  ...btnReset, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px', opacity: !open && t.status === 'done' ? 0.72 : 1,
                }}>
                  {t.status === 'done'
                    ? <TGIcon name="check" size={15} color={T.green} stroke={2.6} />
                    : <Dot color={color} size={7} pulse={t.status === 'in_progress'} />}
                  <span style={{
                    flex: 1, fontFamily: T.font, fontSize: 13.5, color: T.text, lineHeight: '18px',
                    ...(open ? {} : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
                  }}>{open ? t.title : t.title.replace(/^Fix:\s*/i, '')}</span>
                  <Pill T={T} tone={t.status === 'done' ? 'neutral' : 'accent'} style={{ height: 19, fontSize: 10, padding: '0 7px' }}>
                    {t.node_kind || t.difficulty || tr(lang, 'task', 'задача')}
                  </Pill>
                  <TGIcon name="chevDown" size={14} color={T.hint} stroke={2} />
                </button>

                {open && (
                  <div style={{ padding: '0 14px 13px 39px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {/* meta line */}
                    <div style={{ fontFamily: T.font, fontSize: 12, color: T.hint }}>
                      {[t.phase && (lang === 'ru' ? `фаза ${t.phase}` : `${t.phase} phase`), t.status,
                        (t.claimers_count || 0) > 0 && (lang === 'ru' ? `${t.claimers_count} агент(ов) в работе` : `${t.claimers_count} agent${t.claimers_count! > 1 ? 's' : ''} on it`),
                        t.depends_on?.length ? (lang === 'ru' ? `зависит от ${t.depends_on.length}` : `depends on ${t.depends_on.length}`) : null,
                      ].filter(Boolean).join(' · ')}
                    </div>

                    {/* full description */}
                    {detail === 'loading' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Spinner color={T.hint} size={13} />
                        <span style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint }}>{tr(lang, 'Loading description…', 'Загрузка описания…')}</span>
                      </div>
                    )}
                    {detail && detail !== 'loading' && detail !== 'none' && detail.body_md && (
                      <div style={{
                        fontFamily: T.font, fontSize: 13, color: T.sub, lineHeight: '19px',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto',
                      }}>{detail.body_md}</div>
                    )}
                    {(detail === 'none' || (typeof detail === 'object' && !detail.body_md)) && !t.claim_reason && (
                      <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint }}>{tr(lang, 'No further details for this task.', 'Больше деталей по этой задаче нет.')}</div>
                    )}
                    {t.claim_reason && t.status !== 'done' && (
                      <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.amber, lineHeight: '17px' }}>{t.claim_reason}</div>
                    )}

                    {/* links */}
                    {(() => {
                      const d = detail && detail !== 'loading' && detail !== 'none' ? detail : null;
                      const pr = t.pr_url || d?.pr_url;
                      const issue = t.github_issue_url || d?.github_issue_url;
                      if (!pr && !issue) return null;
                      return (
                        <div style={{ display: 'flex', gap: 8 }}>
                          {pr && <LinkChip T={T} label={tr(lang, 'View PR', 'Открыть PR')} onClick={() => openExternal(pr)} />}
                          {issue && <LinkChip T={T} label={tr(lang, 'GitHub issue', 'GitHub-задача')} onClick={() => openExternal(issue)} />}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
          {isTaskManager ? (
            addingTask ? (
              <div style={{ borderTop: `0.5px solid ${T.sep}`, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <textarea ref={addTaskRef} autoFocus value={taskDraft} onChange={e => setTaskDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitNewTask(); } }}
                    placeholder={t('Describe a task to add…', 'Опишите задачу для добавления…')} rows={1}
                    style={{ flex: 1, resize: 'none', maxHeight: 200, minHeight: 38, overflowY: 'auto', padding: '9px 12px', borderRadius: 12, background: T.inputBg, border: `0.5px solid ${T.sep}`, color: T.text, fontFamily: T.font, fontSize: 14, lineHeight: '19px', outline: 'none', boxSizing: 'border-box' }} />
                  <button onClick={() => void submitNewTask()} style={{ ...btnReset, width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: taskDraft.trim() && !addBusy ? T.accent : T.nestedBg }}>
                    {addBusy ? <Spinner color="#fff" size={16} /> : <TGIcon name="send" size={17} color={taskDraft.trim() ? '#fff' : T.hint} stroke={2} />}
                  </button>
                </div>
                {addErr && <span style={{ fontFamily: T.font, fontSize: 12, color: T.amber, lineHeight: '16px' }}>{addErr}</span>}
                <button onClick={() => { setAddingTask(false); setTaskDraft(''); setAddErr(null); }} style={{ ...btnReset, alignSelf: 'flex-start', fontFamily: T.font, fontSize: 12.5, fontWeight: 600, color: T.hint }}>{t('Cancel', 'Отмена')}</button>
              </div>
            ) : (
              <button onClick={() => setAddingTask(true)} style={{
                ...btnReset, width: '100%', padding: '10px 14px', borderTop: `0.5px solid ${T.sep}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.accent,
              }}>
                <TGIcon name="plus" size={15} color={T.accent} stroke={2.2} /> {t('Add new task', 'Добавить задачу')}
              </button>
            )
          ) : (
            tasks.length > 4 && (
              <button onClick={() => setShowAllTasks(v => !v)} style={{
                ...btnReset, width: '100%', padding: '10px 14px', borderTop: `0.5px solid ${T.sep}`,
                fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.accent, textAlign: 'center',
              }}>
                {showAllTasks ? t('Show less', 'Свернуть') : t(`Show all ${tasks.length} tasks`, `Показать все задачи (${tasks.length})`)}
              </button>
            )
          )}
        </Card>
      </div>
      )}

      {/* feedback now lives in the chat: once LIVE, a chat message routes to the
          feedback analyzer and the new tasks come back as tool-call messages
          (agent conversation behavior) — no separate composer here */}

      {/* delete — two-step inline confirm; the Telegram bot itself is the
          owner's and must be removed via @BotFather separately */}
      {!confirmDelete ? (
        <button onClick={() => setConfirmDelete(true)} style={{
          ...btnReset, alignSelf: 'center', marginTop: 4, padding: '9px 16px', borderRadius: 999,
          color: T.red, fontFamily: T.font, fontSize: 13.5, fontWeight: 600,
        }}>
          {t('Delete this bot', 'Удалить этого бота')}
        </button>
      ) : (
        <Card T={T} pad={14} style={{ border: `1px solid ${T.redSoft}` }}>
          <div style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 600, color: T.text }}>
            {t('Delete', 'Удалить')} {bot.name}?
          </div>
          <div style={{ fontFamily: T.font, fontSize: 13, color: T.sub, lineHeight: '18px', marginTop: 5 }}>
            {t('Removes this project from your AgentBot list.', 'Удаляет этот проект из вашего списка AgentBot.')}
          </div>
          {botUsername && (
          <div style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 10, padding: '9px 11px',
            borderRadius: 10, background: T.nestedBg,
          }}>
            <TGIcon name="shield" size={15} color={T.amber} stroke={1.9} />
            <span style={{ fontFamily: T.font, fontSize: 12.5, color: T.sub, lineHeight: '17px' }}>
              {lang === 'ru' ? <>
                Telegram-бот @{botUsername} продолжит работать — чтобы удалить его полностью, откройте{' '}
                <span onClick={() => openTgLink('https://t.me/BotFather')} style={{ color: T.accent, fontWeight: 600, cursor: 'pointer' }}>@BotFather</span>
                {' '}и отправьте <span style={{ fontFamily: T.mono }}>/deletebot</span>.
              </> : <>
                The Telegram bot @{botUsername} keeps running — to delete it completely, open{' '}
                <span onClick={() => openTgLink('https://t.me/BotFather')} style={{ color: T.accent, fontWeight: 600, cursor: 'pointer' }}>@BotFather</span>
                {' '}and send <span style={{ fontFamily: T.mono }}>/deletebot</span>.
              </>}
            </span>
          </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button onClick={() => setConfirmDelete(false)} style={{
              ...btnReset, flex: 1, height: 42, borderRadius: 11,
              background: T.nestedBg,
              color: T.text, fontFamily: T.font, fontSize: 14, fontWeight: 600,
            }}>
              {t('Cancel', 'Отмена')}
            </button>
            <button onClick={onDelete} style={{
              ...btnReset, flex: 1, height: 42, borderRadius: 11,
              background: T.red, color: '#fff', fontFamily: T.font, fontSize: 14, fontWeight: 600,
            }}>
              {t('Delete', 'Удалить')}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── task_manager owner controls (auto-merge · retry deploy) ──
// Only rendered for task_manager bots. Reuses the file's Card/Switch
// + the client helpers; all owner-only POST/PATCH, optimistic with verbatim
// error text (409/503 are actionable — surfaced as-is).
function TaskManagerControls({ T, projectId, live, autoMergeEnabled, hasBot, specOnly }: {
  T: Theme; projectId: string; live: boolean;
  autoMergeEnabled?: boolean; hasBot: boolean; specOnly?: boolean;
}) {
  const t = useT();
  // Auto-merge (§6.6): seed from the project DTO; optimistic flip, revert on error.
  const [amOn, setAmOn] = useState(autoMergeEnabled ?? true);
  const [amBusy, setAmBusy] = useState(false);
  const [amError, setAmError] = useState<string | null>(null);
  useEffect(() => { if (autoMergeEnabled !== undefined) setAmOn(autoMergeEnabled); }, [autoMergeEnabled]);
  const toggleAutoMerge = async () => {
    if (amBusy) return;
    const next = !amOn;
    setAmOn(next); setAmBusy(true); setAmError(null);
    try { await setAutoMerge(projectId, next); }
    catch (e) { setAmOn(!next); setAmError(e instanceof ApiError ? e.message : t('network error — try again', 'ошибка сети — попробуйте снова')); }
    finally { setAmBusy(false); }
  };

  // Retry deploy (§6.7): async 202 → optimistic "started" line; 409/503 verbatim.
  // The button stays tappable while pending so a stalled/failed deploy (narrated
  // into chat, never reaching `live`) is always retriable. Cleared once live.
  const [dpBusy, setDpBusy] = useState(false);
  const [dpPending, setDpPending] = useState(false);
  const [dpError, setDpError] = useState<string | null>(null);
  useEffect(() => { if (live) setDpPending(false); }, [live]);
  const onRetryDeploy = async () => {
    if (dpBusy) return;
    setDpBusy(true); setDpError(null);
    try { await retryDeploy(projectId); setDpPending(true); }
    catch (e) {
      setDpPending(false);
      setDpError(e instanceof ApiError ? (e.warning || `${e.message}${e.details ? ` — ${e.details}` : ''}`) : t('network error — try again', 'ошибка сети — попробуйте снова'));
    } finally { setDpBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* retry deploy stays owner-facing; auto-merge is reserved for full controls */}
      {specOnly && hasBot && !live && (
        <Card T={T} pad={0}>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <button onClick={() => void onRetryDeploy()} disabled={dpBusy} style={{
              ...btnReset, width: '100%', height: 42, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              background: T.accentSoft, color: T.accent, fontFamily: T.font, fontSize: 14, fontWeight: 600,
            }}>
              {dpBusy ? <Spinner color={T.accent} size={15} /> : <TGIcon name="refresh" size={16} color={T.accent} stroke={2} />}
              {t('Retry deploy', 'Повторить деплой')}
            </button>
            {dpPending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.font, fontSize: 12.5, color: T.accent, lineHeight: '17px' }}>
                <Spinner color={T.accent} size={13} /> {t('Deploy started - watching for it to come online...', 'Деплой запущен — ждём, когда бот выйдет в онлайн...')}
              </div>
            )}
            {dpError && (
              <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.red, lineHeight: '17px' }}>{dpError}</div>
            )}
          </div>
        </Card>
      )}

      {/* auto-merge + full deploy controls — hidden unless full controls are requested */}
      {!specOnly && (
      <Card T={T} pad={0}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.font, fontSize: 14.5, fontWeight: 600, color: T.text }}>{t('Auto-merge PRs', 'Авто-мёрж PR')}</div>
            <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.hint, marginTop: 1, lineHeight: '16px' }}>
              {amOn ? t('Approved PRs merge automatically.', 'Одобренные PR мёржатся автоматически.') : t('Approved PRs stay open — merge them on GitHub.', 'Одобренные PR остаются открытыми — мёржите их на GitHub.')}
            </div>
          </div>
          <Switch T={T} on={amOn} busy={amBusy} onClick={() => void toggleAutoMerge()} />
        </div>
        {amError && (
          <div style={{ padding: '0 14px 11px', fontFamily: T.font, fontSize: 12, color: T.amber, lineHeight: '16px' }}>{amError}</div>
        )}

        {hasBot && (
          <div style={{ borderTop: `0.5px solid ${T.sep}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <button onClick={() => void onRetryDeploy()} disabled={dpBusy} style={{
              ...btnReset, width: '100%', height: 42, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              background: T.accentSoft, color: T.accent, fontFamily: T.font, fontSize: 14, fontWeight: 600,
            }}>
              {dpBusy ? <Spinner color={T.accent} size={15} /> : <TGIcon name="refresh" size={16} color={T.accent} stroke={2} />}
              {live ? t('Redeploy bot', 'Передеплоить бота') : t('Retry deploy', 'Повторить деплой')}
            </button>
            {dpPending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.font, fontSize: 12.5, color: T.accent, lineHeight: '17px' }}>
                <Spinner color={T.accent} size={13} /> {t('Deploy started — watching for it to come online…', 'Деплой запущен — ждём, когда бот выйдет в онлайн…')}
              </div>
            )}
            {dpError && (
              <div style={{ fontFamily: T.font, fontSize: 12.5, color: T.red, lineHeight: '17px' }}>{dpError}</div>
            )}
          </div>
        )}
      </Card>
      )}
    </div>
  );
}

function Switch({ T, on, onClick, busy, size = 'regular' }: {
  T: Theme; on: boolean; onClick: () => void; busy?: boolean; size?: 'regular' | 'compact';
}) {
  const compact = size === 'compact';
  const trackW = compact ? 36 : 46;
  const trackH = compact ? 22 : 28;
  const knob = compact ? 16 : 22;
  const inset = compact ? 3 : 3;
  return (
    <button onClick={busy ? undefined : onClick} aria-pressed={on} style={{
      ...btnReset, width: trackW, height: trackH, borderRadius: 999, flexShrink: 0, position: 'relative',
      background: on ? T.accent : hexA(T.text, 0.16),
      transition: 'background .2s', opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer',
    }}>
      <span style={{
        position: 'absolute', top: inset, left: on ? trackW - knob - inset : inset, width: knob, height: knob, borderRadius: 999,
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left .2s',
      }} />
    </button>
  );
}

function LinkChip({ T, label, onClick }: { T: Theme; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      ...btnReset, display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px',
      borderRadius: 9, background: T.accentSoft, color: T.accent,
      fontFamily: T.font, fontSize: 12.5, fontWeight: 600,
    }}>
      <TGIcon name="open" size={13} color={T.accent} stroke={2} />
      {label}
    </button>
  );
}
