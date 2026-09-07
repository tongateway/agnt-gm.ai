// api/client.ts — typed client for the agnt API (https://api.agnt-gm.ai).
// Dev goes through the Vite proxy (/api); production builds call the API
// directly (CORS allows the deployed origins). Override with VITE_API_BASE.

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)
  || (import.meta.env.DEV ? '/api' : 'https://api.agnt-gm.ai/api');

export class ApiError extends Error {
  status: number;
  details?: string;
  warning?: string;      // 409s carry an actionable `warning` — surfaced verbatim
  retry?: boolean;       // 409 from bot/initiate: the project isn't named yet — try again shortly
  botUsername?: string;  // 409 from bot/initiate: a bot already exists — just poll it
  constructor(status: number, message: string, body?: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    if (body) {
      if (typeof body.details === 'string') this.details = body.details;
      if (typeof body.warning === 'string') this.warning = body.warning;
      if (body.retry === true) this.retry = true;
      if (typeof body.bot_username === 'string' && body.bot_username) this.botUsername = body.bot_username;
    }
  }
}

// What the owner sees when a call fails. Server `error` strings are English
// deployer/handler jargon ("bot lookup failed", "fly bot launch …"); the
// status code is the part worth translating. Details go to the console.
export function humanError(e: unknown, lang: 'en' | 'ru'): string {
  const ru = lang === 'ru';
  if (e instanceof ApiError) {
    if (e.details) console.warn('[api]', e.status, e.message, e.details);
    if (e.status === 401 || e.status === 403) return ru ? 'Откройте приложение заново' : 'Please reopen the app';
    if (e.status === 404) return ru ? 'Этого бота больше нет' : 'This bot no longer exists';
    if (e.status === 409) return ru ? 'Сейчас недоступно — попробуйте через минуту' : 'Not available right now — try again in a moment';
    if (e.status === 429) return ru ? 'Слишком много запросов — подождите минуту' : 'Too many requests — wait a minute';
  }
  return ru ? 'Что-то пошло не так — попробуйте снова' : 'Something went wrong — try again';
}

// Session token (JWT) issued by POST /auth/telegram — attached to every call.
let authToken: string | null = null;
export function setAuthToken(token: string | null): void { authToken = token; }

// Global rate-limit backoff. A 429 from anywhere pauses ALL polling GETs until
// this time, so the background pollers (chat, project, bot, analytics) stop
// hammering instead of each independently retrying into the limit. Mutations
// (POST/PUT/DELETE) are never short-circuited — a user action must not be
// silently dropped; polls catch the synthetic 429 and keep their snapshot.
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
    throw new ApiError(res.status, json?.error || res.statusText || 'request failed', json);
  }
  return json as T;
}

// ── Projects ──────────────────────────────────────────────────

// draft (intake chat) → validating → generating → live (building; the bot may
// already answer) → current_phase 'published' once the build converged.
// rejected = the content policy said no (see rejection_reason).
export type ProjectStatus =
  | 'draft' | 'validating' | 'generating' | 'live' | 'rejected' | 'failed' | string;

export interface Project {
  id: string;
  slug: string;            // 'draft-…' until the first assistant turn names the project
  name: string;            // 'Untitled' until named
  status: ProjectStatus;
  short_description?: string;
  goal_of_project?: string;
  rejection_reason?: string;
  github_repo_url?: string;
  live_url?: string;
  bot_username?: string;   // the real managed-bot @username (t.me links on Discovery)
  bot_avatar_url?: string; // AI-generated bot avatar (public URL); absent until generated
  bot_is_live?: boolean;   // the managed bot's container is running (list + detail)
  discoverable?: boolean;  // listed on the Discover page; absent/true = shown, false = opted out
  logo_url?: string;
  preview_image_url?: string;
  created_at?: string;
  published_at?: string;   // stamped when the build converged (phase → published)
  current_phase?: string;  // 'building' | 'tests' | 'published' | 'failed'
  bot_go_live_at?: string; // first successful deploy of a built bot
  // funnel stamps (v2; optional — render only when present)
  brief_ready_at?: string;
  first_pass_at?: string;
  first_merge_at?: string;
  preview_live_at?: string;
  // build snapshot (stage label + approx %/ETA + pass timeline) — only on the
  // single-project detail endpoint.
  build_progress?: BuildProgress;
}

// The build snapshot the Bot page renders. `stage` is the stable enum the
// status line is keyed on (translated client-side — the server's stage_label
// is English-only and names pass numbers, so it is only a dev fallback).
export interface BuildProgress {
  phase: string;          // building | tests | published | failed
  stage: string;          // blueprint|building|reviewing|testing|deploying|live|live_with_gaps|awaiting_bot|awaiting_agent|failed
  stage_label: string;    // server one-liner (English) — fallback only
  percent: number;        // 0..100, APPROXIMATE
}

export interface ProjectDetail {
  project: Project;
}

// "answering users" for a LIST row: the server's bot_is_live (container
// running) and nothing else — current_phase 'published' without a bot is
// awaiting_bot, and bot_go_live_at is a one-time stamp that outlives a
// container that later stopped. The Bot page uses botIsLive(ProjectBot).
export function projectIsLive(p: Project): boolean {
  return p.bot_is_live === true;
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

// ── Owner ↔ AI chat (the whole conversation: intake → build events → updates) ──
// POST /builder/chat creates a draft project from the first message and runs
// the first AI turn. Poll GET .../chat/messages with the id cursor; quick
// replies arrive as `options`, build events as role=system, and `ai_thinking`
// drives the typing indicator. On a built bot every owner message is a change
// request or a question — the server decides.

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
// initiate: reserves a username and returns the manager-bot deep link the
// owner taps inside Telegram (pre-filled child-bot creation screen). Works
// while the project is still a draft. Throws ApiError(409, retry=true) while
// the project has no name yet (retry in a few seconds) and ApiError(409,
// botUsername) when a bot already exists (just poll getProjectBot).
export interface BotInitiate {
  project_id?: string;
  project_slug?: string;
  suggested_username?: string;
  manager_bot?: string;
  deep_link?: string;
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
  container_state?: string; // 'running' ⇒ the bot actually serves users
  last_active_at?: string;
  created_at?: string;
  version?: string;
  paused?: boolean;      // managed bot paused (webhook off)
  paused_at?: string;
}

// the managed bot is actually answering users — the "live" signal. A bot can be
// live BEFORE the build finishes (the scaffold deploys ~1 min after the token
// lands), so do NOT key this off project.status or current_phase.
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

// Archives the project server-side (it leaves the owner's list on the next fetch).
export function deleteProject(idOrSlug: string): Promise<unknown> {
  return request('DELETE', `/builder/projects/${encodeURIComponent(idOrSlug)}`);
}

// The owner's bots, from the JWT. GET /builder/projects?owner_agent_id=… is
// served from a 30 s cache that neither archive nor a new draft invalidates
// (a deleted bot came back, a fresh draft was missing on Back); this endpoint
// is uncached and hides archived rows itself.
export function listMyProjects(limit = 50): Promise<ProjectList> {
  return request('GET', `/builder/agents/me/projects?limit=${limit}`);
}

// ── Discovery: public feed of live, discoverable bots (everyone's) ──
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

export function deployFailed(d?: Deployment | null): boolean {
  if (!d) return false;
  return !!d.failure_reason || /fail|error|cancel/i.test(d.status || '');
}

// "Retry deploy" — async (202). 409s carry the reason (no bot token, tests gate,
// already running); 503 if the deploy worker is unconfigured. Narrated into chat.
export function retryDeploy(idOrSlug: string): Promise<{ ok?: boolean; status?: string; project_id?: string }> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/deploy`);
}

// "Rebuild" — re-enters the build after it gave up (current_phase 'failed').
// 202 {ok, status:'rebuilding'}; 409 when the project isn't in that state.
export function rebuildBot(idOrSlug: string): Promise<{ ok?: boolean; status?: string }> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/rebuild`);
}

// ── Bot analytics (end-user usage of the DEPLOYED bot) ────────
// 404/405 → null; the usage card degrades to a friendly empty state.
export interface BotAnalytics {
  active_users?: number;
  messages_today?: number;
  delta_pct?: number;      // change vs. yesterday
  window?: string;
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

// ── Pause / resume the managed bot (server-owned `paused`) ────
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

// opt a bot in/out of the Discover feed (server-owned `discoverable`)
export function setDiscoverable(idOrSlug: string, on: boolean): Promise<unknown> {
  return request('PUT', `/builder/projects/${encodeURIComponent(idOrSlug)}/discoverable`, { discoverable: on });
}

// ── Regenerate the AI bot avatar (owner) ──────────────────────
// Async 202 → { accepted, status:'pending' }; the new bot_avatar_url lands on a
// later project poll.
export interface AvatarRegenResult {
  accepted?: boolean;
  status?: string; // 'pending'
}
export function regenerateBotAvatar(idOrSlug: string): Promise<AvatarRegenResult> {
  return request('POST', `/builder/projects/${encodeURIComponent(idOrSlug)}/avatar/regenerate`);
}

// Blueprint ("The plan") — the AI's structured read of the idea. GET
// /projects/:id/quality/blueprint (owner). 403/404/405 → null and the Plan
// screen shows a fallback. All fields optional — the viewer renders what's there.
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
