// api/client.ts — typed client for the agnt API (https://api.agnt-gm.ai).
// Dev goes through the Vite proxy (/api); production builds call the API
// directly (CORS allows the deployed origins). Override with VITE_API_BASE.

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)
  || (import.meta.env.DEV ? '/api' : 'https://api.agnt-gm.ai/api');

export class ApiError extends Error {
  status: number;
  details?: string;
  warning?: string; // 409s carry an actionable `warning` (e.g. cancel-review escape) — surfaced verbatim
  constructor(status: number, message: string, details?: string, warning?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.warning = warning;
  }
}

// Session token (JWT) issued by POST /auth/telegram — attached to every call.
let authToken: string | null = null;
export function setAuthToken(token: string | null): void { authToken = token; }

// Global rate-limit backoff. A 429 from anywhere pauses ALL polling GETs until
// this time, so the many background pollers (chat, /blocked, /dag, overview…)
// stop hammering instead of each independently retrying into the limit.
// Mutations (POST/PUT/DELETE) are never short-circuited — a user action must
// not be silently dropped; polls catch the synthetic 429 and keep their snapshot.
let rateLimitedUntil = 0;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isGet = method.toUpperCase() === 'GET';
  if (isGet && Date.now() < rateLimitedUntil) {
    throw new ApiError(429, 'rate limited — backing off');
  }
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    rateLimitedUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15000);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok && res.status !== 202) {
    throw new ApiError(res.status, json?.error || res.statusText || 'request failed', json?.details, json?.warning);
  }
  return json as T;
}

// ── Projects ──────────────────────────────────────────────────

export type ProjectStatus =
  | 'validating' | 'ready_to_publish' | 'publishing' | 'live'
  | 'rejected' | 'failed' | 'completed' | string;

export interface Project {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  short_description?: string;
  goal_of_project?: string;
  about_of_project?: string;
  rejection_reason?: string;
  needs_frontend?: boolean;
  needs_backend?: boolean;
  needs_database?: boolean;
  database_kind?: string;
  token_symbol?: string;
  github_repo_url?: string;
  github_project_url?: string;
  live_url?: string;
  bot_username?: string;   // the real managed-bot @username (for t.me links on Discovery)
  bot_avatar_url?: string; // AI-generated bot avatar (public Spaces URL); absent until generated
  discoverable?: boolean;  // listed on the Discover page; absent/true = shown, false = opted out
  logo_url?: string;
  preview_image_url?: string;
  open_tasks?: number;
  open_easy?: number;
  open_hard?: number;
  active_agents?: number;
  prs_merged_7d?: number;
  owner_wallet_address?: string;
  created_at?: string;
  published_at?: string;
  build_mode?: string; // 'local_agent' | 'platform_agent' once the API ships it
  // ── task_manager flow (landing on the project DTO; absent for now — feature-detect) ──
  build_pipeline?: 'phase' | 'task_manager' | 'whole_bot' | string; // discriminator
  current_phase?: string;   // 'published' once the bot is actually live (gap #4 workaround)
  phase_status?: string;
  bot_go_live_at?: string;  // server-side only today (gap #4)
  decomposed_at?: string;
  auto_merge_enabled?: boolean;
  auto_merge_after_revalidation?: boolean;
  // whole_bot build snapshot (stage label + approx %/ETA + pass timeline) — only
  // present on the single-project detail endpoint for build_pipeline='whole_bot'.
  build_progress?: BuildProgress;
}

// whole_bot N-pass build snapshot the build screen renders (a progress bar +
// plain-language stage + approximate ETA + per-pass timeline). All approximate.
export interface BuildProgress {
  phase: string;          // building | tests | published | failed
  stage: string;          // blueprint|building|reviewing|testing|deploying|live|failed
  stage_label: string;    // human one-liner, e.g. "🔨 Building your bot — pass 2"
  percent: number;        // 0..100, APPROXIMATE
  eta_seconds: number;    // APPROXIMATE remaining; 0 when live/failed
  pass_current: number;   // highest pass number reached (THIS build; resets to 1 each change)
  merged_passes: number;  // accepted passes
  pass_floor: number;     // min passes before publish
  passes?: BuildProgressPass[] | null; // null/absent before the first pass — always guard
  // BACKEND TODO: iterations restart at 1 on every "Ask for change" build, so the
  // UI can't show a lifetime number (a change reads as "Iteration 1" when the bot
  // already ran 8+). When the backend can supply how many iterations ran in PRIOR
  // builds, send it here; the UI adds it to pass_no/pass_current for a cumulative
  // number. Absent/0 = initial build (today's behavior). See iterOffset() usage.
  iteration_offset?: number;
}

export interface BuildProgressPass {
  pass_no: number;
  status: string;         // building|merged|reviewed|failed
  pr_number?: number;
  complete?: boolean;
  label: string;          // short row label, e.g. "merged · complete ✓"
}

export interface ProjectDetail {
  project: Project;
  readme_md?: string;
  tokenomics?: unknown;
}

export interface ProjectList {
  projects: Project[];
  total: number;
  limit: number;
  offset: number;
}

export function getProject(idOrSlug: string): Promise<ProjectDetail> {
  return request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}`);
}

export interface PublishResult {
  project: Project;
  github_repo_url?: string;
  issues_opened?: number;
}

export function publishProject(id: string): Promise<PublishResult> {
  return request('POST', `/builder/projects/${encodeURIComponent(id)}/publish`);
}

// ── Owner ↔ AI chat (clarify the idea → draft project → pipeline) ──
// POST /builder/chat creates a draft project from the first message and runs
// the first AI turn. Poll GET .../chat/messages with the id cursor; quick
// replies arrive as `options`, deploy logs as role=system, and `ai_thinking`
// drives the typing indicator.

export interface ChatMessage {
  id: number;
  role: 'owner' | 'assistant' | 'system' | string;
  content: string;
  options?: string[];
  data?: unknown;
  created_at?: string;
  // client-side only: an optimistic message whose POST failed (retryable)
  failed?: boolean;
  // client-side only: this optimistic copy answers an env question, so the
  // server's version will NOT match it by content (that one is masked — or
  // absent, when the value was rejected). Dropped on any server progress.
  envEcho?: boolean;
  // client-side only: what the owner actually typed, when `content` is a mask.
  // Never rendered; exists so a retry re-sends the value, not its placeholder.
  raw?: string;
}

export interface ChatPoll {
  messages: ChatMessage[];
  ai_thinking?: boolean;
  // a short phrase for what the assistant is doing right now (only while
  // ai_thinking) — e.g. "Thinking it through…". Shown in the typing indicator.
  ai_thinking_status?: string;
}

export interface ChatStarted {
  project_id: string;
  status: string;
  poll_url?: string;
}

export function startChat(message: string): Promise<ChatStarted> {
  return request('POST', '/builder/chat', { message });
}

export function sendChatMessage(idOrSlug: string, message: string): Promise<ChatPoll> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/chat/messages`, { message });
}

export function getChatMessages(idOrSlug: string, after = 0, limit = 50): Promise<ChatPoll> {
  return request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/chat/messages?after=${after}&limit=${limit}`);
}

// ── Managed bot (real Telegram bot, created via the manager bot) ──
// initiate: records a suggested username, returns the manager-bot deep link
// the owner taps inside Telegram (pre-filled child-bot creation screen).
// Idempotent — repeat calls return the same (or a fresh) suggestion.
export interface BotInitiate {
  project_id?: string;
  project_slug?: string;
  suggested_username?: string;
  manager_bot?: string;
  deep_link?: string;
  request_managed_bot?: boolean;
  instructions?: string;
}

export function initiateBot(idOrSlug: string): Promise<BotInitiate> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/bot/initiate`);
}

export interface ProjectBot {
  bot_username?: string;
  bot_name?: string;
  bot_id?: string;
  is_managed?: boolean;
  container_state?: string; // live-status surface — non-empty/'running' ⇒ the bot actually serves users
  last_active_at?: string;
  created_at?: string;
  version?: string;
  commands?: unknown;
  paused?: boolean;      // managed bot paused (webhook off)
  paused_at?: string;
}

// the managed bot is actually serving users (the only FE-visible go-live signal
// besides current_phase==='published') — do NOT key this off project.status.
export function botIsLive(b: ProjectBot | null | undefined): boolean {
  if (!b || b.paused) return false;
  const s = (b.container_state || '').toLowerCase();
  return /run|live|ready|active|started|up|healthy|serving/.test(s);
}

// 404 until the managed-bot poller lands the row → null, keep polling.
export async function getProjectBot(idOrSlug: string): Promise<ProjectBot | null> {
  try {
    return await request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/bot`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

// Not in the API yet — called optimistically; 404/405 → the app falls back
// to hiding the bot locally, and upgrades automatically once this ships.
export function deleteProject(idOrSlug: string): Promise<unknown> {
  return request('DELETE', `/builder/projects/${encodeURIComponent(idOrSlug)}`);
}

// ── Build mode: who builds the tasks ──────────────────────────
// 'platform' — the platform's agents build and ship PRs.
// 'local'    — the owner's connected agent does the work; platform only
//              runs gates + deploys.
// Not in the API yet — set optimistically (404 tolerated, mode kept locally).
export type BuildMode = 'platform' | 'local';

export function setBuildModeApi(idOrSlug: string, mode: BuildMode): Promise<unknown> {
  return request('PUT', `/builder/projects/${encodeURIComponent(idOrSlug)}/build-mode`, {
    mode: mode === 'local' ? 'local_agent' : 'platform_agent',
  });
}

export function listProjectsByAgent(agentId: string, limit = 50): Promise<ProjectList> {
  return request('GET', `/builder/projects?owner_agent_id=${encodeURIComponent(agentId)}&limit=${limit}`);
}

// ── Discovery: public feed of live bots (gap — backend ticket pending) ──
// Lists LIVE, discoverable bots (everyone's). The UI feature-detects: a
// 404/405 (endpoint not shipped) surfaces as an empty "coming soon" state.
export function listDiscoverBots(limit = 50): Promise<ProjectList> {
  return request('GET', `/builder/projects/discover?limit=${limit}`);
}

// ── Telegram Mini-App auth (silent, via WebApp initData) ──────
// Validates the initData HMAC against the bot token server-side and issues a
// session JWT for an auto-created Telegram-owned agent.

export interface TelegramAuthResult {
  jwt?: string;
  token?: string;
  agent?: { id: string; display_name?: string; telegram_username?: string; github_username?: string };
}

export function authTelegram(initData: string): Promise<TelegramAuthResult> {
  return request('POST', '/auth/telegram', { init_data: initData });
}

// ── Tasks ─────────────────────────────────────────────────────

export interface TaskItem {
  id: string;
  slug: string;
  title: string;
  status: string;
  difficulty?: 'easy' | 'medium' | 'hard' | string;
  weight?: number;
  reward_amount?: number;
  reward_amount_human?: string;
  is_claimed?: boolean;
  claimers_count?: number;
  github_issue_url?: string;
  pr_url?: string;
  pr_number?: number;
  solved_by_agent_id?: string;
  // DAG extras (chat-created projects)
  phase?: string;
  node_kind?: string; // task_manager type: scaffold|feature|epic|question|review — the real pill (NOT task_kind)
  depends_on?: string[];
  claim_reason?: string;
}

// A soft-claim on a task (2h TTL) — who is currently working it. Never null.
export interface ClaimerBrief {
  agent_id: string;
  username?: string | null;
  avatar_url?: string | null;
  claimed_at?: string;
  expires_at?: string;
}

export interface TaskDetail {
  id?: string;
  slug: string;
  title: string;
  body_md?: string;
  github_issue_url?: string;
  pr_url?: string;
  status?: string;
  // task_manager extras (only on the per-task GET — not on /dag)
  node_kind?: string;        // scaffold | feature | epic | question | review
  parent_id?: string;        // epic→subtask tree; absent = top-level — the ONLY source
  assignee_type?: string;    // 'agent' (executor) | 'owner' (a question task)
  skill_refs?: string[];
  spec_body?: string;        // resolved details the task references
  blocked_since?: string;    // RFC3339
  attempt_count?: number;
  failure_reason?: string;   // why a 'failed' task gave up — optimistic; absent today (backend gap)
  claimers?: ClaimerBrief[];
  is_claimed?: boolean;
}

// Full task body — works for both legacy and DAG tasks.
export async function getTaskDetail(idOrSlug: string, taskSlug: string): Promise<TaskDetail | null> {
  try {
    const r = await request<{ task?: TaskDetail }>('GET',
      `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks/${encodeURIComponent(taskSlug)}`);
    return r.task ?? null;
  } catch {
    return null;
  }
}

export interface TaskList {
  project_id: string;
  project_slug: string;
  token_symbol?: string;
  project_github_url?: string;
  tasks: TaskItem[];
}

export function listProjectTasks(idOrSlug: string): Promise<TaskList> {
  return request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks`);
}

// ── Task DAG (chat-created AGNTDEV projects) ──────────────────
// These projects keep their work in a per-phase task graph; the legacy
// /tasks list is empty for them. fetchProjectTasks() unifies the two.

export interface DagTask {
  slug: string;
  title: string;
  task_kind?: string;  // MEANINGLESS for task_manager — do NOT branch on it
  node_kind?: string;  // scaffold | feature | epic | question | review — THE type (absent = legacy/phase row)
  phase?: string;      // always "" for task_manager — ignore
  status: string;      // open | in_progress | in_review | blocked | done | cancelled | failed
  depends_on?: string[]; // dependency SLUGS (leaves only; never to/from an epic)
  claimable?: boolean; // live gate verdict — trust it for Ready vs Backlog
  claim_reason?: string;
  assignee_agent_id?: string; // the bound executor
  claimers?: ClaimerBrief[];  // 2h soft-claims; never null
  // landing on the /dag DTO (gap #3) — feature-detect; until then fetch per-task
  parent_id?: string; // epic→subtask tree
  skills?: string[];  // skills the task references (a.k.a. skill_refs on the per-task GET)
}

// task_manager rows carry node_kind; phase rows carry `phase` and no node_kind.
// Presence of node_kind on /dag is the reliable discriminator (gap #1 workaround).
export function isTaskManagerDag(d: { tasks?: DagTask[] } | null | undefined): boolean {
  return !!d?.tasks?.some(t => !!t.node_kind);
}

// one-shot discriminator at board/inbox open — public /dag, no token needed.
export async function getProjectPipeline(idOrSlug: string): Promise<'task_manager' | 'phase'> {
  try {
    return isTaskManagerDag(await getProjectDag(idOrSlug)) ? 'task_manager' : 'phase';
  } catch {
    return 'phase';
  }
}

export interface DagInfo {
  current_phase?: string;
  phase_status?: string;
  next_action?: string;
  next_action_reason?: string;
}

export interface ProjectDag extends DagInfo {
  project_id: string;
  project_slug: string;
  tasks: DagTask[];
}

export function getProjectDag(idOrSlug: string): Promise<ProjectDag> {
  return request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/dag`);
}

export interface UnifiedTasks {
  tasks: TaskItem[];
  token_symbol?: string;
  dag?: DagInfo;
  // task_manager discriminator derived from the SAME /dag fetch (node_kind) — so
  // callers don't need a second getProjectDag just to route old vs new (gap #1).
  isTaskManager?: boolean;
}

// Backend ships some claim_reasons that just restate an obvious, non-actionable
// state (in-progress task, epic rollup) — drop those so the UI stays quiet.
const NOISE_CLAIM_REASONS = [
  'task is in_progress; only open tasks can be claimed',
  'epic nodes are display-only rollups and are never claimable',
];
function suppressNoiseReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  return NOISE_CLAIM_REASONS.includes(reason.trim()) ? undefined : reason;
}

// DAG first (the real system for chat-created projects), legacy list as
// the fallback for older bounty-style projects.
export async function fetchProjectTasks(idOrSlug: string): Promise<UnifiedTasks> {
  try {
    const d = await getProjectDag(idOrSlug);
    if (d.tasks?.length || d.current_phase) {
      return {
        isTaskManager: isTaskManagerDag(d),
        tasks: (d.tasks || []).map(t => ({
          id: t.slug,
          slug: t.slug,
          title: t.title,
          status: t.status,
          difficulty: t.task_kind, // legacy/phase pill
          node_kind: t.node_kind,  // task_manager pill (scaffold|feature|epic|question|review)
          claimers_count: t.claimers?.length || 0,
          is_claimed: (t.claimers?.length || 0) > 0,
          phase: t.phase,
          depends_on: t.depends_on,
          claim_reason: t.claimable === false ? suppressNoiseReason(t.claim_reason) : undefined,
        })),
        dag: {
          current_phase: d.current_phase,
          phase_status: d.phase_status,
          next_action: d.next_action,
          next_action_reason: d.next_action_reason,
        },
      };
    }
  } catch { /* no DAG — legacy project */ }
  const legacy = await listProjectTasks(idOrSlug);
  return { tasks: legacy.tasks || [], token_symbol: legacy.token_symbol, isTaskManager: false };
}

// ── Deployments (real deploy history; most recent first) ─────

export interface Deployment {
  id?: string;
  kind?: 'prod' | 'preview' | string;
  status?: string;
  ref_sha?: string;
  failure_reason?: string;
  queued_at?: string;
  built_at?: string;
  deployed_at?: string;
  build_log_url?: string;
}

export function listDeployments(idOrSlug: string): Promise<{ deployments: Deployment[] }> {
  return request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/deployments`);
}

// ── Agent link: one-time connect code → delegate key (CLI side) ──
// Mint is owner-scoped; the CLI exchanges the code via /auth/agent-link/claim.
// The mini-app only mints and polls — the code IS the credential.

export interface AgentLinkCode {
  code: string;
  expires_in?: number;
}

export interface AgentLinkStatus {
  status: 'pending' | 'connected';
  connected_client?: string;
  connected_at?: string;
}

export function mintAgentLink(projectId: string): Promise<AgentLinkCode> {
  return request('POST', `/builder/projects/${encodeURIComponent(projectId)}/agent-link`);
}

export function getAgentLink(projectId: string): Promise<AgentLinkStatus> {
  return request('GET', `/builder/projects/${encodeURIComponent(projectId)}/agent-link`);
}

// ── Bot analytics (end-user usage of the DEPLOYED bot) ────────
// Not in the API yet — 404/405 → null; the overview shows real build stats
// until this lands. Mirrors the mock's "active users / today / vs. yest." card.
export interface BotAnalytics {
  active_users?: number;
  messages_today?: number;
  delta_pct?: number; // change vs. yesterday
  window?: string;
  // ── live usage summary (all optional; the card degrades gracefully) ──
  people_today?: number;   // distinct people the bot answered today
  users_total?: number;    // all-time unique users
  users_new_7d?: number;   // new unique users in the last 7 days
  users_7d?: number[];     // daily unique users, oldest→newest — drives the sparkline
  active_now?: number;     // conversations active right now
}

export async function getBotAnalytics(idOrSlug: string): Promise<BotAnalytics | null> {
  try {
    return await request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/analytics`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}

// ── Pause / resume the managed bot ────────────────────────────
// Not in the API yet — set optimistically (404/405 tolerated, state kept
// locally). The owner-visible status pill flips Live ⇄ Paused immediately.
export function setBotPaused(idOrSlug: string, paused: boolean): Promise<unknown> {
  return request('PUT', `/builder/projects/${encodeURIComponent(idOrSlug)}/bot/pause`, { paused });
}

// ── Bot settings (env) ────────────────────────────────────────
// The keys the bot needs from its owner: API keys, an admin chat id, a channel
// name. The chat collects them once while the bot builds; this is the panel for
// everything after.
//
// The API NEVER returns a stored value — not even masked. A row reports whether
// it is set and nothing more, so there is no field here to render a value from
// and no way for one to reach a screenshot or a log. Replacing a forgotten
// value is one paste; that is the trade this makes on purpose.

export type BotEnvStatus =
  | 'set'      // the owner supplied it
  | 'missing'  // required and empty — the bot needs this and doesn't have it
  | 'skipped'; // owner said "later" during the chat stage

export interface BotEnvRow {
  key: string;
  description?: string;
  example?: string;
  kind: 'secret' | 'admin_id' | 'plain';
  required: boolean;
  is_set: boolean;
  status: BotEnvStatus;
  filled_at?: string;
  sort_order: number;
}

export interface BotEnvPanel {
  env: BotEnvRow[];
  summary: { total: number; set: number; missing: number; skipped: number };
  // bot_live — a running bot is bound to the values it was deployed with, so a
  // change here rebuilds it. Drives what the confirmation actually promises.
  bot_live: boolean;
}

export async function getBotEnv(idOrSlug: string): Promise<BotEnvPanel | null> {
  try {
    return await request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/bot/env`);
  } catch (e) {
    // 404 = this project never declared any env (older bots). Not an error.
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}

export function setBotEnvValue(idOrSlug: string, key: string, value: string): Promise<BotEnvPanel> {
  return request('PUT',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/bot/env/${encodeURIComponent(key)}`,
    { value });
}

export function deleteBotEnvValue(idOrSlug: string, key: string): Promise<BotEnvPanel> {
  return request('DELETE',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/bot/env/${encodeURIComponent(key)}`);
}

// opt a bot in/out of the Discover feed — optimistic (real PUT when the API ships)
export function setDiscoverable(idOrSlug: string, on: boolean): Promise<unknown> {
  return request('PUT', `/builder/projects/${encodeURIComponent(idOrSlug)}/discoverable`, { discoverable: on });
}

// ── Regenerate the AI bot avatar (owner) ──────────────────────
// Async 202 → { accepted, status:'pending' }; the new bot_avatar_url lands on a
// later project poll. The button shows a brief "generating…" state meanwhile.
export interface AvatarRegenResult {
  accepted?: boolean;
  status?: string; // 'pending'
}
export function regenerateBotAvatar(idOrSlug: string): Promise<AvatarRegenResult> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/avatar/regenerate`);
}

// ── Cloud agent (deploy one; max one per bot) ─────────────────
// The "Add an agent" sheet's Cloud option deploys a single managed agent that
// works the project's tasks. At most one per bot. Not in the API yet — the UI
// reports "couldn't deploy" only on real errors.
export interface CloudRun {
  run_id?: string;
  status?: string;
}

export function runCloudAgent(idOrSlug: string): Promise<CloudRun> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/cloud-agent`);
}

// Live cloud-agent status — the source of truth for "is a cloud agent deployed",
// so the UI doesn't depend on this client having recorded the deploy locally.
// 404/405 → null (endpoint not shipped); fall back to build_mode + local state.
export interface CloudAgentStatus {
  deployed?: boolean;
  status?: string;
  id?: string;
}
export async function getCloudAgent(idOrSlug: string): Promise<CloudAgentStatus | null> {
  try {
    return await request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/cloud-agent`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}

// ── task_manager: clarification thread + owner actions ─────────
// The owner only watches and unblocks — these are the actions that move a
// living DAG forward. All owner-only; a non-owner gets 403, a phase project 404.

// a single thread comment (color by author_role; kind='answer' = the resolving reply)
export interface TaskComment {
  id: number;
  task_id?: string;
  project_id?: string;
  author_role: 'agent' | 'owner' | 'system' | string;
  author_agent_id?: string;
  kind?: 'note' | 'question' | 'answer' | string;
  body_md: string;
  created_at?: string;
}

export function getTaskThread(idOrSlug: string, slug: string): Promise<{ comments: TaskComment[] }> {
  return request('GET',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks/${encodeURIComponent(slug)}/thread`);
}

// Resolving reply to a node_kind='question' task — flips it done + unblocks deps.
export interface AnswerResult { question_slug?: string; unblocked?: string[] }
export function answerQuestion(idOrSlug: string, slug: string, bodyMd: string): Promise<AnswerResult> {
  return request('POST',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks/${encodeURIComponent(slug)}/answer`,
    { body_md: bodyMd });
}

// Non-resolving note on any task thread (back-and-forth that doesn't unblock).
export function addTaskComment(idOrSlug: string, slug: string, bodyMd: string): Promise<{ ok: boolean; comment_id?: number }> {
  return request('POST',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks/${encodeURIComponent(slug)}/comments`,
    { body_md: bodyMd });
}

// Cancel a task. Cancelling a node_kind='review' task requires ?confirm=true —
// without it the API 409s with an actionable `warning` (the cancel-review escape).
export interface CancelResult { slug?: string; status?: string; cascaded_cancels?: number }
export function cancelTask(idOrSlug: string, slug: string, confirm = false): Promise<CancelResult> {
  const q = confirm ? '?confirm=true' : '';
  return request('POST',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks/${encodeURIComponent(slug)}/cancel${q}`);
}

// Reopen a failed task (resets attempt_count). 409 if the task isn't 'failed'.
export function reopenTask(idOrSlug: string, slug: string): Promise<{ slug?: string; status?: string }> {
  return request('POST',
    `/builder/projects/${encodeURIComponent(idOrSlug)}/tasks/${encodeURIComponent(slug)}/reopen`);
}

// "Needs your input" inbox: open questions + blocked + failed tasks, oldest first.
export interface BlockedItem {
  slug: string;
  title: string;
  node_kind?: string;
  status: string;
  blocked_since?: string;
  warning?: string; // a systemically-failed review holding the go-live gate
}
export function getBlockedItems(idOrSlug: string): Promise<{ items: BlockedItem[] }> {
  return request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/blocked`);
}

// Post-go-live feedback that materializes NEW tasks into the living DAG.
// Async (202). Rate limited 20/hr → 429. (Equivalent to a chat message once live.)
export function postFeedback(idOrSlug: string, text: string): Promise<{ accepted?: boolean }> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/feedback`, { text });
}

// Manual vs auto merge. Default enabled=true (PRs auto-merge). enabled=false
// leaves approved PRs open for the owner to merge on GitHub (no in-app merge).
export interface AutoMergeResult {
  ok?: boolean;
  project_id?: string;
  auto_merge_enabled?: boolean;
  auto_merge_after_revalidation?: boolean;
}
export function setAutoMerge(idOrSlug: string, enabled: boolean, afterRevalidation?: boolean): Promise<AutoMergeResult> {
  const body: { enabled: boolean; after_revalidation?: boolean } = { enabled };
  if (afterRevalidation !== undefined) body.after_revalidation = afterRevalidation;
  return request('PATCH', `/builder/projects/${encodeURIComponent(idOrSlug)}/auto-merge`, body);
}

// "Retry deploy" — async (202). 409s carry the reason (no bot token, tests gate,
// already running); 503 if the deploy worker is unconfigured. Narrated into chat.
export function retryDeploy(idOrSlug: string): Promise<{ ok?: boolean; status?: string; project_id?: string }> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/deploy`);
}

// Spec doc. No public endpoint exists yet (gap #2) — 404/405 → null and the UI
// falls back to linking docs/spec.md in the repo. Tolerant of the eventual shape.
export interface ProjectSpec {
  title?: string;
  body_md?: string;
  content?: string;
  markdown?: string;
  updated_at?: string;
  url?: string;
}
export async function getProjectSpec(idOrSlug: string): Promise<ProjectSpec | null> {
  try {
    return await request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/spec`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}

// Blueprint ("The plan") — the AI's structured read of the idea. GET
// /projects/:id/quality/blueprint (owner). The endpoint may not be shipped
// everywhere yet, so 403/404/405 → null and the Plan screen shows a fallback.
// All fields optional — the viewer renders whatever is present.
export interface BlueprintEntryPoint { command?: string; description?: string; actor?: string }
export interface BlueprintFlow { name?: string; when?: string; trigger?: string; steps?: string[] | string; summary?: string }
export interface BlueprintEntity { name?: string; description?: string; retention?: 'none' | 'session' | 'persistent' | string }
export interface BlueprintContent {
  entry_points?: BlueprintEntryPoint[];
  flows?: BlueprintFlow[];
  data_entities?: BlueprintEntity[];
  integrations?: string[];
  edge_cases?: string[];
}
export interface Blueprint {
  archetype?: string;
  title?: string;
  summary?: string;
  voice?: string;
  completeness_score?: number; // 0..1
  missing_fields?: string[];
  assumptions?: string[];
  content?: BlueprintContent;
}
export async function getBlueprint(idOrSlug: string): Promise<Blueprint | null> {
  try {
    return await request('GET', `/builder/projects/${encodeURIComponent(idOrSlug)}/quality/blueprint`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 403)) return null;
    throw e;
  }
}
