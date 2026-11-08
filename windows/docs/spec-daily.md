# Spec: Daily standup / Daily recap, Daily Brief, Day goals

Source of truth: `Dayflow/Dayflow` (Swift). Files studied:
`Core/AI/DailyRecap{Generator,Models,Scheduler,AttemptBudget}.swift`,
`Core/DailyBrief/*`, `Core/Recording/StorageManager+DailyStandup.swift`,
`StorageManager+DayGoals.swift`, `StorageManager+TimelineCards.swift` (helpers),
`Models/DayGoalPlan.swift`, `Views/Components/DaySummaryStats.swift`, `DaySummaryView.swift`,
`DayGoalHeader.swift`, `Views/UI/DailyView*.swift`, `Views/UI/DailyBrief/**`,
`Core/AI/ChatCLIProcessRunner.swift` (Claude CLI flags), `MainView/Lifecycle.swift`.

Conventions used below:
- **Logical day** = a day that runs 4:00 AM to 4:00 AM local time. Its key is `yyyy-MM-dd`, taken
  from the 4 AM start. Before 4 AM you are still in the previous logical day
  (`getDayInfoFor4AMBoundary`).
- A card's `startTimestamp`/`endTimestamp` are display strings like `"9:05 AM"` (format `h:mm a`).
  `start_ts`/`end_ts` are unix seconds in the DB.
- "Cards for day D" (`fetchTimelineCards(forDay:)`) means non-deleted `timeline_cards` with
  `start_ts` in [D 04:00, D+1 04:00).
- **Placeholders**: the `${NAME}` placeholders are Swift `\( )` interpolations. The `{{NAME}}`
  placeholders are literal template slots that the Daily Brief fills at run time. Both are explained
  next to each prompt.

---------------------------------------------------------------------------------------------------

## 1. What the features do for the user

### 1a. Daily standup / Daily recap ("Daily" tab)

- This is a tab called **Daily**. It holds a per-day visual "workflow grid" and a **standup card**
  with three editable sections: *Highlights from <source day>*, *Tasks for <target day>*, and
  *Blockers*.
- **Target day vs source day.** The standup is stored under the day you are viewing (the target
  day). Its content comes from an earlier **source day**: the most recent of the previous 1 to 3
  logical days that (a) has enough recorded activity and (b) has not already been used as the
  source of another stored standup. On Monday, for example, Friday can be used when the weekend was
  empty.
- **Automatic generation.** It runs once per logical day, at or after 4 AM, for today's target day.
  A background check runs at app startup and then every 5 minutes. There are at most 3 automatic
  attempts per target day, and the count survives restarts. When a run succeeds, the app shows an OS
  notification: "Your daily recap for yesterday is ready" / "Tap to open it in Daily view."
- **Manual "Regenerate" button.** It regenerates the viewed day's standup from its source day. The
  button cycles through these states: Regenerate → "Regenerating..." (animated dots) → "Regenerated"
  or "No data", then goes back to idle after 2 s.
- **Inputs.** For every provider the input is the source day's timeline cards (title + summary +
  times). The hosted Dayflow backend also gets that day's observations, the 3 most recently updated
  prior standups, and the section titles.
- **Output.**
  - Local, Gemini, and CLI providers return 0 to 5 "done" bullets (shown as highlights) and an
    optional single "next" bullet (shown as tasks). Blockers stay empty.
  - The Dayflow backend returns highlights, unfinished items (shown as tasks), and blockers.
- **Fully user-editable.** The user can edit bullet text inline, add items ("Add item"), and
  drag-reorder items. An empty item is removed when it loses focus. The blockers title and body are
  editable too. Edits are debounced by 250 ms and upserted into `daily_standup_entries`.
- **"Copy" button.** It copies a plain-text standup to the clipboard (format in §3a.8), and the
  button shows "Copied" for 2 s.
- **Placeholder texts** appear when nothing is stored:
  - "not generated yet"
  - "Not enough captured activity in the previous 3 days…"
  - "No Daily provider is selected…"

  Placeholders are never persisted and never copied.
- **Gating.** The tab is locked until 5 h of analyzed recording exist, counted as 20 analysis
  batches of 15 min. Unlocking also needs notification permission and a provider choice. The unlock
  sets `isDailyUnlocked=true`. The automatic scheduler does nothing while that flag is false.
- **Provider picker** (gear button). Options are Dayflow backend, Claude (CLI), ChatGPT (Codex
  CLI), Gemini (API key), Local (Ollama/LM Studio), and None.
  - An option is disabled when it is unavailable: no key, CLI not installed, or local not
    configured.
  - "None" turns generation off.

### 1b. Daily Brief (morning page over the Timeline)

- This is a **morning page** that pops up over the Timeline tab. It contains a "Daybreak" header
  with the date, a docket ("Take these off your plate" / internally "Spring"), and up to 6 other
  sections. The model chooses which sections appear and their order.
  - **Docket** ("Your docket today"): 4–6 tasks. Each task is a card with a title, detail, people,
    links, feedback from colleagues, and a ready-to-send **prompt for an AI agent**. The user can
    swipe the card right to **hand it off** or left to **dismiss** it.
    - Hand-off has two modes. **Paste** copies the prompt, opens the Claude or ChatGPT desktop app,
      and presses Cmd+V. **Run** runs `claude -p` or `codex exec` in the background in a chosen
      folder.
    - The docket has a card-stack view and a list view, and tracks a status for each task (New /
      Dismissed / In progress / Ready / Reviewed / Failed).
    - Dismissing a task asks for an optional reason.
  - **Keep tracking**: ongoing things with a current state (a metric or a status).
  - **What you completed yesterday**: 1–4 accomplishments, each with a screenshot from the card.
  - **Key team decisions**: taken from connectors such as Slack or notes.
  - **Related to your interests**: 2–6 articles with an intro line and og:image.
  - **Latest in your industry**: 1–3 headlines from the last 48 h.
  - **Recent site-seeing**: 3–8 visually interesting screenshots from yesterday, each with a
    caption. Images can be enlarged and saved to a "Saved" gallery.
- **Generated once per logical day.** Generation starts automatically on app launch, when the app
  becomes active, and on the 5-minute recap timer. It runs only when the previous logical day has
  at least 60 min of non-System recorded activity. There are at most 2 automatic attempts per day.
  A **Retry** button regenerates on demand and ignores the attempt limit.
- **Engine.** It always runs **Claude Code CLI** (`claude -p`, model `opus`), with no provider
  choice.
  - Two runs go **in parallel**: the *docket* run and the *extras* run (all other sections).
  - Both runs get web search/fetch, Dayflow's own MCP server (read-only tools), and the user's own
    Claude connectors. Connectors are forced read-only by a PreToolUse hook.
  - Only the extras run can Read the candidate screenshots.
  - Each run has a 20-minute timeout.
- **Inputs** are all from the previous logical day: non-idle, non-System cards (cardId, times,
  category, title, summary, apps). The docket run also gets each card's detailed minute-by-minute
  lines. The runs also get:
  - the user's categories with their descriptions;
  - 21 days of feedback events (opened / saved / dismissed / checked / expanded);
  - the items from the 5 most recent briefs, so items are not repeated;
  - the user's free-text "Override instructions";
  - optional full prompt overrides, edited in the "Edit prompt" editor.
- **When it finishes**, a "your brief is ready" notice card appears under the menu-bar icon. This
  happens only for automatic runs, and only when the brief is not already on screen.
  - The brief **auto-presents** the next time the Timeline is opened, if it hasn't been shown yet
    (`userState.hasBeenShown`).
  - Users who get the brief do not get the Day-goal pop-up.
- **Per-day user state** is saved with the brief: checked and dismissed items, tasks the user added,
  prompt edits, the folder for each task, and the hand-off history.
- **"Everything you completed".** This shows every `completed_yesterday` item from all stored
  briefs, grouped by day.
  - "Summarize for my review" asks Claude for a summary over a range (Last 7 days / Last 30 days /
    Quarter to date / Year to date). The summary has an overview, milestones, and projects.
- **Debug footer.** It shows run stats (duration, model, cost, tokens, turns, tool calls, number of
  cards and candidates) and the reason any part failed. It also offers per-part transcripts, Retry,
  "Override instructions", and "Edit prompt".
- **Access.** The feature is gated to an email allowlist of signed-in Dayflow accounts (§7).

### 1c. Day goals (right panel of the Timeline)

- "Today's targets" header with a **Focus** progress bar (`X / Y hr fulfilled`) and a **Distraction
  budget** bar (`remaining / limit`, or `used / limit used` once over).
- The user picks which categories count as focus and which count as distraction, and sets the two
  targets in hours (0–12) plus minutes (step 5).
- A daily **goal flow pop-up** appears once per day. It shows "Yesterday's review" (focus and
  distraction actuals against yesterday's plan) and then setup ("Where do you want to spend your
  time today?"). The setup shows reference stats: yesterday's minutes and the 7-day average for the
  chosen categories. The user can Skip.

---------------------------------------------------------------------------------------------------

## 2. Data model

### 2a. SQLite tables

```sql
CREATE TABLE IF NOT EXISTS daily_standup_entries (
    standup_day TEXT NOT NULL PRIMARY KEY,          -- target logical day yyyy-MM-dd
    payload_json TEXT NOT NULL,                     -- DailyStandupDraft JSON (below)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_daily_standup_entries_created_at ON daily_standup_entries(created_at DESC);

CREATE TABLE IF NOT EXISTS day_goals (
    day TEXT NOT NULL PRIMARY KEY,                  -- logical day yyyy-MM-dd
    focus_target_minutes INTEGER NOT NULL,
    distraction_limit_minutes INTEGER NOT NULL,
    is_skipped INTEGER NOT NULL DEFAULT 0,          -- migration adds it if missing
    created_at INTEGER NOT NULL,                    -- unix seconds
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_day_goals_updated_at ON day_goals(updated_at DESC);

CREATE TABLE IF NOT EXISTS day_goal_categories (
    day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('focus', 'distraction')),
    category_id TEXT NOT NULL,                      -- TimelineCategory UUID string
    category_name TEXT NOT NULL,                    -- snapshot of name at save time
    category_color_hex TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (day, kind, category_id)
);
CREATE INDEX IF NOT EXISTS idx_day_goal_categories_day_kind ON day_goal_categories(day, kind, sort_order);
```

**daily_standup_entries operations**
- `saveDailyStandup(day, json)`:
  `INSERT … VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(standup_day) DO UPDATE SET payload_json=excluded.payload_json, updated_at=CURRENT_TIMESTAMP`.
- `fetchDailyStandup(day)`: `WHERE standup_day = ?`.
- `fetchRecentDailyStandups(limit, excludingDay)`: `WHERE standup_day != ? ORDER BY updated_at DESC LIMIT ?`.
  It supplies the prior-standup context for the Dayflow backend.
- `fetchAllDailyStandups(excludingDay)`: `ORDER BY standup_day DESC`. It is used to compute the
  *consumed source days*: every `generation.sourceDay` decoded from the other rows' payloads.
- `fetchLatestDailyStandupDay()`: `ORDER BY standup_day DESC LIMIT 1` (unused by the flows above).

**day_goals operations**
- `saveDayGoalPlan(plan)` runs as one transaction:
  1. Upsert `day_goals`. `created_at` is kept from the plan if > 0, otherwise set to now.
     `updated_at` is set to now.
  2. `DELETE FROM day_goal_categories WHERE day=?`.
  3. Insert the focus categories, then the distraction categories, with
     `sort_order` = index within the kind.
- `fetchDayGoalPlan(day)` reads one row plus its categories
  (`ORDER BY kind, sort_order`).
- `fetchMostRecentDayGoalPlan(beforeOrOn: day)`: `WHERE day <= ? ORDER BY day DESC LIMIT 1`. This
  is used for carry-forward.
- `countDistinctTimelineDays(excludingDay)`:
  `SELECT COUNT(DISTINCT day) FROM timeline_cards WHERE is_deleted=0 AND day != ?`.
- `consecutiveSkippedDayGoalCount(before: day, limit)`: reads up to `limit` rows of
  `SELECT is_skipped FROM day_goals WHERE day < ? ORDER BY day DESC LIMIT ?` and counts leading 1s.

**Timeline helpers used**
- `hasMinimumTimelineActivity(day, minimumMinutes)`:
  `SELECT COALESCE(SUM(end_ts - start_ts),0)/60 FROM timeline_cards WHERE start_ts >= D04:00 AND start_ts < D+1 04:00 AND is_deleted=0`,
  then `>= minimumMinutes`. Note that this sum **includes** System cards.
- `fetchTotalMinutesTracked(from,to)`: the same sum in seconds / 60.0, plus
  `AND category != 'System'`. The Brief uses it.
- `fetchObservations(startTs,endTs)`: used for the Dayflow backend only.

### 2b. Standup payload (`payload_json`), `DailyStandupDraft`

Swift `JSONEncoder` defaults apply: camelCase keys, nil optionals omitted, UUIDs as uppercase
strings, and **Dates as a Double of seconds since 2001-01-01 (Apple reference date)**. Use the same
date encoding if the DB is shared with macOS. Otherwise ISO-8601 is fine.

```ts
interface DailyStandupDraft {
  highlightsTitle: string;          // "Yesterday's highlights" (stored default; UI shows computed titles)
  highlights: DailyBulletItem[];
  tasksTitle: string;               // "Today's tasks"
  tasks: DailyBulletItem[];
  blockersTitle: string;            // "Blockers"
  blockersBody: string;             // newline-separated blockers ("" for non-backend providers)
  generation?: DailyStandupGenerationMetadata;   // absent on legacy rows => treat as {provider:"dayflow"}
}
interface DailyBulletItem { id: string /*UUID*/; text: string }
interface DailyStandupGenerationMetadata {
  provider: "dayflow"|"local"|"gemini"|"chatgpt"|"claude"|"none";
  runtime: string;        // dayflow_backend | local_llm | gemini_direct | chat_cli | disabled
  modelOrTool?: string;   // local model id | gemini model id | "gpt-6.1-sol"/"gpt-5.6-sol" | "opus"
  sourceDay?: string;     // yyyy-MM-dd the content was built from  (KEY for source-day consumption)
  generatedAt?: Date;
}
```
`hasGeneratedContent` is true when `highlights` is non-empty, `tasks` is non-empty, or the trimmed
`blockersBody` is non-empty.

Placeholder drafts are never saved. They use these exact strings:
- notGenerated: `Daily data has not been generated yet. If this is unexpected, please report a bug.`
- todayNotGenerated: `Today's daily recap will be generated tomorrow morning.` (defined, unused)
- insufficientHistory: `Not enough captured activity in the previous 3 days to generate a standup.`
  The titles become "Recent highlights" / "Tasks".
- noProviderSelected: `No Daily provider is selected. Click the gear button above, then choose a provider to turn recap generation back on.`

Each placeholder puts its message as the single highlight, the single task, and the blockersBody.

Settings (UserDefaults → Electron store):
- `dailyRecapProvider_v1`
  - Migration when unset: if `isDailyUnlocked` is true, use dayflow. Otherwise map the primary LLM
    provider: gemini→gemini, chatGPT→chatgpt, claude→claude, local→local, openAICompatible→none.
    If nothing is configured, use none.
- `dailyRecapAutomaticAttempts_v1 = {day, count}`.
- `isDailyUnlocked`.

### 2c. Daily Brief storage (files, not DB)

The root is `~/Library/Application Support/Dayflow/daily_brief/`. On Windows, use
`%APPDATA%/Dayflow/daily_brief/`. It contains:
```
<day>/brief.json                 DailyBrief (one per logical day)
<day>/images/<cardId>_<HHmm>.jpg copied screenshots used by completed_yesterday / site_seeing
<day>/transcript-docket.txt      readable transcript of the last docket run
<day>/transcript-extras.txt
<day>/handoffs/<slug>-<unix>.txt (+ .prompt, .exit)  background agent runs
saved/saved.json + saved/<day>_images_<file>.jpg     "Saved" images
feedback.json                    DailyBriefFeedbackEvent[] (capped at 2000, oldest dropped)
summaries/<range>.json           latest DailyBriefRangeSummary per range
```
JSON is written with ISO-8601 dates, pretty-printed, sorted keys, and atomic writes. Every decode
is tolerant: missing keys fall back to defaults.

`loadAllBriefs()` lists the folder names that are 10 characters long and start with a digit, sorts
them descending, and decodes each one's `brief.json`.

```ts
interface DailyBrief {
  day: string;            // logical day the brief is FOR (today)
  sourceDay: string;      // day whose activity it was built from (yesterday)
  generatedAt: string;    // ISO date
  content: DailyBriefContent;
  userState: DailyBriefUserState;
  stats?: DailyBriefRunStats;
}
// Section keys are snake_case; item fields camelCase.
interface DailyBriefContent {
  order: string[];                       // section keys best-first; docket always first if present
  docket?: DocketItem[];
  keep_tracking?: { label: string; status: string; app?: string; asOf?: string; url?: string }[];
  completed_yesterday?: { project?: string; title: string; apps?: string[]; cardId?: number;
                          imageFile?: string /* "images/<file>", set by app */ }[];
  team_decisions?: { decision: string; date?: string; people?: string[]; place?: string; app?: string; url?: string }[];
  related_reading_intro?: string;
  related_reading?: { title: string; source?: string; url: string; reason?: string; imageUrl?: string }[];
  industry_news?: { headline: string; source?: string; url: string; published?: string }[];
  site_seeing?: { file: string /* "images/<file>" after cleaning */; caption?: string }[];
}
interface DocketItem {
  title: string; detail?: string; due?: string /*yyyy-MM-dd*/;
  people?: { name: string; note?: string }[];
  links?: { title: string; url?: string; app?: string /*lowercase*/ }[];
  prompt?: string; agent?: boolean;
  feedback?: { name: string; source?: string; text: string; url?: string }[];
  feedbackSummary?: string; feedbackUrl?: string; attach?: string[] /* link titles */;
}
interface DailyBriefUserState {
  checkedItemKeys: string[]; dismissedItemKeys: string[];   // key = `${sectionKey}|${title}`
  addedTasks: { id: string; title: string }[];
  hasBeenShown: boolean;
  promptEdits: Record<string /*docket title*/, string>;      // removed when equal to original
  folders: Record<string /*docket title*/, string /* "" = no folder */>;
  handoffs: { title: string; dismissed: boolean; agent?: "claude"|"chatgpt"; method?: "paste"|"run";
              at: string; reason?: string; reviewed: boolean; outputFile?: string;
              finishedAt?: string; failed: boolean }[];      // last entry per title wins
}
interface DailyBriefRunStats {
  durationSeconds: number; model?: string; costUSD?: number; inputTokens?: number; outputTokens?: number;
  cacheReadTokens?: number; numTurns?: number; toolCalls?: Record<string, number>;
  cardCount?: number; candidateImageCount?: number; promptCharacters?: number;
  usedPromptOverride: boolean; usedOverrideInstructions: boolean; trigger?: string;
  failedParts?: Record<"docket"|"extras", string>;
}
interface DailyBriefFeedbackEvent { day: string; section: string; itemTitle: string;
  action: "opened"|"saved"|"dismissed"|"checked"|"expanded"; at: string }
interface DailyBriefSavedItem { id: string; savedAt: string; imageFile: string; caption?: string; sourceDay: string }
interface DailyBriefRangeSummary { range: "last_7_days"|"last_30_days"|"quarter_to_date"|"year_to_date";
  startDay: string; endDay: string; generatedAt: string; overview: string; milestones: string[];
  projects: { title: string; bullets: string[]; impact?: string; imageFile?: string /* "<briefDay>/images/x.jpg" */ }[] }
```

**Section display titles**

| Key | Title |
|---|---|
| docket | Your docket today |
| keep_tracking | Keep tracking |
| completed_yesterday | What you completed yesterday |
| team_decisions | Key team decisions |
| related_reading | Related to your interests |
| industry_news | Latest in your industry |
| site_seeing | Recent site-seeing |

**Render order** (`orderedKinds`): the known, non-empty sections in `order`, deduplicated. Any
non-empty section missing from `order` is appended in the enum order above.

**Brief settings keys**
- `dailyBriefOverrideInstructions`
- `dailyBriefPromptOverride.docket`, `dailyBriefPromptOverride.extras`
- `dailyBriefAutomaticAttempts = {[day]: count}`, which keeps only the current day
- `dailyBriefDocketAgent` (claude|chatgpt, default claude)
- `dailyBriefDocketHandoffMethod` (paste|run, default paste)
- `dailyBriefDocketShowsList`
- `dailyBriefDocketPickedFolders` (max 5)

### 2d. Day goal model

```ts
interface DayGoalPlan { day: string; focusTargetMinutes: number; distractionLimitMinutes: number;
  focusCategories: DayGoalCategorySnapshot[]; distractionCategories: DayGoalCategorySnapshot[];
  isSkipped: boolean; createdAt: number; updatedAt: number }
interface DayGoalCategorySnapshot { categoryID: string; name: string; colorHex: string; sortOrder: number }
```
- `showDailyGoalPopups` (default true) is a user setting.
- The UserDefaults keys `dailyGoalPromptHandledDay` and `dayGoalReviewShownTimelineDay` record which
  day was already prompted or reviewed.

---------------------------------------------------------------------------------------------------

## 3. Generation pipelines

### 3a. Daily recap (standup)

**3a.1 Scheduler (automatic).** It starts at app launch. The first check runs immediately, then a
check runs every 5 minutes. Only one check can be in flight at a time.

Each check does the following:
1. Return if `isDailyUnlocked` is false.
2. Return if the local hour is less than 4.
3. Set `targetDay` to today's logical day. Return if a row already exists for `targetDay`.
   **Rows are never auto-regenerated.**
4. Resolve the source day with **minimum activity 180 min**: see 3a.2. Return if none is found.
5. Read the provider. Return (with an analytics "skipped" event) if the provider is `none` or
   unavailable. Availability means:
   - gemini: key present in the keychain;
   - chatgpt: `codex` on PATH;
   - claude: `claude` on PATH;
   - local: `ollamaSetupComplete`, or both base URL and model id set;
   - dayflow: always available.
6. Reserve an attempt in the budget. Return if 3 attempts have already been used for `targetDay`.
   The reservation happens **before** generation, so crashes and failures also count.
7. Gather the inputs:
   - cards for `sourceDay`;
   - for the Dayflow backend only: observations in [sourceStart, sourceEnd), and
     `fetchRecentDailyStandups(limit 3, excludingDay: sourceDay)`.
8. Call `generate(context)` (3a.3). On success, encode the draft and upsert it under **targetDay**.
   Re-read the row to verify the save, then post the OS notification `daily.recap.<day>`. The
   notification asks for permission if needed and carries `userInfo.day`.
9. On failure, only analytics run. The next 5-minute tick retries until the budget is exhausted.

**3a.2 Source-day resolution** (`DailyRecapSourceDayResolver`):
```
consumed = { payload.generation.sourceDay  for every standup row except targetDay's }
for offset in 1...3:
  d = targetStart(4AM) - offset days ; key = yyyy-MM-dd(d)
  if key ∉ consumed and hasMinimumTimelineActivity(key, minMinutes): return (key, d, d+1day)
return nil
```
The scheduler uses `minMinutes=180`. The Daily view (display and Regenerate) uses `minMinutes=120`.
Keep this difference or unify it deliberately.

**3a.3 `generate(context)`**
- Throws `emptyCards` when there are no cards.
- Builds the metadata `{provider, runtime, modelOrTool, sourceDay, generatedAt: now}`.
- Dispatches on the provider:

| Provider | Call | Prompt |
|---|---|---|
| dayflow | `POST` to the hosted backend `generateDaily` with `{day, cardsText, observationsText, priorDailyText, preferencesText, preferredOutputLanguage}`, returning `{day, highlights[], unfinished[], blockers[]}` | server-side (not in app) |
| gemini | Gemini `generateContent`, `maxOutputTokens 8192`, `thinkingConfig.thinkingLevel "high"`, the provider's internal retry (4 attempts, model fallback chain), 120 s HTTP timeout | `makeLocalPrompt(provider: nil)` → **localPrompt** |
| local | Ollama / LM Studio text call, `maxTokens 8192`, provider's internal retries (3) | **localPrompt** |
| claude | `claude -p --output-format json --model opus --allowedTools '[]' --strict-mcp-config -- <prompt>` (tools disabled, no effort flag) | **evidencePrompt** |
| chatgpt | `codex exec`, model `gpt-6.1-sol`, reasoning effort `low`, tools disabled. On any non-cancel error, retry once with `gpt-5.6-sol` and record that model in metadata | **evidencePrompt + solEvidenceRules** |
| none | throws `noProviderSelected` | – |

**3a.4 Text formats**

`makeCardsText(day, cards)`. Cards are sorted by `startTimestamp`, then `endTimestamp` (string
compare as in Swift). With no cards the output is `No timeline activities were recorded for ${day}.`
Otherwise:
```
Timeline activities for ${day}:

1. 9:05am - 10:20am: <title, or summary if title empty, or "Untitled activity">
   <summary, only if non-empty and != title; indented 3 spaces>
2. ...
```
The time format is `h:mm` followed by `am`/`pm` in lowercase with no space. It is parsed from
`"9:05 AM"`. An unparseable value is lowercased as is.

`makeObservationsText` (backend only):
```
Observations for ${day}:

9:05am - 9:20am: <observation text>
```
Empty observations are skipped. When there are none, the output is
`No observations were recorded for ${day}.`

`makePriorDailyText` (backend only) is `Day ${standupDay}:\n${payload_json}` blocks joined by a
blank line.

`makePreferencesText` is
`{"blockers_title":"Blockers","highlights_title":"Yesterday's highlights","tasks_title":"Today's tasks"}`
(sorted keys).

`preferredOutputLanguage`: the user override (`llmOutputLanguageOverride`). When there is no
override, the UI locale decides: zh-Hans → Simplified Chinese, zh-Hant → Traditional Chinese,
ko → Korean, de → German, ru → Russian, fr → French, ja → Japanese. Any other locale gives null.

**3a.5 Parsing** (all providers except the backend)
1. Trim the response. If it contains `---END_THINKING---`, keep only what follows. (The Claude
   provider prepends a `---THINKING---…---END_THINKING---` block when stderr has thinking.)
2. If the response starts with ```` ``` ````, drop the first line and the last `\n```` fence.
3. Extract the **first balanced `{…}` object**. The scanner tracks strings and escapes. If no object
   is found, use the whole cleaned text.
4. `JSON.parse` it. If the result is not an object, throw `invalidJSONResponse(raw)`.
5. If the object has neither `done` nor `next`, throw `invalidResponseShape(raw)`.
6. `done`: an array, or a scalar wrapped into an array. Map each element through `normalizeScalar`:
   strings and numbers are trimmed, and empty strings or `"null"` (case-insensitive) are dropped.
   Remove duplicates while keeping order, then keep the **first 5**.
7. `next`: JSON null gives null. An array gives its first valid scalar. A scalar is normalized.
8. Draft:
   - `highlights` = done items;
   - `tasks` = `[next]` or `[]`;
   - `blockersBody` = "";
   - titles are "Yesterday's highlights", "Today's tasks", "Blockers".

   If `hasGeneratedContent` is false, throw `emptyGeneratedContent`.

For the backend: highlights, unfinished, and blockers are trimmed, emptied entries dropped, and
duplicates removed. `blockersBody` is the blockers joined with "\n". Throw if everything is empty.

There is **no retry inside `generate`** apart from the ChatGPT model fallback and the providers'
own transport retries. The scheduler's 3-attempt budget is the retry mechanism.

**3a.6 Manual Regenerate (Daily view)**
1. Target = the viewed logical day.
2. If the provider is none, show the noProviderSelected placeholder.
3. Source = the day already resolved for the view, else resolve it (min 120 min). If there is none,
   show "No data".
4. Fetch the cards. If there are none, show "No data".
5. Build the same context with the stored-default titles.
6. Generate and **upsert under the target day**. This replaces the row and any user edits.
7. Update the view and post the notification.

Changing the viewed day cancels an in-flight regeneration. Regenerate is unaffected by the
attempt budget.

**3a.7 Loading in the view**
- When a row exists, decode it. A missing `generation` is set to legacy dayflow.
- When no row exists, show a placeholder:
  - provider none → noProviderSelected;
  - no resolvable source day → insufficientHistory;
  - otherwise → default ("not generated yet").
- UI section titles are computed, not taken from the payload:
  - `Highlights from <label(sourceDay)>`, or "Recent highlights" when there is no source day;
  - `Tasks for <label(targetDay)>`;
  - `Blockers`.

  The label is "Today", "Yesterday", a weekday name for 2–6 days ago, or a date otherwise. The card
  heading is `Standup for <date title>`.
- Edits are saved after a 250 ms debounce. Nothing is saved for the noProviderSelected draft, or for
  the default or insufficientHistory placeholders when no row exists.

**3a.8 Clipboard text**
```
${highlightsTitle}
- item            (or "- None right now")

${tasksTitle}
- item

${blockersTitle}
- line            (blockersBody split on newlines)
```
Placeholder messages are filtered out, compared case-insensitively.

**3a.9 Daily view workflow grid (summary only)**
- The grid uses the viewed day's cards with System cards removed. Rows are categories in user order,
  followed by unknown categories used that day. Columns are 15-minute slots. The window runs from
  the floor-hour of the first card to the ceil-hour of the last card, and is at least 9:00–21:00.
  Each cell's opacity is its slot occupancy.
- Stat chips:
  - **Context switched**: the number of times a card's category differs from the previous card's.
  - **Interrupted**: the number of cards with non-empty `distractions`.
  - **Focused for**: the minutes of non-idle categories.
  - **Distracted for**: the minutes of categories flagged `isIdle`.
  - **Transitioning time**: the sum of gaps between consecutive cards.
- Per-category totals are listed as well.

### 3b. Daily Brief

**3b.1 Triggers** (`DailyBriefStore.runIfNeeded(trigger)`)

The triggers are `"launch"` (main view appears), `"app_active"` (the app becomes active), and
`"timer"` (the 5-minute recap tick).

The guards, in order:
1. The feature is enabled (allowlist).
2. No run is in progress.
3. Today's brief does not exist (`brief.day != today`).
4. `automaticAttempts[today] < 2`.
5. Previous logical day: `source = (today.start − 1h).logicalDay`, and
   `fetchTotalMinutesTracked(source) >= 60`.

When all pass, record the attempt, then run `start(day: today, sourceDay: source)`.
- **Retry**: the same flow with `trigger "retry"`, skipping guards 3–5.
- **Readiness check** (before generating): run `claude --help`.
  - If it exits non-zero and doesn't mention `--print`, fail with "Claude Code isn't installed…"
  - If the output lacks `--json-schema`, fail with "Your Claude Code is too old… Run `claude update`".
  - A pass is cached for the process lifetime.

**3b.2 `generate(input)`**
1. Create a fresh temp directory `<tmp>/dayflow-daily-brief/<day>/candidates/`, with the path fully
   resolved through symlinks. It is deleted at the end. Delete the old transcripts for that day.
2. Load the categories. Get the cards for `sourceDay` and drop non-idle ones: remove cards whose
   category (trimmed, lowercased) is `idle` or `system`, or matches a category flagged `isIdle`.
   If none remain, fail with "There's no activity from yesterday to build a brief from."
3. **Candidate screenshots.** Take cards with a recordId and sample them evenly down to at most 60:
   `items[i*count/60]`. For each card:
   - fetch the screenshots in its `start_ts..end_ts`;
   - take the **middle** one and scale it to a maximum of 1280 px on the longest side;
   - write it as JPEG at quality 0.8, named `<cardId>_<HHmm>.jpg`, where `HHmm` is the card start in
     24 h local time.

   Then write `index.json`, a pretty-printed array of
   `{file, cardId, start, end, title}` (start and end are the card display strings).
4. Placeholder values:
   - `USER_NAME`: the first word of the OS account's full name, or `"the user"`.
   - `TODAY_LONG` / `YESTERDAY_LONG`: `"Thursday, October 22, 2026"` (en_US, `EEEE, MMMM d, yyyy`).
   - `TIMEZONE`: IANA identifier, for example `Europe/Warsaw`.
   - `YESTERDAY_CARDS`: `cardLines` (below). The docket uses the detailed variant.
   - `CATEGORIES_WITH_DESCRIPTIONS`: one line per non-idle category sorted by order,
     `- ${name}: ${details or "(no description)"}`, or `No categories set up.`
   - `FEEDBACK_DAYS`: `"21"`.
   - `CANDIDATES_DIR`: the absolute candidates path.
   - `OVERRIDE_INSTRUCTIONS`: `overrideInstructionsBlock(text)`, or `""`.
   - `FEEDBACK_SUMMARY` and `RECENT_BRIEF_ITEMS`: computed per part, below.
5. Run **both parts concurrently**: docket and extras (3b.4).
6. **Merge.**
   - Take `content = extras` (if extras succeeded), then set `content.docket = docket.items`.
   - Set `order = ["docket"]` (only if the docket is non-nil) followed by the extras' `order`.
   - Sum the stats: cost, tokens, turns, prompt characters, and tool-call counts merged.
   - Record each part's failure message in `failedParts`. If both parts failed, throw their messages
     deduplicated and joined by a space.
7. Set `cardCount`, `candidateImageCount`, `usedOverrideInstructions`, and `failedParts`.
8. **Clean** (3b.6). If any part failed and the cleaned content has no sections, throw (a failure,
   not a quiet day).

**3b.3 Prompt pieces computed per part**

`cardLines(cards, includesDetail)` produces one line per card in timeline order:
```
[cardId 123] 9:05 AM–10:20 AM · Work · Title — summary · apps: figma.com, slack
```
- The separator between times is an en dash `–`. The others are ` · ` and ` — `.
- When `recordId` is missing, write `?` in its place.
- Without detail, the summary is cut to 400 characters.
- `apps` lists `appSites.primary` and `appSites.secondary` when non-empty.
- With `includesDetail` (docket only), the full summary is used, and each non-empty line of
  `detailedSummary` is appended as `\n    <line>` (4 spaces).

`feedbackSummary(events, kinds)`:
- Filter events to the last 21 days whose `section` is in this part's kinds (docket:
  `["docket"]`; extras: the other six), sorted ascending by time.
- With no events the output is `No feedback yet.` Otherwise:
```
Counts by section:
- <section>: <action> <n>, <action> <n>        (sections sorted; "action n" strings sorted)

Latest actions:
- <day> · <section> · <action> · "<itemTitle>"   (last 30 events)
```

`recentBriefItems(briefs, kinds)`:
- Use the 5 most recent stored briefs other than today, sorted by day descending.
- Each brief becomes a block of `#### <day>` followed by lines for this part's kinds:
  - `- docket: <title>`
  - `- keep_tracking: <label> — <status>`
  - `- completed_yesterday: <title>`
  - `- team_decisions: <decision>`
  - `- related_reading: <title> (<url>)`
  - `- industry_news: <headline> (<url>)`
  - `- site_seeing: <caption or file>`
- Briefs with no lines are skipped. Blocks are joined by a blank line. When nothing is left the
  output is `None yet.`

Template choice:
- Use the user override for that part if it is non-blank, otherwise the default template.
- If the template lacks `{{OVERRIDE_INSTRUCTIONS}}`, append `"\n\n{{OVERRIDE_INSTRUCTIONS}}"`.
- `build()` replaces every `{{KEY}}` in **a single pass**, so text inside values is never expanded.
  Unknown keys stay literal.
- Afterwards, collapse any run of 3 or more newlines to 2, repeating until none are left.

**3b.4 Claude invocation per part.** The prompt is sent on **stdin**. The working directory is the
run directory. The shell command is `cd <runDir> && exec claude -p …`, run through the user's login
shell.
```
claude -p --output-format json --verbose
  --disable-slash-commands --prompt-suggestions false
  --tools '<tools>' --json-schema '<schema JSON>' --name 'dayflow-daily-brief-<part>'
  --no-session-persistence
  --settings '<settings JSON>'
  --mcp-config '<runDir>/<part>_mcp.json'           (only if Dayflow's bundled CLI exists)
  --allowedTools 'WebSearch' 'WebFetch' ['Read(/<abs candidatesDir>/**)'] 'mcp__dayflow__get_time_breakdown' ...
  --model opus
  --                                                 (no --strict-mcp-config: user's MCP connectors load)
```
- `tools`:
  - docket: `WebSearch,WebFetch`;
  - extras: `Read,WebSearch,WebFetch`. In the Read rule, the leading `/` added before the absolute
    path makes the `//abs` form, which the CLI reads as an absolute path.
- Dayflow read tools allowed:
  `get_time_breakdown, get_timeline, get_activity_detail, search_activities, get_daily, get_weekly, list_categories, get_status`.
- `settings`:
  - `{"hooks":{"PreToolUse":[{"matcher":"mcp__.*","hooks":[{"type":"command","command":"/bin/sh '<runDir>/<part>_read_only_hook.sh'"}]}]}}`;
  - the docket adds `"effortLevel":"medium"`.
- MCP config: `{"mcpServers":{"dayflow":{"command":"<app>/Contents/Helpers/dayflow","args":["mcp"]}}}`.
- Environment: remove `MAX_THINKING_TOKENS`.
- Timeout: 20 min. On timeout the message is "Claude took longer than 20 minutes on your brief, so
  Dayflow stopped it. Try again."
- JSON outputs are serialized with sorted keys and unescaped slashes.

The read-only hook (`<part>_read_only_hook.sh`) must be ported, for example to a Node script.
It reads the hook JSON from stdin and takes `tool_name`, then decides as follows:
1. Deny if `tool_name` is empty.
2. Lowercase the name. These Dayflow tools are denied:
   `mcp__dayflow__create_category`, `mcp__dayflow__delete_category`,
   `mcp__dayflow__update_category`, `mcp__dayflow__delete_activity`,
   `mcp__dayflow__update_activity`, `mcp__dayflow__set_day_goal`.
   Any other `mcp__dayflow__*` tool is allowed.
3. Otherwise take the part after the last `__`. Split camelCase (`([a-z0-9])([A-Z])` → `$1 $2`),
   lowercase it, and turn every non-`[a-z0-9]` character into a space. Then split it into words.
4. Deny if any word is one of:
   `send post create update delete write edit remove add reply archive move upload set schedule invite comment react mark publish share assign close merge approve draft submit cancel rename transfer pay run execute exec insert replace append patch put save import apply trigger respond accept decline complete resolve star follow subscribe label tag forward duplicate restore revert deploy kill start stop enable disable toggle unsubscribe unfollow pin unpin snooze mute`.
5. Allow if any word is one of:
   `get list search read fetch query find view retrieve describe lookup download`.
6. Deny otherwise.

To deny, write `Dayflow's daily brief can only read from your tools, so ${tool} was blocked.` to
stderr and exit with code **2**. To allow, print
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}` and exit 0.

**JSON Schemas** (`--json-schema`). Every object has `additionalProperties:false`.
- `person` = `{name, note}`, required `[name]`.
- `link` = `{title, url, app}`, required `[title]`.
- `feedbackNote` = `{name, source, text, url}`, required `[name, text]`.
- **docket**: `{notes: string, items: docketItem[]}`, required `[notes, items]`.
  - `docketItem` properties: `title, detail, due, people[person], links[link], prompt,`
    `agent:boolean, feedback[feedbackNote], feedbackSummary, feedbackUrl, attach[string], why`.
  - Required: `[title, prompt, agent, why]`.
- **extras**: `{notes, order: string[] (enum of the 6 non-docket keys), keep_tracking[], completed_yesterday[], team_decisions[], related_reading_intro: string, related_reading[], industry_news[], site_seeing[]}`,
  required `[notes, order]`. Item schemas (all strings unless noted):
  - tracking: `label, status, app, asOf, url, why`. Required `label, status, why`.
  - completed: `project, title, apps[string], cardId:integer, why`. Required `title, why`.
  - decision: `decision, date, people[string], place, app, url, why`. Required `decision, why`.
  - reading: `title, source, url, reason, imageUrl, why`. Required `title, url, why`.
  - news: `headline, source, url, published, why`. Required `headline, url, why`.
  - siteSeeing: `file, caption, why`. Required `file, why`.

`notes` and `why` are never shown or stored. They exist only so the transcript explains each
choice.

**3b.5 Reading the result**
1. Parse stdout as a JSON value. A `--verbose` run gives an array of events. If that fails, try
   every balanced JSON value inside stdout, to cope with login-shell noise. Pick the first value
   that contains an event with `type:"result"`.
2. Envelope = the last `result` event. Success means `is_error != true` and `subtype` is `"success"`
   or empty. Then:
   - use `structured_output` if it is present and is a valid JSON object;
   - otherwise strip ```` ```json ```` and ```` ``` ```` from `result` and take the first balanced
     `{…}` that parses as an object.
3. On failure, the user-facing message is:
   - `error_max_turns` → "Claude ran out of steps before finishing. Try again.";
   - a subtype containing `structured_output` → "Claude's answer came back in an unexpected shape.
     Try again.";
   - otherwise, the first non-empty of result/stderr/stdout is classified:

| Class | Message |
|---|---|
| usage limit | "Claude hit its usage limit. Try again after it resets." |
| login expired | "Claude isn't signed in. Open Terminal, run `claude`, then type /login." |
| not installed | "Dayflow couldn't find Claude Code on this Mac." |
| credits / API key / blocked | "Claude's account has a billing or API key problem, so the brief couldn't run." |
| model misconfigured | "Your Claude account can't use the Opus model the brief needs." |
| transient | "Dayflow couldn't reach Claude. Try again in a bit." |
| flaky | "Claude's answer came back in an unexpected shape. Try again." |
| default | "Claude couldn't finish the brief. Try again." |

4. Stats are taken from the envelope:
   - `total_cost_usd`, `num_turns`;
   - `usage.{input_tokens,output_tokens,cache_read_input_tokens}`;
   - model = the `modelUsage` key with the most `outputTokens`, else the `system` event's `model`,
     else `"opus"`;
   - toolCalls = counts of `tool_use` block names in assistant events, excluding `StructuredOutput`.
5. Transcript file (also written for failed runs). Sections are joined by `\n\n---\n\n`:
   - `# Prompt`;
   - `# Session started` (model, tools, connectors with status);
   - `## Claude` text, `## Claude (thinking)` when non-empty, `## Tool call: <name>` with pretty
     JSON input;
   - `## Tool result` or `## Tool error`;
   - `# Result` (subtype plus structured output or text);
   - `# stderr`;
   - `# Raw output` when no events were parsed.
6. Decode: the docket as `{items}`; the extras as `DailyBriefContent` with the docket forced to nil.
   A decode failure gives "Claude's answer came back in an unexpected shape. Try again."

**3b.6 Cleaning**
- All strings are trimmed, and an empty string becomes absent.
- `app` values are lowercased.
- URL fields keep only absolute `http`/`https` URLs that have a host. Anything else becomes absent.
- Empty arrays become absent.

Section rules:
- **docket**: an item without a title is dropped. People without a name, links without a title,
  and feedback without a name or text are dropped.
- **keep_tracking**: needs both label and status.
- **completed_yesterday**: needs a title. `cardId` is kept only if it matches a candidate. The
  matching candidate JPEG is copied to `<briefDir>/images/<file>` and `imageFile = "images/<file>"`.
- **team_decisions**: needs a decision.
- **related_reading**: needs a title and a valid url. `related_reading_intro` is kept only when at
  least one reading item survives.
- **industry_news**: needs a headline and a valid url.
- **site_seeing**: take the file's basename. It must be a candidate file and not a duplicate. It is
  copied to images/ and `file = "images/<file>"`.

Older images are not deleted, so the brief on screen during a retry keeps its pictures.

`order` keeps the trimmed, known, non-empty sections without duplicates. The docket is put first
when it is present (step 6 of 3b.2).

**3b.7 Finish run**
- **On success:**
  - If a brief for the same day already exists and some part failed, keep that part's sections from
    the existing brief. For a failed extras part, its `order` is kept too.
  - Keep the existing `userState` when a brief for the same day exists. Set `hasBeenShown = true`
    if the brief is on screen.
  - Set `stats.durationSeconds` (wall clock) and `trigger`, then save.
  - Show the ready notice when `trigger != "retry"` and the brief is not on screen.
- **On failure:** `runState = failed(message)` and `lastFailedRunStats` are kept for the footer.
  Nothing is saved.

**3b.8 Item actions** (all persist `brief.json` immediately; feedback goes to feedback.json)
- **check toggle**: records `checked` when the item is checked.
- **dismiss item**: records `dismissed`.
- **add task / remove task**.
- **docket hand-off**:
  - adds an entry and records `opened`;
  - *paste* puts the text on the clipboard, opens the agent's app (web fallback
    `https://claude.ai/new?q=` / `https://chatgpt.com/?q=`), and sends Cmd+V after 1.2 s;
  - *run* writes `<out>.prompt` and runs
    `/bin/sh -c "{ cd <folder or briefDir/handoffs> && claude -p --permission-mode acceptEdits < <prompt>; } > <out> 2>&1; echo $? > <out>.exit"`.
    Codex uses `codex exec --full-auto --skip-git-repo-check -`.
- **refresh runs**: reads `.exit` files left behind. A run with no `.exit` after 3 h is marked
  failed.
- **open result**: opens the output file or the app, and marks the entry reviewed.
- **dismiss docket**: records `dismissed`. **undo dismiss** and **set dismiss reason** are also
  available.
- **reset docket** (debug).
- **save image**: copies the image to `saved/` and records `saved`.

Dismiss reasons:
- "That task was irrelevant to what I’m working on"
- "That task should not be handed to an agent"
- "The task did not capture what I was actually supposed to do"
- "The prompt provided was not helpful"
- "Other"

Docket status:
- no entry → New;
- dismissed → Dismissed;
- reviewed → Reviewed;
- failed → Failed;
- a run with `finishedAt` set → Ready;
- otherwise → In progress.

Recent folders: the picked folders first, then project paths from `~/.claude.json` `projects`,
ordered by when `~/.claude/projects/<path with / and . replaced by ->` was last modified. Only
existing folders are kept, at most 5.

**3b.9 Range summary ("Everything you completed")**
1. Collect the entries: every `completed_yesterday` item from all briefs whose `sourceDay >= startDay`.
   - `startDay` is today minus 7 or minus 30 days (calendar days, not the 4 AM boundary), the first
     day of the current quarter, or Jan 1.
   - `endDay` is today's logical day.
2. Fail with "No completed work saved in this range yet." if there are no entries.
3. Sort ascending by day.
4. Run one `claude -p` with tools `""`, the schema below, name `dayflow-daily-brief-summary`, no MCP
   config, `--strict-mcp-config`, model opus, the OS temp dir as working directory, and a 5 min
   timeout.
5. Schema: `{overview: string, milestones: string[], projects: [{title, bullets: string[], impact?, imageEntryIndex?: integer}]}`,
   required `[overview, milestones, projects]`.
6. Projects without a title or without bullets are dropped.
7. `imageFile` = `"<briefDay>/<entry.imageFile>"` when `imageEntryIndex` points to an entry with an
   image.
8. Save to `summaries/<range>.json` and navigate to the summary view.

---------------------------------------------------------------------------------------------------

## 4. Prompts (verbatim)

### 4.1 Recap: `localPrompt` (Gemini, Local, and any provider not listed)

Exact text. The string ends with one trailing newline.
```
# Daily Recap Prompt

You are the person whose activity log this is, writing a quick end-of-day recap for yourself.
Your future self doesn't need a diary. You need the 3-5 things that actually moved the needle today so you can look back and know what happened.

Read the log, find the real accomplishments, and write them up the way you'd tell a friend: "here's what I actually got done today."

## Selection rules

- Put 0 to 5 items in "done" based on evidence quality.
- Do NOT pad to reach 5. If only two things were genuinely meaningful, return two.
- If nothing high-confidence exists, return an empty "done" array.

## What counts as an accomplishment

An accomplishment is something that has a clear before and after. You finished it, decided it, figured it out, or made something real. Anything where the state of the world changed because of what you did.

Examples across roles:
- A founder closed a conversation, sent a launch, locked in a positioning decision.
- A student finished a problem set, nailed down a thesis argument, submitted an application.
- A designer shipped a comp, got approval on a flow, resolved a UX question with evidence.
- An engineer fixed a bug, landed a feature, unblocked a dependency.

Not accomplishments: browsing, reading without a takeaway, meetings that ended without a decision, half-started tasks with no checkpoint.

## Writing rules

- Each item: one sentence, 8-20 words max. If it's over 20, split or trim.
- Lead with what changed or what you decided, not the process of getting there.
- Write like a real person. Plain, direct, no filler.
- Banned words: leverage, surface, actionable, facilitate, optimize (unless literally about an optimizer), deep-dive, synergy, align (unless about visual alignment).
- If something sounds like a consultant or a report generator wrote it, rewrite it in your own words.
- Use only evidence from the log. Do not invent or assume details.
- Name concrete things: the pricing page, the midterm essay, the onboarding flow, the partner deal. Not vague categories.
- Include a number when it adds real signal (a metric, count, %, dollar amount, word count). If the log has a useful number, use it. Don't force one in.
- If a useful number from the log matters, include it in the bullet.

## What to skip

- Browsing, entertainment, social media scrolling, side distractions.
- Low-signal process noise: "build succeeded," "synced files," "opened app."
- Tool and workflow internals your future self won't care about: file names, class names, git/PR activity, IDE details, batch IDs.
- Don't mention AI tools by name (Claude, ChatGPT, Cursor, Copilot) unless the work was explicitly about that tool. The accomplishment is the output, not the tool.
- No em dashes. No hype. No self-praise.

## Tomorrow / next section

- Include "next" (exactly 1 item) only when the log shows a specific task that was clearly started but unfinished, or a concrete next step explicitly discussed or planned during the day.
- Do not speculate. If nothing in the log points to a specific carryover task, set "next" to null.
- The bar: could you point to a specific moment in the log where this next step was set up? If not, leave it out.

## Examples

Good bullets:
- "Fixed the webhook retry bug that was dropping ~12% of partner callbacks."
- "Finished the pricing page FAQ and got sign-off from Lisa."
- "Narrowed the signup drop-off to the email verification step, 41% abandon rate."
- "Submitted the constitutional law essay, 2,800 words."
- "Locked in the 'automatic work journal' positioning after testing five alternatives."
- "Got verbal yes from the Acme partnership, sending the agreement tomorrow."
- "Finalized the onboarding flow redesign, down from 7 screens to 4."

Bad bullets and why:
- "Updated AuthService.swift and pushed three commits." -> Implementation details nobody needs.
- "Surfaced conversion leakage insights and drafted actionable recommendations." -> Consultant-speak. What did you actually find?
- "Spent a focused session analyzing churn patterns to derive strategic retention insights." -> Describes the process, not the result. What did the analysis show?
- "Did some research on competitors." -> Too vague. What did you learn? What did you decide?
- "Had a productive brainstorm with the team." -> What came out of it?

```

### 4.2 Recap: `evidencePrompt` (Claude CLI; also the base for ChatGPT)
```
Write a short end-of-day Daily recap for your future self from the supplied timeline cards. Report what actually changed today, not everything that appeared on screen.

Evidence rules:
- Timeline titles and summaries are fallible descriptions. Prefer specific actions in the summaries over broad titles or optimistic narration. If later evidence shows the same problem unresolved, do not call it fixed.
- Separate an action from its outcome. Editing code proves an edit, not a working fix. Running a test proves a test was run, not that it passed. Configuring an integration does not prove it connected. Deployment activity does not prove successful deployment.
- A bounded artifact change can count: a document updated with named content, a created/shared deck, a changed setting, a submitted assignment, a posted message, or an implemented code change. State that exact change without upgrading it to successful operation.
- General descriptions such as working on a report, coding, researching or troubleshooting do not establish a completed milestone. Omit them when no concrete change or finding is supported.

Selection:
- Put 0 to 3 distinct, meaningful completed items by default. A fourth or fifth is allowed only for equally strong separate outcomes; never fill slots. An empty array is correct when evidence is too weak.
- Prefer the strongest meaningful accomplishments in work, school, or personal projects. Exclude routine errands, browsing, videos, background pages and low-signal process details.
- Rank by evidence strength and meaningful change, not by time spent or technical complexity. Prefer a specific completed configuration change, submission, publication, or shared artifact over a list of generic code edits.
- Combine changes to the same document or feature into one bullet. Do not split a weekly update into its progress and to-do additions.
- An unfinished assignment, exercise, or presentation belongs in next steps, not accomplishments, unless a separately useful milestone was completed (for example creating and sharing a deck). Merely reaching a later question is not a completed milestone.
- Do not turn source-log mistakes or screen-description failures into user work. Personal projects can count when a meaningful, concrete milestone is supported.
- A finding needs a concrete supported conclusion; 'researched X' or 'understood X' is not a finding.

Writing:
- One short sentence per item, normally 8–18 words. Use natural concise phrasing in the requested language.
- Name the artifact or change. Keep useful numbers. Do not mention commits, pushing, pull requests, filenames, implementation class names or lists of libraries. Say what was changed, without claiming an unverified fix. Omit AI tool names unless the work itself is about that tool.
- No hype, em dashes or filler. Do not use 'fixed', 'finished', 'working', 'deployed', 'approved', or equivalent wording unless the evidence supports that exact state.

Next step ("next"):
- Return a single specific unfinished task only if today's evidence clearly establishes it was started and remains unfinished, or explicitly planned.
- Do not invent what ought to happen next. Pending approval does not imply a promised release after approval. A document being open does not imply a commitment to finish it tomorrow.
- Otherwise use null.
```
(No trailing newline.)

### 4.3 Recap: `solEvidenceRules` (ChatGPT only)

For ChatGPT, `instructions = evidencePrompt + "\n\nAdditional evidence checks:\n" + solEvidenceRules`, where:
```
- Treat visual-access refusals, processing failures and generic scene descriptions as missing evidence. A vague report/document description among failed descriptions is not enough to establish an accomplishment; use an empty array if that is all the day supports.
- Do not infer a submitted artifact's topic from nearby reading or unrelated coursework. If its title and submission are confirmed but its subject is ambiguous, report the title and submission only.
- A long coding session does not outrank a definite smaller change: check for explicit settings/permission changes, submitted work, and published messages before selecting ongoing code edits.
```

### 4.4 Recap: full assembled prompt (`makeLocalPrompt`)
```
${instructions}

You only have timeline cards for this day. The log is incomplete by nature, so prefer omission over guessing.

Activity log:

${cardsText}

${languageSection}

## Output format

Return ONLY valid JSON, no markdown fences, no preamble. Use this exact schema:

{
  "done": ["first bullet", "second bullet", "..."],
  "next": "one sentence or null"
}

Return exactly one JSON object and nothing before or after it.
```
- `${instructions}`: 4.1, 4.2, or 4.2 + 4.3 depending on the provider. Because 4.1 ends with "\n",
  there is one extra blank line after it.
- `${cardsText}`: `makeCardsText(sourceDay, cards)` (§3a.4).
- `${languageSection}` is `""` when no output language applies. In that case the result has two
  consecutive empty lines and **nothing collapses them**. Otherwise it is:
  ```
  ## Language

  The user only speaks ${lang}. Respond in ${lang}, but keep JSON keys in English exactly as specified. If any rule requires an exact English phrase (e.g., "Scattered apps and sites"), keep it verbatim.
  ```
  `${lang}` is the language override or the locale-derived language (§3a.4).

### 4.5 Brief: shared blocks (inlined below where the templates interpolate them)

The Swift source defines four shared blocks and interpolates them into the templates:

- `aboutThemWithDetail`: the "## What you know about them" section of 4.6;
- `aboutThem`: the same section of 4.7, which uses "past briefs" wording;
- `writingStyle`: the "## Writing style" section of both templates;
- `dayflowAndConnectorTools`: the first two bullets under "## Tools you can use" in both templates.

4.6 and 4.7 below show the templates with these blocks already expanded, exactly as the model
receives them. Only the optional override block is listed separately here.

**`overrideInstructionsBlock(text)`**. When the trimmed text is empty the value is `""`. Otherwise:
```
## Extra instructions from the user

They typed these preferences into Dayflow. They take priority over the defaults above
whenever the two disagree (for example, which sections to include or skip, how many items,
or what to focus on). The output shape below still applies. Ignore instructions about parts
of the brief this prompt doesn't write.

${trimmedOverrideText}
```

### 4.6 Brief: `docketTemplate` (the "Spring" run). The default template is shown with its parts inlined.

Placeholders available to the docket: `USER_NAME, TODAY_LONG, YESTERDAY_LONG, TIMEZONE,
YESTERDAY_CARDS (detailed variant), CATEGORIES_WITH_DESCRIPTIONS, FEEDBACK_DAYS, FEEDBACK_SUMMARY,
RECENT_BRIEF_ITEMS, OVERRIDE_INSTRUCTIONS`. The "Edit prompt" editor starts from this text, with
the `\(...)` parts already expanded, and lists these names.

````
You're putting together Spring for {{USER_NAME}}, a person who uses Dayflow, an app that records
their screen and turns it into a timeline of what they did. They'll read it first thing this morning.
Today is {{TODAY_LONG}} ({{TIMEZONE}}). Yesterday was {{YESTERDAY_LONG}}.

## What Spring is for

Spring should spring them into the day: a short list of the things most worth getting done today,
where an AI agent does as much of the work as possible. Each item is a card they can hand to Claude
Code or Codex. The ideal item is one they'd be glad to see because it moves something they care about,
and that an agent can take almost entirely off their plate: it gathers, researches, analyzes and
drafts, and they only scan the result and decide or send.

Three shapes of item work well, in this order of preference:
1. **Done for you.** The agent can do the whole task and hand back something ready to review: drafted
   messages to the right people with the facts already pulled, a reply with the documents someone
   asked for gathered from their mail, messages and files, an analysis with the numbers, a first draft
   or a first version.
2. **Decision prepared.** Something only they can decide, where the agent does the deep dive first so
   the decision takes minutes: the options, the evidence, the risks, and a recommendation.
3. **Unstuck.** Something important they keep circling or putting off, turned into a small concrete
   first step the agent can start right now (a quick test, a rough first version, a first batch of
   examples), so it stops waiting on them.

Value decides what makes the cut: money on the table, people waiting on them, their biggest goals,
things they've been dragging their feet on. A small task still belongs on the list when real value
rides on it and an agent can handle it. Size alone never disqualifies an item, and neither does it
being personal.

Things that don't belong:
- **Reminders an agent can't act on.** A bare "reply to X" or "decide Y" with nothing prepared. Either
  the agent can do the work or prepare the decision, or the item is out.
- **Checking on their own tools.** Looking in on a task an agent or a script is already running, an
  experiment they're in the middle of, or a choice inside their own unfinished research.
- **Busywork with no payoff,** and anything already done or already handled by someone else.

How to work:
1. **Map what matters.** From the last two to three weeks (yesterday's timeline, Dayflow history and
   their connectors), list their active goals and open threads with other people, ranked by how much
   rides on them. Write it in `notes`.
2. **Find at least 12 candidates.** Go through each of these sources of value, and check the data
   rather than guessing:
   - **People waiting on them:** emails, messages, tickets, issues and threads where someone asked
     them for something and hasn't heard back.
   - **The people their work is for:** clients, customers, users, students, readers, a manager. Check
     how it's landing with them, using whatever sources show it.
   - **Their biggest goals:** the next move that matters most for each one.
   - **Work that's stuck:** something they've spent days on without shipping, or keep circling without
     deciding. Being busy with it doesn't mean it's moving; if nothing has gone out, it's stuck.
   - **Decisions they're circling,** and **risks** they're about to walk into.
3. **Score each candidate 1 to 5 on value** (how much moves, or how much money, trust or time rides on
   it) **and on offload** (5: the agent does it all and hands back drafts or results; 3: the agent
   does the deep dive and they make a quick decision; 1: only they can do it). Note the candidates
   with both scores in `notes`, and keep the best by value times offload. Drop anything with offload 1.
4. **Do the groundwork** so each prompt lets the agent start immediately: who, what, where the facts
   live (which mailbox, which thread, which file), and what "done" looks like, which is usually a draft
   or a report they can scan.

Aim for 4–6 items, most valuable first. Every item is grounded in real evidence; never invent facts or
numbers.

## What you know about them

### Yesterday's timeline
These are yesterday's activity cards (cardId, start–end, category, title, summary, apps/sites), each
followed by its minute-by-minute detail lines. Idle cards are already removed.

{{YESTERDAY_CARDS}}

### Their categories
{{CATEGORIES_WITH_DESCRIPTIONS}}

### What they did with past lists
This is feedback from the last {{FEEDBACK_DAYS}} days: what they opened, saved, dismissed with the X,
or checked off. Items with no feedback were ignored. Treat a dismissal as a strong signal against that
kind of item.

{{FEEDBACK_SUMMARY}}

### Items from recent lists
Don't repeat these unless something meaningfully changed (and say what changed).

{{RECENT_BRIEF_ITEMS}}

## Tools you can use

- **Dayflow tools** (`mcp__dayflow__*`): read older history, such as the last 2 weeks of timeline, search
  for an activity, or get the time breakdown. Use them to tell a one-off from an ongoing project.
- **Their connectors** (whatever tools are available besides Dayflow's, e.g. Slack, Linear, Gmail,
  Notion, Google Drive): read only. You can search and read; you cannot send, post, create, or edit
  anything, and those calls will be refused. If no connectors are available, work from the timeline.
- **WebSearch / WebFetch**: check outside facts, research ideas, and find examples. Open every link you
  include and confirm it says what you claim.

Budget: aim to finish in about 10 minutes. Use the sources that would actually change what goes on the
list.

## Item format

Spring shows each item as a card they can hand to an AI agent (Claude Code or Codex), so each item
carries:

- `title`: the action, phrased as the thing to do. It says the whole point on its own.
- `detail`: one or two sentences on why it matters now and what the payoff is. Don't repeat the title.
- `due`: only if a source states a date.
- `people` and `links`: who's involved and the docs, threads, or pages it builds on, with links when
  you have them.
- `prompt`: a complete, ready-to-send prompt for an agent that would do the task or its first big
  chunk, written as {{USER_NAME}} would write it to a capable colleague. Say what to produce, the facts
  it needs (names, numbers, constraints people stated), and what "done" looks like. Don't invent facts.
- `agent`: true when an agent could do it without them (research, a draft, a prototype, an analysis);
  false when it needs them (a decision only they can make, a conversation, testing on their own
  machine). Write the prompt either way.
- `feedback`: what people said about the task, one note per message, with `name`, `source`, `text`
  (word for word when short) and `url` when you have one. Skip it when nobody said anything.
- `feedbackSummary` and `feedbackUrl`: when every feedback note is from one person, a two-sentence
  summary of what they want and the link to the main message.
- `attach`: titles of the `links` an agent needs, when any.
- `why`: the evidence behind the item in one or two sentences: which card, message, record, or page
  shows it. The user never sees it.

## Writing style

The goal is that they understand each item in a few seconds, on the first read. Write whatever makes
that most likely: not so terse that a line reads like shorthand they have to decode, and not so
descriptive that it explains things they already know.

- **Lead with the point.** The title says the whole thing on its own (the action, the decision, the
  result). The first sentence under it says why it matters or what to do today. Names, numbers, and
  details come after that. Someone who reads only the titles should still get the brief.
- **Use their words.** They know their own projects, people, tools, and team jargon, so name those
  directly instead of explaining them. Spell out anything they wouldn't know, such as a label you made
  up or an acronym from someone else's field.
- **Write plain, complete sentences.** Use common words. Don't drop small words like "the" or "to",
  don't stack nouns, and don't use unusual metaphors. A title can be a short phrase, but it needs a
  verb or a clear subject ("Send Jeremy the paywall options by Friday", not "Paywall iters (J)").
- **Keep the tone plain and warm.** No hype words, no exclamation marks, no emoji, no "Great job!"
  Write in second person when you address them.

{{OVERRIDE_INSTRUCTIONS}}

## Output

Your final answer is one JSON object (checked against a schema) with `notes` and `items`. `notes` is a
brief summary of the run: which sources you checked, what you found, and the candidates you considered
with their scores. Keep it to actions and findings, not a step-by-step account of your thinking. Use
only the fields described. Dates are yyyy-MM-dd. `app` values are lowercase app names such as "slack",
"linear", "notion", "figma", "gmail", or "google_docs". Omit a field when you don't have it; never
write placeholder values. If nothing clears the bar today, write `{"notes": "...", "items": []}`.
````

### 4.7 Brief: `extrasTemplate` (all other sections). The default template is shown with its parts inlined.

The extras placeholders are the docket set plus `CANDIDATES_DIR`. `YESTERDAY_CARDS` uses the short
variant (summary cut to 400 characters, no detail lines).

````
You're writing today's Daily brief for {{USER_NAME}}, a person who uses Dayflow, an app
that records their screen and turns it into a timeline of what they did. They'll open it this morning
inside Dayflow. Today is {{TODAY_LONG}} ({{TIMEZONE}}). Yesterday was {{YESTERDAY_LONG}}.

The brief's to-do list ("Your docket today") is written separately, so don't suggest tasks. You write
the other sections, described below.

## What this brief is for

The brief should feel like a note from a sharp friend who watched their day and then went looking for
things they'd be glad to know. In priority order, every item should be:

1. **Enjoyable.** Something that makes them smile, feel seen, or feel a small spark of curiosity.
2. **Useful.** It saves them time, reminds them of something real, or helps the work they're doing.
3. **Correct.** Grounded in evidence you actually found. Never invented, never padded.

The brief is a daily habit, so being trusted matters more than being complete. One mediocre item
teaches them to skim; three skims teach them to ignore the brief. **Leave a section out instead of filling it
with weak items.** A brief with three excellent sections is better than one with six decent ones.
Before keeping any item, ask: "Would they be glad I showed them this, or would they shrug?" If
the answer is a shrug, cut it.

Things that make an item weak, and should get it cut:
- Generic: it could have been written for anyone ("Here's an AI news roundup").
- Stale or obvious: they already know it, or it's restating their own timeline back to them without
  adding anything.
- Low confidence: you're guessing at a decision, a number, or what they care about.
- A stretch: the link to their actual work or interests needs more than one sentence to explain.

## What you know about them

### Yesterday's timeline
These are yesterday's activity cards (start–end, category, title, summary, apps/sites). Idle cards are
already removed.

{{YESTERDAY_CARDS}}

### Their categories
{{CATEGORIES_WITH_DESCRIPTIONS}}

### What they did with past briefs
This is feedback from the last {{FEEDBACK_DAYS}} days on the parts of the brief you're writing: what
they opened, saved, dismissed with the X, or checked off. Items with no feedback were ignored. Lean
toward what they engage with. Treat a dismissal as a strong signal against that kind of item.

{{FEEDBACK_SUMMARY}}

### Items from recent briefs
Don't repeat these unless something meaningfully changed (and say what changed).

{{RECENT_BRIEF_ITEMS}}

If a whole section keeps getting ignored in the feedback above, show it less often or drop it.

## Tools you can use

- **Dayflow tools** (`mcp__dayflow__*`): read older history, such as the last 2 weeks of timeline, search
  for an activity, or get the time breakdown. Use them to tell a one-off from an ongoing project.
- **Their connectors** (whatever tools are available besides Dayflow's, e.g. Slack, Linear, Gmail,
  Notion, Google Drive): read only. You can search and read; you cannot send, post, create, or edit
  anything, and those calls will be refused. If no connectors are available, work from the timeline.
- **WebSearch / WebFetch**: for the reading and news sections. Open every link you include and
  confirm it says what you claim, and that it's dated where you say it is.
- **Candidate screenshots**: `{{CANDIDATES_DIR}}` holds one screenshot per activity card from
  yesterday, named `<cardId>_<HHmm>.jpg`. `{{CANDIDATES_DIR}}/index.json` lists each file with its
  card id, times, and title. View the files with the Read tool.

Budget: aim to finish in about 10 minutes. Prefer a few targeted searches over many broad ones.

## Sections

Each section is optional. Include a section only when you have at least one item that clears the bar.
Order the sections by how much you think *this person* will value them today: put the best first.
Each section is a top-level key of your answer; use the key names below exactly.

### `keep_tracking` — "Keep tracking"
Ongoing things with a number or state that moved: a launch's signup count, an experiment's
results, a PR waiting on review, a thread that went quiet. Each item gives the thing being tracked,
the current state in one line, where it came from, and the date of that state. Only include an item
when you found the actual current state; "check on X" is not an item.

### `completed_yesterday` — "What you completed yesterday"
1–4 real accomplishments from yesterday, phrased the way they'd tell a friend ("Shipped the island map
in Flow"). Group cards that belong to one piece of work. Give each the project or area it belongs
to, the apps involved, and the single best `cardId` to illustrate it (its screenshot will be shown;
use a card id from the timeline above). Skip this section on a day with no real finished work;
browsing is not an accomplishment.

### `team_decisions` — "Key team decisions"
Decisions made in the last 2 days, found in their connectors (Slack threads, meeting notes, docs),
that affect what they're working on. One sentence each, stating the decision itself ("Launch moved to
Nov 1 because of the payments review"), plus who was involved, where (`place`), when, and a link. Only
include a decision when the source shows it was actually agreed, not just proposed.

### `related_reading` — "Related to your interests"
2–6 articles, talks, videos, or examples connected to something specific they spent real time on
recently. Put one sentence naming the thread you're following in `related_reading_intro` ("You've
been deep in Flow's retention loop, so…"). Each item: title, source, URL, a one-line reason it's worth
their time, and an image URL if the page has a good one (og:image). Favor primary sources, standout
essays, and concrete examples over listicles and SEO pages. Things from their personal life (a trip,
a hobby, a restaurant they saved) count when they're clearly enjoyable.

### `industry_news` — "Latest in your industry"
1–3 headlines from the last 48 hours that matter to their field or their company specifically. Each item:
headline, publication, URL, publish date. Skip this section entirely on a slow news day; never pad it with
general tech news.

### `site_seeing` — "Recent site-seeing"
3–8 of the most visually interesting moments from yesterday, picked by actually looking at the
candidate screenshots: beautiful images, striking designs, places, art, games, fun videos. They don't
need to be work. Each item: the screenshot file name exactly as listed in index.json and a short
caption (≤ 8 words). Never pick adult or sexual content. Skip screens that are mostly text, code,
spreadsheets, or chat, and screens showing passwords or financial account details.

## Writing style

The goal is that they understand each item in a few seconds, on the first read. Write whatever makes
that most likely: not so terse that a line reads like shorthand they have to decode, and not so
descriptive that it explains things they already know.

- **Lead with the point.** The title says the whole thing on its own (the action, the decision, the
  result). The first sentence under it says why it matters or what to do today. Names, numbers, and
  details come after that. Someone who reads only the titles should still get the brief.
- **Use their words.** They know their own projects, people, tools, and team jargon, so name those
  directly instead of explaining them. Spell out anything they wouldn't know, such as a label you made
  up or an acronym from someone else's field.
- **Write plain, complete sentences.** Use common words. Don't drop small words like "the" or "to",
  don't stack nouns, and don't use unusual metaphors. A title can be a short phrase, but it needs a
  verb or a clear subject ("Send Jeremy the paywall options by Friday", not "Paywall iters (J)").
- **Keep the tone plain and warm.** No hype words, no exclamation marks, no emoji, no "Great job!"
  Write in second person when you address them.

{{OVERRIDE_INSTRUCTIONS}}

## Output

Your final answer is one JSON object (it's checked against a schema). Each section you include is a
top-level key holding its items; leave out the keys of sections you skip. `order` lists the sections
you included, best first.

Show your reasoning; it's how the brief gets debugged. `notes` is a short account of the run: what
you looked at, what you found, which sections you skipped and why, and anything you weren't sure
about. Every item also gets a `why`: one or two sentences on why it made the cut, naming the
evidence (the card, thread, doc, or page and what it said). The user never sees `notes` or `why`,
so be candid. For example:

```json
{
  "notes": "Read 24 cards (mostly Flow paywall work and Slack). Searched Slack for launch threads; found the launch date change. Skipped industry_news: nothing relevant in the last 48 hours.",
  "order": ["completed_yesterday", "related_reading", "site_seeing"],
  "keep_tracking": [
    { "label": "Flow onboarding progress", "status": "50 invites sent, 20 onboarded, 3 dropped off.", "app": "slack", "asOf": "2026-10-19", "url": "https://...", "why": "..." }
  ],
  "completed_yesterday": [
    { "project": "Flow", "title": "Shipped the island map in Flow", "apps": ["claude", "chatgpt"], "cardId": 1234, "why": "..." }
  ],
  "team_decisions": [
    { "decision": "Launch moved to Nov 1 because of the payments review.", "date": "2026-10-19", "people": ["Maggie Chang"], "place": "#dayflow", "app": "slack", "url": "https://...", "why": "..." }
  ],
  "related_reading_intro": "You've been deep in Flow's retention loop, so these might spark some ideas.",
  "related_reading": [
    { "title": "The Mechanics & Monetization of Idle Games", "source": "GDC", "url": "https://...", "reason": "How idle games pace rewards to bring players back daily.", "imageUrl": "https://...", "why": "..." }
  ],
  "industry_news": [
    { "headline": "...", "source": "Financial Times", "url": "https://...", "published": "2026-10-21", "why": "..." }
  ],
  "site_seeing": [
    { "file": "1234_1342.jpg", "caption": "Shoji bar, saved for Miami", "why": "..." }
  ]
}
```

Use only the fields shown. Dates are yyyy-MM-dd. `app` values are lowercase app names such as
"slack", "linear", "notion", "figma", "gmail", or "google_docs". Omit a field when you don't have it;
never write placeholder values. If nothing clears the bar today, write `{"notes": "...", "order": []}`.
````

### 4.8 Brief: range summary prompt

In the Swift source, lines that end with `\` are joined with the next one. They are shown joined
here.
```
Here is everything a Dayflow user completed from ${startDay} to ${endDay} (${rangeLabelLower}), one line per accomplishment: [index] day · project · what they did · apps.

${entryLines}

Write a crisp summary of what they accomplished in this period, the kind they could paste into a performance review or a weekly update.

- `overview`: 2–3 sentences on the shape of the period: the main projects and what moved.
- `milestones`: the 3–6 most significant accomplishments, one line each, most important first.
- `projects`: group the entries by project or area. For each, a short `title`, 2–6 `bullets` of concrete things they did (merge repeats, keep real names of features, docs, and people), an optional one-sentence `impact` only when the entries support it, and optionally `imageEntryIndex`: the index of one entry marked "(has screenshot)" that best illustrates the project.

Be concrete and plain. No hype, no filler, no exclamation marks. Only claim what the entries support; don't invent metrics, outcomes, or people. Write in second person ("You shipped...").
```
- `${startDay}` / `${endDay}`: yyyy-MM-dd.
- `${rangeLabelLower}`: `last 7 days`, `last 30 days`, `quarter to date`, or `year to date`.
- `${entryLines}`: one line per entry, oldest first, joined by "\n". Each line is
  `[${index}] ${day}` + (` · ${project}` if non-empty) + ` · ${title}` + (` · apps: a, b` if any) +
  (` · (has screenshot)` if it has an image).

---------------------------------------------------------------------------------------------------

## 5. Provider-specific differences

| | Dayflow backend | Gemini | Local (Ollama / LM Studio) | Claude CLI | ChatGPT (Codex CLI) |
|---|---|---|---|---|---|
| Recap prompt | server-side | localPrompt | localPrompt | evidencePrompt | evidencePrompt + solEvidenceRules |
| Inputs | cards + observations + 3 prior standups + titles + output language | cards only | cards only | cards only | cards only |
| Output | highlights / unfinished / blockers | done[≤5] / next | same | same | same |
| Model | n/a | the app's Gemini preference (primary, then fallbacks), thinking high, 8192 tokens | `llmLocalModelId` at `llmLocalBaseURL` (engine default URL), 8192 max tokens | `opus`, no tools | `gpt-6.1-sol` (low effort, no tools), then `gpt-5.6-sol` on failure |
| Availability | always | key present | `ollamaSetupComplete`, or URL + model set | `claude` on PATH | `codex` on PATH |
| Auth | legacy PostHog distinct-id token | API key | none | user's CLI login | user's CLI login |

- The **Daily Brief** and the **range summary** are Claude-CLI-only. They require `--json-schema`
  support and run with model `opus`.
- The Brief's hand-off targets are separate from the Brief generator: Claude/ChatGPT desktop apps,
  `claude -p`, or `codex exec`.
- Local providers sometimes add ```` ``` ```` fences or a thinking preamble, which the parser
  strips. Claude's text output may carry the `---THINKING---` block.

---------------------------------------------------------------------------------------------------

## 6. Day goals: definition and computation

**Plan resolution for a day D** (`carriedForwardGoalPlan`):
1. Take the saved plan where `day <= D` (most recent); if there is none, take
   `defaultPlan(D, categories)`.
2. Apply `.carriedForward(to: D)`. When the plan was copied from an earlier day, this resets
   `isSkipped=false` and `createdAt=updatedAt=0`, then sets `day=D`.
3. Re-resolve each category snapshot against the current categories, by UUID first and then by
   normalized name (trimmed, lowercased), so renamed or recoloured categories update. Unmatched
   snapshots are kept as they are.

Goals therefore persist day to day until changed. A day only gets its own row when the user
confirms, skips, or edits.

**Default plan**:
- focus target **270 min (4.5 h)**;
- distraction limit **120 min**;
- focus categories = all selectable categories (not system, not idle) except those named
  "distraction"/"distractions";
- distraction categories = those named "distraction"/"distractions".

**Computation for a day** (`DaySummaryStats`, the cards of logical day D):
1. Convert each card's display times to minutes since 4 AM: `m - 240` if `m >= 240`, otherwise
   `m + 1200`. If end < start, add 1440 to end. Clip to [0, 1440] and drop empty ranges.
2. Drop System cards: category named "system", or a category flagged `isSystem`.
3. **Remove overlaps** so each minute counts once:
   - sort by start; for equal starts put the longer card first; for full ties, the smaller recordId
     first;
   - trim each card's start to `coveredUntil`.
4. **Total captured** = the sum of the normalized durations.
5. **Focus duration** = the sum over cards whose category matches a focus snapshot. A card matches
   when its category name resolves to a current category whose UUID is in the snapshots, or when
   its name equals a snapshot name.
6. **Distracted duration** = the same sum with the distraction snapshots.
7. **Focus blocks**: merge focus intervals whose gap is < 5 min.
8. Category durations (for the donut chart) are sorted by displayed minutes descending, then
   category order, then name.

**Header display** (`DayGoalHeader`):
- Focus: `formatCompactHours(focus)` + `/ ${target} hr fulfilled`. Hours are shown as an integer
  when within 0.01 of one, otherwise with 1 decimal. The bar is segmented by up to 4 focus
  categories (their own durations), with an "over target" state when focus > target.
- Distraction: `remaining = max(0, limit - distracted)` shown as `remaining / limit`. Once over the
  budget it shows `distracted / limit used`, and the bar ratio is clamped to 0..1.
- A skipped plan renders disabled with a "Set goals" button.
- Recording state captions:
  - "Tracking progress from your focus and distraction categories."
  - "Dayflow is paused. Resume to continue tracking your progress."
  - "Start Dayflow to continue tracking your progress."

**Daily goal prompt** (`requestDailyGoalPromptIfNeeded`). The conditions, in order:
1. The user does not get the Daily Brief.
2. `showDailyGoalPopups` is true.
3. It has not already been handled today (`dailyGoalPromptHandledDay`).
4. No plan row exists for today. If one exists, mark today handled.
5. `countDistinctTimelineDays(excluding today) >= 3`.
6. `consecutiveSkippedDayGoalCount(before today, limit 5) < 5`.

When all pass, switch to the Timeline on today and present the flow:
- The flow opens on **"Yesterday's review"** when yesterday has an explicit, non-skipped plan and
  the review has not been shown today. Otherwise it opens on **setup**.
- The review shows yesterday's focus and distraction against yesterday's carried-forward plan, plus
  per-focus-category durations.
- Setup reference stats for the selected categories:
  - "yesterday" = the category minutes for D-1;
  - "last week average" = the sum over D-1…D-7 divided by 7.
- **Confirm** saves the normalized plan for today (sort orders reindexed, snapshots re-resolved).
  **Skip** saves the current plan with `isSkipped=true`.
- Toggling a category in the right panel saves immediately.

---------------------------------------------------------------------------------------------------

## 7. macOS / Dayflow-backend specifics to drop or adapt

1. **Dayflow hosted backend recap provider.** The `generateDaily` endpoint uses a PostHog
   distinct-id token and a server-side prompt. Drop it, or keep it hidden. The observations and
   prior-standup inputs only exist for it.
2. **Brief allowlist**: `zhengyu.j.liu@gmail.com`, `maggiechangjx@gmail.com`, and Dayflow account
   sign-in. Replace with a local setting toggle.
3. **Claude CLI on Windows.** The Swift code runs `cd … && exec claude …` through the user's login
   shell (zsh with `-l -i`). Instead, spawn `claude` directly with `cwd`, resolving `claude.cmd`
   from PATH or npm global. Pass the prompt on stdin.
   - The PreToolUse hook command `/bin/sh '<file>.sh'` must become `node "<hook>.js"` or similar,
     with the same logic.
   - The `Read(//<abs path>/**)` permission rule format must be checked against Windows paths.
   - `realpath` resolution of `/private/var` is macOS-only.
4. **Dayflow MCP server**: `<App>.app/Contents/Helpers/dayflow mcp`. It is optional. Omit
   `--mcp-config` if the Windows app has no MCP server. The `mcp__dayflow__*` mentions in the prompt
   can stay, or be removed in a Windows-specific template.
5. **Screenshots for candidates**: `FrameStore.image(for:maxPixelSize:)` and the CoreGraphics JPEG
   writer. Replace with the Windows frame store plus `sharp` or nativeImage resize to 1280 px and
   JPEG quality 80.
6. **Hand-off "paste"**: `NSPasteboard`, `NSWorkspace` bundle IDs (`com.anthropic.claudefordesktop`,
   `com.openai.chat`), and the Cmd+V CGEvent that needs Accessibility permission. On Windows use the
   clipboard, launch the Claude or ChatGPT desktop app (or the web URL fallback), and optionally
   send Ctrl+V.
   - "Run" mode: replace `/bin/sh -c "{…} > out 2>&1; echo $? > out.exit"` with a Node
     `child_process.spawn` that writes the output and exit-code files.
7. **`recentClaudeProjects`** reads `~/.claude.json` and folder names under `~/.claude/projects`
   with `/` and `.` replaced by `-`. The Windows encoding of these folder names differs, for example
   for a path like `C:\…`. Adapt it or drop it.
8. **Name**: `NSFullUserName()` should become `os.userInfo().username` or the Windows display name.
   `TimeZone.current.identifier` should become `Intl.DateTimeFormat().resolvedOptions().timeZone`.
9. **Storage paths**: `~/Library/Application Support/Dayflow/daily_brief` should become
   `app.getPath('userData')/daily_brief`. The UserDefaults keys should move to an electron-store
   with the same names. The Keychain Gemini key should move to the Windows credential store or
   safeStorage.
10. **Notifications**: the UNUserNotificationCenter permission flow and the "open System Settings →
    Notifications" link become Electron `Notification` (Windows toast). There is no permission step,
    so the unlock flow's notification gate can be dropped. The recap notification click should open
    the Daily tab for `userInfo.day`.
11. **The menu-bar "brief is ready" notice** anchored under the status item should become a tray
    balloon, a toast, or an in-app banner.
12. **Visual-only details** can be simplified: the Daybreak header animation, card-stack swipe
    physics, scan and reveal light effects, the hand-off transition styles (genie, slide, zoom, the
    placeholder pixel crab), the Instrument Serif and Figtree fonts, and trackpad two-finger swipe.
13. **Analytics** (PostHog `AnalyticsService.capture` events) are not functionally required.
14. **The Swift date encoding** of `generatedAt` in `payload_json` uses the Apple reference-date
    epoch. Only match it if you exchange DBs with macOS.
15. **Model IDs** `gpt-6.1-sol`, `gpt-5.6-sol`, and `opus` are hard-coded. Keep them configurable.


---

## Windows port: deviations after the security review

- Brief runs offer **WebSearch only** (no WebFetch), and MCP servers that look like generic web/browser access are blocked: with connectors loaded, a fetch tool is an exfiltration channel.
- `related_reading[].imageUrl` was removed; the brief shows no remote images.
- The PreToolUse hook is an **allowlist** (every word of the tool name must be a read verb or known noun; `download` is denied). In addition ~500 write-verb `permissions.deny` rules are passed in the run's settings file, and after each run every MCP call must have a matching hook log line, otherwise that part's output is discarded.
- The "Run" hand-off uses `claude --permission-mode default` / `codex exec -s read-only` and requires a main-process confirmation that shows the full prompt.
