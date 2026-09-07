# Mini-app v2 — implementation spec

Branch: `feat/v2` (this repo). Backend counterpart: agnt-api `feat/v2`
(`docs/v2/v2-design.md` there). Product goal: a bot in **3 steps** — ① describe,
② tap *Create your bot*, ③ it's live, refine by chat — with the mini-app reading
as one conversation, not a wizard.

## 0. Ground truth you must honour

- The live pipeline is `build_pipeline=whole_bot` only. Every `task_manager` /
  `phase` code path is dead. agnt-api has **no** routes for `/dag`, `/tasks*`,
  `/blocked`, `/thread`, `/answer`, `/comments`, `/cancel`, `/reopen`, `/spec`,
  `/work-breakdown` — calls to them 404 in prod today (the overview fires two
  404s every tick). Delete every client function and screen that uses them.
- `src/App.tsx` is a 986-line state machine whose `'agent'` step is unreachable.
  Replace it with hash routing over the screens below.
- Server is the source of truth. The localStorage fallbacks `HIDDEN_KEY`,
  `MODE_KEY`, `PAUSED_KEY`, `DISCOVER_OPTOUT_KEY`, `THEME_KEY`/`useColorMode`
  duplicate live endpoints (DELETE /projects/:id, PUT /bot/pause,
  PUT /discoverable) and drift. Remove them. Keep only `agnt.lang` (i18n) and
  `PINNED_KEY` (pin order is client-only).
- `tgTheme` ignores its mode argument (one cream/terracotta palette). Keep the
  palette; remove the dead theme toggle.
- i18n is `t(en, ru)` with BOTH arguments required (tsc enforces). Every new
  string ships in English and Russian.
- Chat (`src/chat/Chat.tsx` `useChat`, `ChatThread`, `env.ts`, `markdown.tsx`)
  is correct and stays: cursor polling (1.2 s thinking / 4 s idle / 12 s
  background), optimistic sends, quick replies from the last assistant message
  with `options`, `multi_select` via `data`, env questions (`data.kind ===
  'env_request'`) rendered as a masked input, system events as `EventCard`.
- `manage/BotEnv.tsx` (bot keys) and `manage/Blueprint.tsx` (the plan) are
  live and stay. `manage/Discovery.tsx` stays. `manage/Activity.tsx` is
  dropped as a page; its `relTime` helper moves to `src/util/time.ts`.
- Do not touch agnt-api. Do not add dependencies (React 18 + Vite only).

## 1. Backend contract (v2, already on agnt-api `feat/v2`)

- `POST /builder/chat {message}` → `202 {project_id, status:'draft'}`. The
  first assistant turn (seconds later) **names the project**: `project.name`
  and `project.slug` change from `Untitled` / `draft-…` to real values, and the
  GitHub repo is provisioned in the background. The assistant asks **at most
  one** question (quick-reply `options`), or is ready immediately.
- Ready turn → `status: 'validating' → 'generating' → 'live'` with
  `current_phase: 'building'`. Owner-supplied keys are asked **in the same
  chat while the build runs** (env questions); they never block the build.
- A prohibited idea → `status: 'rejected'`, `rejection_reason` set, plus a
  system message `data.stage === 'policy_rejected'`. The chat is closed.
- `POST /projects/:id/bot/initiate` → `200 {deep_link, suggested_username,
  manager_bot}`. **409 `{error, retry: true}`** while the project is not
  named yet (first turn still running) — retry every 3 s. **409
  `{bot_username}`** when a bot already exists — just poll the bot.
  The endpoint works during `draft`; that is the point: the owner taps *Create
  your bot* while the intake/build runs.
- `GET /projects/:id/bot` → `{bot_username, container_state, paused, …}`;
  `botIsLive()` (client.ts) is the "answering users" signal. The scaffold
  deploys ~1 min after the token is captured, so a bot can be live *before*
  the build finishes; the status line must say so ("Live · still building").
- Project DTO (`GET /projects/:id`) new optional stamps: `brief_ready_at`,
  `first_pass_at`, `first_merge_at`, `preview_live_at`. `bot_go_live_at` and
  `published_at` are now really stamped. `build_progress` unchanged
  (`stage`, `stage_label`, `percent`, `eta_seconds`, `passes[]`); the stage
  label is server-owned and localized — render it, do not re-derive it from
  system messages.
- Post-build chat: every owner message on a built bot is a change request or a
  question (server decides); while a build runs the server answers "send it
  again once live". No client-side gating needed beyond disabling the composer
  when `ai_thinking`.
- Everything else (`/projects`, `/projects/discover`, `/bot/pause`,
  `/discoverable`, `DELETE /projects/:id`, `/bot/env*`, `/quality/blueprint`,
  `/analytics`, `/avatar/regenerate`, `/deploy` retry, `/auth/telegram`) is
  unchanged.

## 2. Screens

### Home — `#/`
- Top: brand row (Wordmark left, language toggle right — keep the existing
  lang switch if there is one; else none).
- Hero + idea box = today's `PromptScreen` (keep `IDEA_EXAMPLES` chips and the
  hero copy). Primary button **Build it / Собрать**. Disabled with "Open in
  Telegram to build" outside Telegram when unauthenticated (as today).
- Send → `startChat` → navigate to `#/bots/<project_id>` immediately. No
  clarify screen: the Bot page IS the conversation.
- Below the box: **My bots** — compact list (avatar/monogram, name, one-line
  status pill, tap → Bot page). Swipe-to-delete / pin from today's `MyBots`
  stay (delete calls `DELETE /projects/:id`, then refetch — no HIDDEN_KEY).
  Empty state: one friendly line.
- Tab bar: **Home** · **Discover** (two tabs; drop the third and the ＋).

### Bot — `#/bots/<id>` (chat-first; one screen for draft, building, live, rejected)
Layout top → bottom, all inside one scroll with the composer pinned at the
bottom (Telegram main-button area respected as today):

1. **Header card**
   - Avatar (`bot_avatar_url` or monogram), name, and `@username` when the bot
     exists.
   - **Status line**: exactly one server-owned string — `build_progress.stage_label`
     when present, else derived from status: draft → "Tell me what to build" /
     rejected → "Can't build this one" / live+published → "Live". Show
     `percent` as a thin progress bar while building. Never show pass numbers
     or PR numbers; the owner is non-technical.
   - **Primary action** (one button, priority order):
     a. `status === 'rejected'` → *Start a new bot* → `#/`.
     b. no `bot_username` → **Create your bot** (subtitle: "One tap in Telegram
        — no BotFather, no tokens. Your bot answers while we build."). On tap:
        `initiateBot` → open `deep_link`; on 409 `retry:true` show "Naming your
        bot…" and retry every 3 s (max ~2 min); on 409 `bot_username` start the
        bot poll. While waiting for Telegram: spinner + "Finishing in
        Telegram…" and poll `GET /bot` every 5 s until `bot_username`.
     c. bot exists → **Open @username** (`openTgLink('https://t.me/'+username)`).
   - Secondary row (bot exists): *Pause/Resume* (PUT /bot/pause, from server
     `paused`), *Keys* (→ `#/bots/<id>/env`), *Plan* (→ `#/bots/<id>/plan`),
     *…* overflow sheet: *Show in Discover* toggle (PUT /discoverable, from
     server `discoverable`), *Regenerate avatar*, *Retry deploy* (only when the
     latest deployment failed), *Delete bot* (ConfirmSheet → DELETE → `#/`).
2. **Usage tiles** (only when live): today's three tiles + sparkline, compact.
3. **Chat thread** — `ChatThread` over `useChat(projectId, true, focused)`:
   the intake question(s), env questions, build events, and post-build
   conversation are ONE thread (same endpoint). Rules:
   - While `status === 'draft'` and the last assistant message is a question
     with options, render the quick replies **plus a persistent escape chip**
     "✨ Just build it — you decide the rest / ✨ Просто собери — реши сам" that
     sends exactly the text `Decide everything else yourself with sensible
     defaults and start building.` (the server recognises deferral in any
     wording; this phrase is what the old "Good enough" button sent).
   - Env questions render as today (masked input, lock caption, Skip chip).
   - Build events (`role: 'system'`) render as `EventCard`s; keep the
     kind→palette map; drop the task/DAG kinds.
   - `status === 'rejected'`: show the rejection card, hide the composer.
   - Composer placeholder: draft → "Describe the bot…"; building → "Ask or
     request a change — I'll apply it once it's live"; live → "Ask for a
     change…".
4. Polling: `getProject` every 4 s while `draft`/building, 20 s when live or
   rejected; `getProjectBot` every 5 s until a bot exists, then 20 s; analytics
   once per open + every 60 s when live. Stop all timers on unmount.

### Keys — `#/bots/<id>/env` (existing `BotEnv.tsx`, unchanged)
### Plan — `#/bots/<id>/plan` (existing `Blueprint.tsx`, unchanged)
### Discover — `#/discover` (existing `Discovery.tsx`, unchanged)

Back button (Telegram native + in-browser header): Bot → Home; Keys/Plan → Bot.
Legacy hashes: `#/build/<id>` → redirect to `#/bots/<id>`; `#/bots/<id>/chat|activity|board|taskboard|inbox` → `#/bots/<id>`.

## 3. Delete list (must be gone)
`src/manage/DagBoard.tsx`, `TaskDetail.tsx`, `TaskManagerBoard.tsx`,
`TaskManagerInbox.tsx`, `src/screens/Agent.tsx`, `src/screens/Clarify.tsx`
(folded into the Bot page), `src/manage/Activity.tsx` (page), `ui.Stepper`,
`ui.TabBar`'s third tab, and in `client.ts`: `TaskItem`, `ClaimerBrief`,
`TaskDetail`, `getTaskDetail`, `TaskList`, `listProjectTasks`, `DagTask`,
`isTaskManagerDag`, `getProjectPipeline`, `DagInfo`, `ProjectDag`,
`getProjectDag`, `UnifiedTasks`, `fetchProjectTasks`, `TaskComment`,
`getTaskThread`, `answerQuestion`, `addTaskComment`, `cancelTask`,
`reopenTask`, `BlockedItem`, `getBlockedItems`, `getProjectSpec`,
`publishProject`, `setBuildModeApi`/`BuildMode`, `mintAgentLink`,
`getAgentLink`, `AgentLinkCode`, `AgentLinkStatus`, `runCloudAgent`,
`getCloudAgent`, `CloudRun`, `CloudAgentStatus`, `setAutoMerge`,
`AutoMergeResult`, `postFeedback` (chat replaces it), and the `isTaskManager`
field on `MyBot`.
Keep `retryDeploy`, `listDeployments` (for the failed-deploy state),
`regenerateBotAvatar`, `getBotAnalytics`, `getBlueprint`, `getBotEnv`/`set`/`delete`.

## 4. Acceptance (the reviewer will check every line)
- `npx tsc -b --pretty false` → exit 0, no output. `npm run build` succeeds.
- `grep -rn` over `src/` finds none of: `/dag`, `/tasks`, `/blocked`,
  `/thread`, `/answer`, `/comments`, `/cancel`, `/reopen`, `/spec`,
  `/agent-link`, `/build-mode`, `/publish`, `/auto-merge`, `/feedback`,
  `isTaskManager`, `task_manager`, `HIDDEN_KEY`, `MODE_KEY`, `PAUSED_KEY`,
  `DISCOVER_OPTOUT_KEY`, `THEME_KEY`, `useColorMode`.
- `src/App.tsx` ≤ 350 lines; total `src/` LOC at least 40 % below 7 869.
- Every user-facing string goes through `t(en, ru)` / `tr()`.
- The three-step flow works against the contract in §1 with the UI's own
  polling (no reliance on removed endpoints), including: the create-bot 409
  retry, the rejected state, the env question mid-build, and a bot that is
  live before `published`.
- Commit on `feat/v2` with message `feat(v2): three-step mini-app — Home, Bot (chat-first), Discover`.
