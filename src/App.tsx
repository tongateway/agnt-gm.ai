// App.tsx — pipeline state machine + Telegram chrome wiring.
// Flow: prompt → clarify (owner↔AI chat on a draft project) → review/create
//       bot → cloud build. Agent setup remains available from the bot overview
//       as an advanced path, but the default creator path ships with zero setup.
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { tgTheme, Theme } from './theme';
import {
  telegramColorScheme, onThemeChanged, syncChrome, telegramInitData, telegramUser,
  insideTelegram, backButtonOnClick, backButtonVisible, haptic,
} from './telegram';
import {
  ApiError, Project,
  startChat, getProject, getProjectPipeline, publishProject, deleteProject,
  BuildMode, setBuildModeApi,
  listProjectsByAgent, authTelegram, setAuthToken,
  getProjectBot, BotInitiate,
  setBotPaused,
  listDiscoverBots,
  setDiscoverable,
} from './api/client';
import { useChat } from './chat/Chat';
import { pendingEnvAsk, EnvAsk } from './chat/env';
import { useT } from './i18n';
import { TGHeader, MainButton, TabBar, Tab, Spinner, ConfirmSheet } from './ui';
import { PromptScreen } from './screens/Prompt';
import { ClarifyScreen, GenPhase } from './screens/Clarify';
import { AgentScreen } from './screens/Agent';
import { MyBotsList, BotChat, Composer, MyBot, botFromProject } from './manage/MyBots';
import { DiscoveryPage, DiscoverBot, discoverBotFromProject } from './manage/Discovery';

// Heavy manage-tab detail screens + overlays are reached only via navigation —
// load them on demand (code-split) so they stay out of the initial bundle and
// the mini-app opens faster. The build flow (prompt→clarify→spec→agent) and the
// My Bots / Discover lists stay eager: they're the first paint and export
// helpers used in App's data layer.
const BotEnv = lazy(() => import('./manage/BotEnv').then(m => ({ default: m.BotEnv })));
const BotOverview = lazy(() => import('./manage/BotOverview').then(m => ({ default: m.BotOverview })));
const DagBoard = lazy(() => import('./manage/DagBoard').then(m => ({ default: m.DagBoard })));
const BoardView = lazy(() => import('./manage/TaskManagerBoard').then(m => ({ default: m.BoardView })));
const TaskManagerInbox = lazy(() => import('./manage/TaskManagerInbox').then(m => ({ default: m.TaskManagerInbox })));
const TaskDetail = lazy(() => import('./manage/TaskDetail').then(m => ({ default: m.TaskDetail })));
const ActivityPage = lazy(() => import('./manage/Activity').then(m => ({ default: m.ActivityPage })));
const BlueprintScreen = lazy(() => import('./manage/Blueprint').then(m => ({ default: m.BlueprintScreen })));

const STEPS = ['prompt', 'clarify', 'agent'] as const;
type StepId = typeof STEPS[number];

// [en, ru] pairs — translated at the single render site with t(...STAGE_SUB[id]).
const STAGE_SUB: Record<StepId, [string, string]> = {
  prompt: ['New bot', 'Новый бот'], clarify: ['Tell me more', 'Расскажите подробнее'],
  agent: ['Advanced builder', 'Продвинутый сборщик'],
};

const THEME_KEY = 'agentbot-theme';
const PIPELINE_KEY = 'agentbot-pipeline';
const HIDDEN_KEY = 'agentbot-hidden'; // deleted-bot ids (local fallback until the API has DELETE)
const MODE_KEY = 'agentbot-buildmode'; // per-project build mode (until the API carries build_mode)

function loadModes(): Record<string, BuildMode> {
  try { return JSON.parse(localStorage.getItem(MODE_KEY) || '{}'); } catch { return {}; }
}
function modeFor(p: { id: string; build_mode?: string } | null): BuildMode {
  if (p?.build_mode) return p.build_mode === 'local_agent' ? 'local' : 'platform';
  return (p && loadModes()[p.id]) || 'platform';
}

function loadHidden(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[]); }
  catch { return new Set(); }
}

const PAUSED_KEY = 'agentbot-paused'; // optimistic pause state per bot (until the API carries `paused`)
function loadPaused(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PAUSED_KEY) || '[]') as string[]); }
  catch { return new Set(); }
}

// Pinned bots — the owner's own ordering, kept client-side (there is no server
// field for it). Stored oldest-pin-first; the list renders pinned bots on top
// in the order they were pinned, newest pin highest.
const PINNED_KEY = 'agentbot-pinned';
function loadPinned(): string[] {
  try { const v = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'); return Array.isArray(v) ? v as string[] : []; }
  catch { return []; }
}

const DISCOVER_OPTOUT_KEY = 'agentbot-discover-optout'; // bots the owner hid from Discovery (until the API carries `discoverable`)
function loadDiscoverOptOut(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISCOVER_OPTOUT_KEY) || '[]') as string[]); }
  catch { return new Set(); }
}

// pipeline snapshot persisted across mini-app closes, keyed to the project
interface PipelineSnap {
  projectId: string;
  step: StepId;
  idea: string;
  botCreated: boolean;
  botUsername: string | null;
  connected: boolean;
  agentName: string | null;
}

function loadSnap(): PipelineSnap | null {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY);
    return raw ? JSON.parse(raw) as PipelineSnap : null;
  } catch { return null; }
}

// auto-detected mode (Telegram colorScheme → OS preference), with a manual
// override toggled from the prompt screen. The override remembers which auto
// scheme it was made AGAINST — if Telegram's scheme changes (or the app opens
// on a device with the other scheme), the override is discarded so the app
// never sits light inside a dark Telegram (or vice versa).
interface ThemeOverride { mode: 'light' | 'dark'; base: 'light' | 'dark' }

function useColorMode(): ['light' | 'dark', () => void] {
  const get = (): 'light' | 'dark' =>
    telegramColorScheme()
    ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [auto, setAuto] = useState<'light' | 'dark'>(get);
  const [override, setOverride] = useState<ThemeOverride | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(THEME_KEY) || 'null');
      return v && (v.mode === 'light' || v.mode === 'dark') ? v as ThemeOverride : null;
    } catch { return null; }
  });
  useEffect(() => {
    const offTg = onThemeChanged(() => setAuto(get()));
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onMq = () => setAuto(get());
    mq?.addEventListener?.('change', onMq);
    return () => { offTg(); mq?.removeEventListener?.('change', onMq); };
  }, []);

  const valid = override !== null && override.base === auto;
  const mode = valid ? override!.mode : auto;
  useEffect(() => {
    // stale override (made against the other scheme) — drop it
    if (override && override.base !== auto) {
      setOverride(null);
      localStorage.removeItem(THEME_KEY);
    }
  }, [auto, override]);

  const toggle = () => {
    const next: ThemeOverride = { mode: mode === 'dark' ? 'light' : 'dark', base: auto };
    if (next.mode === auto) {
      // toggled back to what Telegram says anyway — no override needed
      setOverride(null);
      localStorage.removeItem(THEME_KEY);
    } else {
      setOverride(next);
      localStorage.setItem(THEME_KEY, JSON.stringify(next));
    }
  };
  return [mode, toggle];
}

export default function App() {
  const t = useT();
  const [mode, toggleTheme] = useColorMode();
  const T: Theme = tgTheme(mode);
  useEffect(() => { syncChrome(T.headerBg, T.pageBg); document.body.style.background = T.pageBg; }, [mode]);

  // ── owner identity: silent Telegram auth ──
  // POST /auth/telegram with WebApp initData → JWT; the owner is derived from
  // the session on every API call. No wallet needed — bind one later to fund.
  const [tgAgentId, setTgAgentId] = useState<string | null>(null);
  const [tgAuthed, setTgAuthed] = useState(false);
  const tryTgAuth = async (): Promise<boolean> => {
    const initData = telegramInitData();
    if (!initData) return false;
    try {
      const r = await authTelegram(initData);
      const token = r.jwt || r.token;
      if (!token) return false;
      setAuthToken(token);
      setTgAgentId(r.agent?.id ?? null);
      setTgAuthed(true);
      return true;
    } catch {
      return false;
    }
  };
  useEffect(() => { void tryTgAuth(); }, []);

  // ── pipeline state ──
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [tab, setTab] = useState<Tab>('build');
  const [idea, setIdea] = useState('');
  const [changed, setChanged] = useState(false);
  const [starting, setStarting] = useState(false); // POST /builder/chat in flight
  const [startError, setStartError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState(''); // clarify-chat composer

  // real platform state
  const [project, setProject] = useState<Project | null>(null);
  const [gen, setGen] = useState<GenPhase>('idle');
  const [genError, setGenError] = useState<string | null>(null);
  const [botCreated, setBotCreated] = useState(false);
  const [botInit, setBotInit] = useState<BotInitiate | null>(null); // deep link issued, waiting for Telegram
  const [botUsername, setBotUsername] = useState<string | null>(null); // the real managed bot
  const [connected, setConnected] = useState(false);
  const [buildMode, setBuildMode] = useState<BuildMode>('platform');
  const [agentName, setAgentName] = useState<string | null>(null);
  const [building, setBuilding] = useState(false); // "Start building" → publish in flight
  const [buildError, setBuildError] = useState<string | null>(null);

  // My Bots tab
  const [myBots, setMyBots] = useState<MyBot[]>([]);
  const [botsLoading, setBotsLoading] = useState(false);
  const [manageBot, setManageBot] = useState<string | null>(null);
  const [manageView, setManageView] = useState<'overview' | 'board' | 'taskboard' | 'inbox' | 'chat' | 'activity' | 'plan' | 'env'>('overview');
  const [detailTask, setDetailTask] = useState<string | null>(null); // task_manager TaskDetail overlay (slug)
  const [hiddenBots, setHiddenBots] = useState<Set<string>>(loadHidden);
  const [pausedBots, setPausedBots] = useState<Set<string>>(loadPaused);
  const [discoverOptOut, setDiscoverOptOut] = useState<Set<string>>(loadDiscoverOptOut);
  const [pinnedBots, setPinnedBots] = useState<string[]>(loadPinned);
  // A swipe armed a pin/delete and is waiting on the confirm sheet. null = shut.
  const [swipeConfirm, setSwipeConfirm] = useState<{ kind: 'delete' | 'pin'; bot: MyBot } | null>(null);
  const lastSwipeConfirm = useRef(swipeConfirm); // keeps the copy stable while the sheet slides out
  const [draft, setDraft] = useState('');

  // Discover tab — server-side feed of live bots (everyone's). Empty until the
  // listing endpoint ships (no client-side fallback — can't list others locally).
  const [discoverBots, setDiscoverBots] = useState<DiscoverBot[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);

  const id: StepId = STEPS[step];
  const cancelPoll = useRef<() => void>(() => {});

  const goTo = (i: number, d = 1) => { setDir(d); setStep(i); };
  const back = () => goTo(Math.max(0, step - 1), -1);

  // a stale "couldn't start the build" error shouldn't linger when you leave
  // (or re-enter) the review/build step
  useEffect(() => { if (id !== 'agent') setBuildError(null); }, [id]);

  // close the TaskDetail overlay whenever the open bot or view changes, so a
  // stale slug never bleeds across bots/screens
  useEffect(() => { setDetailTask(null); }, [manageBot, manageView]);

  // ── the clarify chat (real, on the draft project) ──
  const clarifyChat = useChat(project?.id ?? null, tab === 'build' && id === 'clarify', true);
  // active across all bot views (the overview reads its activity feed), but only
  // FAST-polls when the chat is the focused view — elsewhere it ticks slowly.
  const manageChat = useChat(manageBot, tab === 'manage' && !!manageBot, manageView === 'chat');
  // An open env question turns the composer into a masked field: the next
  // message is one of the bot's settings, not a sentence to the assistant.
  const clarifyEnvAsk = pendingEnvAsk(clarifyChat.messages);
  const manageEnvAsk = pendingEnvAsk(manageChat.messages);
  // Name the key in the placeholder — with the field masked, that label is the
  // only thing telling the owner WHICH setting they're pasting.
  const envPlaceholder = (ask: EnvAsk) => (ask.key
    ? t(`Paste ${ask.key}…`, `Вставьте ${ask.key}…`)
    : t('Paste the value…', 'Вставьте значение…'));

  // "Start generating": create the draft project from the idea and enter the chat
  const startChatFlow = async () => {
    if (starting || !idea.trim()) return;
    if (!tgAuthed && !(await tryTgAuth())) return; // auth raced the tap — retry once
    setStarting(true); setStartError(null);
    try {
      const r = await startChat(idea.trim());
      resetPipeline();
      const d = await getProject(r.project_id).catch(() => null);
      setProject(d?.project ?? ({ id: r.project_id, slug: '', name: 'New bot', status: r.status || 'draft' } as Project));
      setGen('generating');
      setBuildMode('platform');
      pollPlan(r.project_id);
      goTo(STEPS.indexOf('clarify'), 1);
    } catch (e) {
      setStartError(e instanceof ApiError ? `${e.message}${e.details ? ` (${e.details})` : ''}` : t('network error', 'ошибка сети'));
    } finally {
      setStarting(false);
    }
  };

  // task_manager handoff (§7a): once the chat-created project leaves 'draft'
  // decomposition has begun. Unlike the phase pipeline (spec → agent → publish),
  // a task_manager project auto-decomposes — so drop the owner onto the bot's
  // OVERVIEW, which shows the create-your-bot step and a "building" loader while
  // the DAG decomposes in the background (the board is one tap away).
  // drop the owner onto the bot's OVERVIEW page. The overview drives the rest of
  // onboarding (assign a builder agent → create the bot → build) — there is no
  // separate spec/review screen anymore. Used both for the task_manager handoff
  // and the whole_bot/phase path once the idea (plan) is ready.
  const handoffToOverview = (p: Project, isTaskManager = false) => {
    cancelPoll.current();
    const base = botFromProject(p);
    const bot = isTaskManager ? { ...base, isTaskManager: true } : base; // verdict known — overview renders the tm surface immediately
    setMyBots(prev => prev.some(b => b.id === p.id) ? prev : [bot, ...prev]);
    resetPipeline();
    localStorage.removeItem(PIPELINE_KEY);
    setIdea(''); setChanged(false); setStep(0);
    setManageBot(p.id); setManageView('overview'); setDir(1); setTab('manage');
    void refreshMyBots(p.id);
  };
  const handoffTaskManager = (p: Project) => handoffToOverview(p, true);

  // status poll: draft (chatting) → validating (plan-gen) → ready_to_publish.
  // No timeout while drafting — the owner chats at their own pace.
  const pollPlan = (projectId: string) => {
    let cancelled = false;
    cancelPoll.current = () => { cancelled = true; };
    let genSince: number | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const d = await getProject(projectId);
        if (cancelled) return;
        setProject(d.project);
        const st = d.project.status;
        // task_manager vs phase: once status leaves 'draft', discriminate by
        // build_pipeline (when present), else status 'generating' (the
        // task_manager-only decomposing state — phase uses validating→
        // ready_to_publish), else probe /dag for node_kind. Probe every tick —
        // the DAG may still be empty the instant decomposition starts; phase
        // projects keep falling through unchanged below. This MUST precede both
        // the live→'ready' branch (so a populated task_manager DAG hands off
        // before the phase publish UI shows) and the 4-min plan-gen timeout (so
        // a slow decomposition isn't killed before the board handoff fires).
        if (st !== 'draft') {
          const tm = d.project.build_pipeline
            ? d.project.build_pipeline === 'task_manager'
            : st === 'generating' || (await getProjectPipeline(projectId)) === 'task_manager';
          if (cancelled) return;
          if (tm) { handoffTaskManager(d.project); return; }
        }
        if (st === 'ready_to_publish' || st === 'publishing' || st === 'live') { setGen('ready'); return; }
        if (st === 'rejected' || st === 'failed') {
          setGenError(d.project.rejection_reason || `plan ${st}`); setGen('error'); return;
        }
        if (st === 'draft') genSince = null;
        else genSince = genSince ?? Date.now();
      } catch { /* transient — keep polling */ }
      if (genSince && Date.now() - genSince > 4 * 60_000) { setGenError(t('timed out', 'превышено время ожидания')); setGen('error'); return; }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  };

  // who builds: persisted per project; API informed when the endpoint exists
  const chooseBuildMode = (m: BuildMode) => {
    setBuildMode(m);
    if (project) {
      const all = loadModes(); all[project.id] = m;
      localStorage.setItem(MODE_KEY, JSON.stringify(all));
      setBuildModeApi(project.id, m).catch(() => { /* endpoint not shipped yet */ });
    }
  };

  // Managed-bot creation now lives on the bot overview page (BotOverview owns the
  // initiate + deep-link + poll flow). App only tracks botInit/botCreated for the
  // build-pipeline snapshot + the resume path below.

  // poll until the managed-bot poller captures the bot created in Telegram
  useEffect(() => {
    if (!botInit || botUsername || !project) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const b = await getProjectBot(project.id);
        if (cancelled) return;
        if (b?.bot_username) { setBotUsername(b.bot_username); setBotCreated(true); return; }
      } catch { /* transient — keep polling */ }
      timer = setTimeout(tick, 5000);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botInit, botUsername, project?.id]);

  // ── hash routes: memorize the current page across refreshes ──
  // #/ (build entry) · #/build/<projectId> · #/bots · #/bots/<id>[/chat]
  // routeReady gates the rewrite effect so an async restore (resumeBuild) can't
  // be clobbered with an intermediate '#/' before the tab/project settle.
  const restored = useRef(false);
  const routeReady = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'bots') {
      setTab('manage');
      if (parts[1]) {
        setManageBot(parts[1]);
        setManageView(parts[2] === 'chat' ? 'chat' : parts[2] === 'activity' ? 'activity' : parts[2] === 'taskboard' ? 'taskboard' : parts[2] === 'inbox' ? 'inbox' : parts[2] === 'board' ? 'board' : parts[2] === 'plan' ? 'plan' : parts[2] === 'env' ? 'env' : 'overview');
      }
      routeReady.current = true;
    } else if (parts[0] === 'discover') {
      setTab('discover');
      routeReady.current = true;
    } else if (parts[0] === 'build' && parts[1]) {
      void resumeBuild(parts[1]); // restores the step; sets routeReady when settled
    } else {
      routeReady.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!routeReady.current) return;
    const sub = manageView === 'chat' ? '/chat' : manageView === 'activity' ? '/activity' : manageView === 'taskboard' ? '/taskboard' : manageView === 'inbox' ? '/inbox' : manageView === 'board' ? '/board' : manageView === 'plan' ? '/plan' : manageView === 'env' ? '/env' : '';
    const h = tab === 'manage'
      ? (manageBot ? `#/bots/${manageBot}${sub}` : '#/bots')
      : tab === 'discover' ? '#/discover'
      : project ? `#/build/${project.id}` : '#/';
    history.replaceState(null, '', h);
  }, [tab, manageBot, manageView, project?.id]);

  // ── persist the pipeline so closing the mini-app doesn't lose progress ──
  useEffect(() => {
    if (!project) return; // cleared explicitly on restart / edit-idea
    const snap: PipelineSnap = {
      projectId: project.id, step: id, idea,
      botCreated, botUsername, connected, agentName,
    };
    localStorage.setItem(PIPELINE_KEY, JSON.stringify(snap));
  }, [project?.id, id, idea, botCreated, botUsername, connected, agentName]);

  // resume an in-progress bot from My Bots. A published bot opens its
  // overview; an unfinished one re-enters the build pipeline at the right
  // step. `target` forces a build step, bypassing the published→overview shortcut.
  const resumeBuild = async (projectId: string, target?: StepId) => {
    const d = await getProject(projectId).catch(() => null);
    if (!d) return;
    const p = d.project;
    const published = p.status === 'live' || p.status === 'completed' || p.status === 'publishing';
    if (published && !target) {
      cancelPoll.current();
      setManageBot(p.id); setManageView('overview'); setDir(1); setTab('manage');
      routeReady.current = true;
      void refreshMyBots(p.id);
      return;
    }
    // task_manager projects auto-decompose — they have no spec/agent/publish
    // wizard. Reopening one mid-build drops onto the living board (the fresh-chat
    // handoff), not the wizard (which would 409 on publish). Detect via the same
    // signals as pollPlan: build_pipeline, the 'generating' proxy, else a /dag probe.
    if (!target) {
      const tm = p.build_pipeline === 'task_manager'
        || p.status === 'generating'
        || (await getProjectPipeline(p.id)) === 'task_manager';
      if (tm) { handoffTaskManager(p); routeReady.current = true; return; }
    }
    // re-enter the build pipeline (phase projects)
    setDir(1); setTab('build');
    cancelPoll.current();
    resetPipeline();
    setProject(p);
    setBuildMode(modeFor(p));
    routeReady.current = true;
    const snap = loadSnap();
    const inFlight = p.status === 'draft' || p.status === 'validating';
    if (inFlight) { setGen('generating'); pollPlan(p.id); }
    else setGen('ready');

    if (target) {
      setIdea(snap?.projectId === p.id ? snap.idea : p.name);
      if (snap && snap.projectId === p.id) { setConnected(snap.connected); setAgentName(snap.agentName); }
      const bot = await getProjectBot(p.id).catch(() => null);
      if (bot?.bot_username) { setBotUsername(bot.bot_username); setBotCreated(true); setBotInit({}); }
      goTo(STEPS.indexOf(target), 1);
    } else if (p.status === 'draft') {
      // still clarifying — the chat history reloads from the server
      setIdea(snap?.projectId === p.id ? snap.idea : p.name);
      goTo(STEPS.indexOf('clarify'), 1);
    } else if (snap && snap.projectId === p.id) {
      // same device — restore the exact state
      setIdea(snap.idea);
      setBotUsername(snap.botUsername); setBotCreated(snap.botCreated || !!snap.botUsername);
      setConnected(snap.connected); setAgentName(snap.agentName);
      // only the early build-pipeline steps live on the build tab now; anything
      // past clarify (the old spec/agent steps) is driven from the bot overview.
      if (snap.step === 'prompt' || snap.step === 'clarify') goTo(STEPS.indexOf(snap.step), 1);
      else handoffToOverview(p);
    } else if (p.status === 'validating') {
      // still decomposing/plan-gen — stay in the chat
      setIdea(p.name);
      goTo(STEPS.indexOf('clarify'), 1);
    } else {
      // plan ready (or a bot already exists) → straight to the overview
      setIdea(p.name);
      const bot = await getProjectBot(p.id).catch(() => null);
      if (bot?.bot_username) { setBotUsername(bot.bot_username); setBotCreated(true); setBotInit({}); }
      handoffToOverview(p);
    }
  };

  // ── "Start building": publish the repo, then land on the bot's overview ──
  // Publishing creates the GitHub repo + the plan/tasks the platform (or the
  // owner's agent) builds. Everything after is watched on the overview page.
  const startBuild = async () => {
    if (!project || building) return;
    setBuilding(true); setBuildError(null);
    setBuildModeApi(project.id, buildMode).catch(() => { /* endpoint not shipped yet */ });
    try {
      let pub: Project = project;
      // task_manager projects auto-build (draft→validating→generating→live) with
      // NO manual publish step — only the old phase flow calls publishProject.
      // Skip it when the project is task_manager or already building/published;
      // otherwise a publish 409s ("project not ready_to_publish, status: generating").
      const BUILDING = new Set(['live', 'publishing', 'completed', 'generating']);
      const alreadyBuilding = BUILDING.has(project.status) || project.build_pipeline === 'task_manager';
      if (!alreadyBuilding) {
        try {
          const r = await publishProject(project.id);
          pub = r.project ?? { ...project, status: 'live', github_repo_url: r.github_repo_url };
        } catch (e) {
          // re-fetch: if it's already moving forward (incl. task_manager's
          // auto-build), go watch it on the overview instead of erroring.
          const d = await getProject(project.id).catch(() => null);
          const s = d?.project.status;
          if (s && (BUILDING.has(s) || s === 'validating')) pub = d!.project;
          else throw e;
        }
      }
      const pid = pub.id;
      // surface the bot on the overview immediately (before the list refresh lands)
      setMyBots(prev => prev.some(b => b.id === pid) ? prev : [botFromProject(pub), ...prev]);
      // reset the build tab and jump to the bot's overview
      resetPipeline();
      localStorage.removeItem(PIPELINE_KEY);
      setIdea(''); setChanged(false); setStep(0);
      setManageBot(pid); setManageView('overview'); setDir(1); setTab('manage');
      void refreshMyBots(pid);
    } catch (e) {
      setBuildError(e instanceof ApiError
        ? `${t("Couldn't start the build", 'Не удалось запустить сборку')} — ${e.message}${e.details ? ` (${e.details})` : ''}`
        : t("Couldn't start the build — network error. Tap to retry.", 'Не удалось запустить сборку — ошибка сети. Нажмите, чтобы повторить.'));
    } finally {
      setBuilding(false);
    }
  };

  // ── My Bots: real deployed + in-progress projects of this owner ──
  // keepId preserves a just-created bot through replication lag (the API list
  // may not include it on the first refresh right after publish).
  const refreshMyBots = async (keepId?: string) => {
    if (!tgAuthed || !tgAgentId) { setMyBots([]); return; }
    setBotsLoading(true);
    try {
      const list = await listProjectsByAgent(tgAgentId);
      const mine = (list.projects || []).filter(p => p.status !== 'rejected' && p.status !== 'failed' && !hiddenBots.has(p.id));
      setMyBots(prev => {
        const mapped = mine.map(p => {
          const existing = prev.find(b => b.id === p.id);
          const fresh = botFromProject(p);
          return existing ? { ...existing, status: fresh.status, inProgress: fresh.inProgress, statusLabel: fresh.statusLabel, name: p.name } : fresh;
        });
        const keep = keepId || manageBot;
        if (keep && !mapped.some(b => b.id === keep)) {
          const kept = prev.find(b => b.id === keep);
          if (kept) return [kept, ...mapped];
        }
        return mapped;
      });
    } catch { /* keep whatever we had */ }
    setBotsLoading(false);
  };

  // load the public discover feed; tolerate a missing endpoint (empty state)
  const refreshDiscover = async () => {
    setDiscoverLoading(true);
    try {
      const list = await listDiscoverBots();
      setDiscoverBots((list.projects || []).map(discoverBotFromProject).filter((b): b is DiscoverBot => b !== null));
    } catch { setDiscoverBots([]); } // 404/405/429 → empty "coming soon"
    setDiscoverLoading(false);
  };

  useEffect(() => {
    if (tab === 'manage') void refreshMyBots();
    if (tab === 'discover') void refreshDiscover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tgAuthed]);

  // keep the open chat pinned to the latest message — ONLY in the chat view.
  // manageChat also feeds the overview's Recent Activity, so without the
  // manageView gate this yanked the overview/other views to the bottom whenever
  // chat messages loaded.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user is parked near the bottom of the scroll container —
  // updated by the container's onScroll. New messages only auto-pin when this
  // is true (or the user just sent one); yanking someone who scrolled up to
  // read history loses their place.
  const nearBottom = useRef(true);
  const wasInChat = useRef(false);
  const activeBot = manageBot ? myBots.find(b => b.id === manageBot) ?? null : null;
  useEffect(() => {
    const inChat = tab === 'manage' && !!manageBot && manageView === 'chat';
    const entering = inChat && !wasInChat.current;
    wasInChat.current = inChat;
    if (!inChat) return;
    const last = manageChat.messages[manageChat.messages.length - 1];
    const justSent = !!last && last.id < 0; // optimistic own message
    if (!entering && !justSent && !nearBottom.current) return; // reading history — don't yank
    // defer to after paint: reading scrollHeight synchronously in the effect can
    // grab a stale (too-short) height before the thread's bubbles/fonts settle,
    // which leaves a long history parked near the top. Pin to bottom post-layout.
    const pin = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; };
    const r1 = requestAnimationFrame(() => { pin(); requestAnimationFrame(pin); });
    return () => cancelAnimationFrame(r1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, manageBot, manageView, manageChat.messages.length, manageChat.thinking]);

  // delete: real DELETE when the API grows it; local hide as the fallback
  const deleteBot = async (botId: string) => {
    try { await deleteProject(botId); } catch { /* endpoint not shipped yet — hide locally */ }
    setHiddenBots(prev => {
      const next = new Set(prev); next.add(botId);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      return next;
    });
    unpinBot(botId); // a deleted bot leaves no ghost in the pin order
    setMyBots(bs => bs.filter(b => b.id !== botId));
    setManageBot(null); setDir(-1);
  };

  // ── pin / unpin (client-side ordering) ──
  const persistPins = (ids: string[]) => {
    setPinnedBots(ids);
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  };
  const pinBot = (botId: string) => {
    haptic('success');
    persistPins([...pinnedBots.filter(id => id !== botId), botId]); // newest pin last → rendered highest
  };
  const unpinBot = (botId: string) => {
    if (!pinnedBots.includes(botId)) return;
    persistPins(pinnedBots.filter(id => id !== botId));
  };
  const pinnedSet = useMemo(() => new Set(pinnedBots), [pinnedBots]);
  // Swipe-left routes here: unpinning is the harmless reverse of the gesture, so
  // it fires immediately; pinning reorders the list, so it asks first.
  const onSwipePin = (botId: string) => {
    if (pinnedSet.has(botId)) { haptic('light'); unpinBot(botId); return; }
    const bot = myBots.find(b => b.id === botId);
    if (bot) setSwipeConfirm({ kind: 'pin', bot });
  };
  const onSwipeDelete = (botId: string) => {
    const bot = myBots.find(b => b.id === botId);
    if (bot) setSwipeConfirm({ kind: 'delete', bot });
  };
  const confirmSwipe = () => {
    if (!swipeConfirm) return;
    const { kind, bot } = swipeConfirm;
    setSwipeConfirm(null);
    if (kind === 'delete') void deleteBot(bot.id);
    else pinBot(bot.id);
  };
  // Pinned bots float to the top, newest pin highest; the rest keep list order.
  // A stable sort preserves the server ordering within each group.
  const sortedBots = useMemo(() => {
    const rank = (id: string) => { const i = pinnedBots.indexOf(id); return i < 0 ? -1 : pinnedBots.length - i; };
    return [...myBots].sort((a, b) => rank(b.id) - rank(a.id));
  }, [myBots, pinnedBots]);

  const sendUpdate = () => {
    const text = draft.trim();
    if (!manageBot || !text) return;
    setDraft('');
    // The chat is the single change input. The backend already routes a chat
    // message to the build/feedback flow (it replies "Got it — updating…" for a
    // change, or "a build is already running…"), so we just send — no extra
    // ship-update call here, which would double-fire the rebuild.
    manageChat.send(text);
  };

  // pause / resume the managed bot — optimistic (real PUT when the API ships)
  const togglePause = (botId: string) => {
    setPausedBots(prev => {
      const next = new Set(prev);
      const willPause = !next.has(botId);
      if (willPause) next.add(botId); else next.delete(botId);
      localStorage.setItem(PAUSED_KEY, JSON.stringify([...next]));
      setBotPaused(botId, willPause).catch(() => { /* endpoint not shipped yet */ });
      return next;
    });
  };

  // show/hide a bot on Discovery — optimistic (real PUT when the API ships)
  const toggleDiscoverable = (botId: string) => {
    setDiscoverOptOut(prev => {
      const next = new Set(prev);
      const willHide = !next.has(botId); // currently shown → hide it
      if (willHide) next.add(botId); else next.delete(botId);
      localStorage.setItem(DISCOVER_OPTOUT_KEY, JSON.stringify([...next]));
      setDiscoverable(botId, !willHide).catch(() => { /* endpoint not shipped yet */ });
      return next;
    });
  };

  // ── restart / edit loops ──
  const resetPipeline = () => {
    cancelPoll.current();
    setProject(null); setGen('idle'); setGenError(null); setChatDraft('');
    setBotCreated(false);
    setBotInit(null); setBotUsername(null);
    setBuilding(false); setBuildError(null);
    setConnected(false); setAgentName(null);
  };

  // Plan ready → hand straight off to the bot's OVERVIEW page (no review screen).
  // The chat already shows the inline "generating…" loader, so there's no footer
  // button to tap; a short beat lets the "ready" bubble land before the forward
  // slide (dir=1). The overview then drives assign-agent → create-bot → build.
  useEffect(() => {
    if (tab !== 'build' || id !== 'clarify' || gen !== 'ready' || !project) return;
    const t = setTimeout(() => handoffToOverview(project), 850);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id, gen, project?.id]);

  // ── MainButton config per step ──
  const mainBtn = ((): { label: string; disabled?: boolean; busy?: boolean; icon?: string; onClick?: () => void } | null => {
    switch (id) {
      case 'prompt': return {
        // outside Telegram there is no initData to authorize with — say so
        label: idea.trim() && !tgAuthed && !insideTelegram
          ? t('Open in Telegram to build', 'Откройте в Telegram, чтобы собрать')
          : t('Start generating', 'Начать генерацию'),
        disabled: !idea.trim() || (!tgAuthed && !insideTelegram) || starting,
        busy: starting,
        onClick: () => void startChatFlow(),
      };
      // while drafting the footer is the chat composer (see below). Once the
      // brief is accepted there's no footer button: the chat already shows the
      // inline "generating…" loader, and we auto-advance to the bot overview
      // when the plan is ready (see the effect above).
      case 'clarify': return null;
      case 'agent': {
        const ready = buildMode === 'platform' || connected;
        return {
          label: building
            ? t('Starting…', 'Запуск…')
            : ready ? t('Start building', 'Начать сборку') : t('Connecting…', 'Подключение…'),
          disabled: !ready || building,
          busy: building || (buildMode === 'local' && !connected),
          onClick: () => void startBuild(),
        };
      }
    }
  })();

  // ── back behavior (in-app header in the browser, native BackButton in Telegram) ──
  const onBack = ((): (() => void) | null => {
    if (id === 'prompt') return null;
    return back;
  })();
  const closeChat = () => {
    setDir(-1);
    if (detailTask) { setDetailTask(null); return; } // close the TaskDetail overlay first
    if (manageView !== 'overview') setManageView('overview');
    else setManageBot(null);
  };
  const backAction: (() => void) | null =
    tab === 'discover' ? null : tab === 'manage' ? (activeBot ? closeChat : null) : onBack;

  // Telegram's own header already exists inside the mini-app — drive its
  // native BackButton instead of rendering our mocked chrome.
  const backRef = useRef<(() => void) | null>(null);
  backRef.current = backAction;
  useEffect(() => backButtonOnClick(() => backRef.current?.()), []);
  useEffect(() => { backButtonVisible(!!backAction); }, [!!backAction]);

  // ── screen body (build tab) ──
  const screen = (() => {
    switch (id) {
      case 'prompt': return (
        <PromptScreen T={T} idea={idea} setIdea={setIdea} changed={changed}
          user={telegramUser()} onToggleTheme={toggleTheme} error={startError}
          startBtn={mainBtn} />
      );
      case 'clarify': return (
        <ClarifyScreen T={T} messages={clarifyChat.messages} thinking={clarifyChat.thinking} thinkingStatus={clarifyChat.thinkingStatus}
          status={project?.status ?? null} gen={gen} genError={genError}
          onOption={(label) => clarifyChat.send(label)}
          onRetry={() => { if (project) { setGen('generating'); setGenError(null); pollPlan(project.id); } }}
          onRetrySend={clarifyChat.retry} />
      );
      case 'agent': return (
        <AgentScreen T={T} connected={connected} agentName={agentName} project={project}
          mode={buildMode} onMode={chooseBuildMode} error={buildError}
          onConnected={(client) => {
            setAgentName((client || 'Claude').split('/')[0]);
            setConnected(true);
            // agent is live — no extra tap: publish and go straight to the overview
            // (on failure startBuild surfaces the error and the manual button returns)
            void startBuild();
          }} />
      );
    }
  })();

  // ── header per tab (mocked chrome — browser only; Telegram draws its own) ──
  const header = insideTelegram ? null : (tab === 'manage'
    ? (activeBot
      ? <TGHeader T={T}
          title={manageView === 'activity' ? t('Activity', 'События') : manageView === 'plan' ? t('The plan', 'План') : manageView === 'board' || manageView === 'taskboard' ? t('Build board', 'Доска сборки') : manageView === 'inbox' ? t('Needs you', 'Требует внимания') : manageView === 'env' ? t('Settings', 'Настройки') : activeBot.name}
          subtitle={manageView === 'overview' || manageView === 'chat' ? '@' + activeBot.handle + ' · ' + activeBot.version : '@' + activeBot.handle}
          onBack={closeChat} />
      : <TGHeader T={T} title={t('My Bots', 'Мои боты')} subtitle={t('Deployed on AgentBot', 'Развёрнуто на AgentBot')} />)
    : tab === 'discover'
    ? <TGHeader T={T} title={t('Discover', 'Каталог')} subtitle={t('Bots built on AgentBot', 'Боты, созданные на AgentBot')} />
    : <TGHeader T={T} title="AgentBot" subtitle={t(...STAGE_SUB[id])} onBack={onBack} />);

  // ── body per tab ──
  const body = tab === 'manage'
    ? (activeBot
      ? (manageView === 'chat'
        ? <BotChat T={T} bot={activeBot} messages={manageChat.messages} thinking={manageChat.thinking} thinkingStatus={manageChat.thinkingStatus}
            showIdentity={insideTelegram} onOption={(label) => manageChat.send(label)}
            onRetry={manageChat.retry} />
        : manageView === 'activity'
        ? <ActivityPage T={T} bot={activeBot} events={manageChat.messages.filter(m => m.role === 'system')} />
        : manageView === 'board'
        ? <DagBoard T={T} bot={activeBot} />
        : manageView === 'taskboard'
        // task_manager → tap-through TaskManagerBoard; phase → DagBoard (BoardView discriminates)
        ? <BoardView T={T} bot={activeBot}
            known={activeBot.isTaskManager === true ? 'task_manager' : activeBot.isTaskManager === false ? 'phase' : undefined}
            onOpenTask={(slug) => { setDir(1); setDetailTask(slug); }} />
        : manageView === 'inbox'
        ? <TaskManagerInbox T={T} bot={activeBot}
            onOpenTask={(slug) => { setDir(1); setDetailTask(slug); }} />
        : manageView === 'plan'
        ? <BlueprintScreen T={T} projectId={activeBot.id} />
        : manageView === 'env'
        ? <BotEnv T={T} projectId={activeBot.id} botLiveHint={!pausedBots.has(activeBot.id)} />
        : <BotOverview T={T} bot={activeBot} messages={manageChat.messages}
            onOpenChat={() => { setDir(1); setManageView('chat'); }}
            onOpenBoard={() => { setDir(1); setManageView('taskboard'); }}
            onOpenInbox={() => { setDir(1); setManageView('inbox'); }}
            onOpenPlan={() => { setDir(1); setManageView('plan'); }}
            onViewActivity={() => { setDir(1); setManageView('activity'); }}
            onOpenEnv={() => { setDir(1); setManageView('env'); }}
            paused={pausedBots.has(activeBot.id)}
            onTogglePause={() => togglePause(activeBot.id)}
            discoverable={!discoverOptOut.has(activeBot.id)}
            onToggleDiscoverable={() => toggleDiscoverable(activeBot.id)}
            onDelete={() => void deleteBot(activeBot.id)} />)
      : <MyBotsList T={T} bots={sortedBots} loading={botsLoading} authed={tgAuthed} pinned={pinnedSet}
          onOpen={(bid) => {
            const b = myBots.find(x => x.id === bid);
            if (b?.inProgress) void resumeBuild(bid); // back to the step it was closed on
            else { setManageBot(bid); setManageView('overview'); setDir(1); }
          }}
          onBuildFirst={() => { setDir(1); setTab('build'); }}
          onDelete={onSwipeDelete} onPin={onSwipePin} />)
    : tab === 'discover'
      ? <DiscoveryPage T={T} bots={discoverBots} loading={discoverLoading} />
    : screen;

  // ── footer (above the tab bar) ──
  // clarify-while-drafting uses the chat composer; once the brief is accepted
  // (status leaves draft) the MainButton takes over.
  //
  // …with one exception: an OPEN env question needs an answer, so the composer
  // must survive a system message that happens to land beside it. Without this
  // the owner would be looking at a question with no way to answer it — and the
  // stage swallows their next message, so there is no way around it either.
  const drafting = id === 'clarify' && project?.status === 'draft' && gen !== 'error'
    && (!clarifyChat.messages.some(m => m.role === 'system') // system msg = brief locked, even before the status poll catches up
      || !!clarifyEnvAsk);
  const footer = tab === 'discover'
    ? null // the discover feed has no footer (no stray build CTA / composer)
    : tab === 'manage'
    ? (activeBot && manageView === 'chat'
      ? <Composer T={T} draft={draft} onChange={setDraft} onSend={sendUpdate} disabled={false}
          secret={!!manageEnvAsk?.secret} placeholder={manageEnvAsk ? envPlaceholder(manageEnvAsk) : undefined} />
      : null)
    : drafting
    ? <Composer T={T} draft={chatDraft} onChange={setChatDraft}
        onSend={() => { const t = chatDraft.trim(); if (t) { clarifyChat.send(t); setChatDraft(''); } }}
        disabled={false} secret={!!clarifyEnvAsk?.secret}
        placeholder={clarifyEnvAsk ? envPlaceholder(clarifyEnvAsk) : t('Type your answer…', 'Введите ответ…')} />
    : id === 'prompt'
    ? null // prompt step renders its "Start generating" button inline (inside the textarea card)
    : (mainBtn ? <MainButton T={T} {...mainBtn} /> : null);

  const animKey = tab === 'manage' ? `m-${manageBot || 'list'}-${manageView}` : tab === 'discover' ? 'd-discover' : `b-${step}`;

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', background: T.pageBg, transition: 'background .3s',
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
        @keyframes tgline { from { opacity:0; transform: translateX(-4px); } to { opacity:1; transform:none; } }
        @keyframes tgpop { 0% { transform: scale(.5); opacity:0; } 100% { transform: scale(1); opacity:1; } }
        @keyframes scrIn { from { opacity:0; transform: translateX(var(--scr-dx)); } to { opacity:1; transform:none; } }
        @keyframes tgfade { from { opacity:0; } to { opacity:1; } }
        @keyframes tgsheet { from { transform: translateY(100%); } to { transform: none; } }
        textarea::placeholder { color: ${T.hint}; }
        ::-webkit-scrollbar { width: 0; height: 0; }
      `}</style>

      {header}
      <div ref={scrollRef} key={animKey}
        onScroll={e => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', position: 'relative',
          // Keep the rubber-band inside this scroller: without it, hitting the
          // top or bottom hands the leftover scroll to the page — which inside
          // Telegram is the sheet itself, and it drifts.
          overscrollBehavior: 'contain',
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
      {footer}
      {/* Floating tab bar on onboarding / Bots / Discover / Dashboard — only the
          active dialog steps (chat, build, plan) stay focused/immersive. */}
      {((tab === 'build' && id === 'prompt') || tab === 'discover' || (tab === 'manage' && (!manageBot || manageView === 'overview'))) && (
        <TabBar T={T} tab={tab} onTab={(tb) => {
          setDir(1);
          // tapping My Bots pops to its root (the list), not the last-open bot
          if (tb === 'manage') { setManageBot(null); setManageView('overview'); }
          setTab(tb);
        }} />
      )}

      {/* task_manager: per-task detail panel — overlay opened from the board/inbox */}
      {detailTask && manageBot && (
        <Suspense fallback={null}>
          <TaskDetail T={T} projectId={manageBot} slug={detailTask}
            onClose={() => setDetailTask(null)} />
        </Suspense>
      )}

      {/* swipe confirm — always mounted so the sheet slide-in/out is a real
          transition. `swipeConfirm` clears the instant it's dismissed, but the
          sheet is still animating OUT then, so the copy is read from the last
          non-null value (held in a ref) — otherwise the name flashes to
          "undefined" as it slides away. */}
      {(() => {
        if (swipeConfirm) lastSwipeConfirm.current = swipeConfirm;
        const c = swipeConfirm ?? lastSwipeConfirm.current;
        const del = c?.kind === 'delete';
        return (
          <ConfirmSheet
            T={T} open={!!swipeConfirm}
            destructive={del}
            icon={del ? 'trash' : 'pin'}
            title={del
              ? t('Delete this bot?', 'Удалить этого бота?')
              : t('Pin to the top?', 'Закрепить наверху?')}
            body={del
              ? t(`Removes ${c?.bot.name ?? ''} from your list. The Telegram bot itself keeps running.`,
                  `Удаляет ${c?.bot.name ?? ''} из вашего списка. Сам Telegram-бот продолжит работать.`)
              : t(`${c?.bot.name ?? ''} will stay at the top of your bots.`,
                  `${c?.bot.name ?? ''} будет всегда наверху списка ботов.`)}
            confirmLabel={del ? t('Delete', 'Удалить') : t('Pin', 'Закрепить')}
            cancelLabel={t('Cancel', 'Отмена')}
            onConfirm={confirmSwipe}
            onCancel={() => setSwipeConfirm(null)} />
        );
      })()}
    </div>
  );
}
