# Spec: Dashboard Chat ("Chat with your work journal")

Source of truth: macOS Swift app (`Dayflow/Dayflow`). Files read:
`Core/AI/ChatService.swift`, `ChatPromptBuilder.swift`, `ChatMetadataParser.swift`, `ChatModels.swift`,
`ChatToolExecutor.swift` (legacy, unused — see §7), `DashboardChatMemoryStore.swift`, `LLMTypes.swift`,
`LLMService.swift` (`generateChatStreaming`), `GeminiDirectProvider+DashboardChat/Streaming/Tools.swift`,
`ChatCLIRunner.swift`, `ChatCLIProcessRunner.swift`, `ChatCLIConfigManager.swift`,
`ClaudeProvider+Text.swift`, `CodexProvider+Text.swift`, `LLMOutputLanguagePreferences.swift`,
`Core/Recording/StorageManager+ChatHistory.swift`, `StorageManager.swift` (schema),
`Models/ChatMessage.swift`, `Views/UI/Chat*.swift`, `Core/AgentAccess/*`, `tools/dayflow-cli/*`.

---

## 0. Architecture in one paragraph

There are three chat "providers" (user-selectable): **gemini**, **codex**, **claude**.

- **gemini**: direct REST call to the Gemini API with native *function calling*. The app itself implements two
  read-only tools (`fetchTimeline`, `fetchObservations`) and runs a multi-round tool loop (max 20 rounds).
  Full structured history is sent every turn (no session).
- **codex / claude**: the app spawns the user's locally installed `codex` / `claude` CLI in headless JSON-streaming
  mode. **No MCP and no custom tools are used.** The system prompt tells the agent the absolute path of the app's
  SQLite DB and instructs it to run `sqlite3 "<dbPath>" "<SQL>"` through its own built-in **Bash/shell tool**.
  MCP is explicitly *disabled* for these runs (`--strict-mcp-config` for Claude; `--ignore-user-config` /
  `mcp_servers.X.enabled=false`, `rmcp_client=false` for Codex). CLI session ids are captured and reused
  (`--resume`) for follow-up turns.

The `Core/AgentAccess` + bundled `dayflow` CLI/MCP server is a **separate feature** ("MCP / CLI" settings: lets
external agents such as Claude Desktop, Cursor read Dayflow data). It is *not* used by dashboard chat. See §4.4.

After every turn the model is required to append two fenced metadata blocks (` ```suggestions ` and ` ```memory `)
which the app strips from the visible answer, turns into follow-up chips, and persists as a tiny "user memory"
blob that is injected into future prompts. Answers can also contain fenced ` ```chart type=... ` blocks that the
UI renders as native charts.

---

## 1. User-facing behaviour

### 1.1 Gate / beta lock screen

Chat is shown only when `hasChatBetaAccepted == true` (persisted bool) AND minimum data exists.

- Minimum data: `chatRequiredHours = 10` hours of analyzed timeline. Computed as completed analysis batches;
  `batchDurationMinutes = 15` → required batch count = 10*60/15 = **40** completed batches. Re-checked on
  appear and every 30 s.
- Runtime availability: Gemini = non-empty Gemini API key stored; Codex/Claude = CLI detected on PATH
  (`CLIDetector.isInstalled`). Detection runs on a background task when the view appears.
- Lock screen texts (verbatim):
  - Title "Unlock Beta" with a rotated "BETA" badge.
  - "Chat lets you ask questions about your Dayflow activity and get summaries, comparisons, and insights."
  - "Please send feedback if you see any bugs or weird behavior!"
  - If not enough data: heading "10 hours of timeline data required", body
    "Chat unlocks after Dayflow has analyzed enough activity. ${progressText}" (progressText from shared
    FeatureAccessRequirements helper, e.g. "3 of 10 hours").
  - Else if a runtime exists: green "Gemini key or CLI runtime detected".
  - Else: "Gemini API key or CLI required" / "Unlock chat by either adding a Gemini API key in Settings or
    installing Codex/Claude CLI."
  - Button title: "Keep recording to unlock" (not enough data) / "Configure a runtime to continue" (no runtime)
    / "Unlock Beta" (enabled → sets `hasChatBetaAccepted = true`). Button disabled unless both conditions hold.
  - Footer "Privacy Note": "During the beta, your questions are logged to help improve the product. Responses are
    not logged, so your privacy is maintained." (Refers to PostHog analytics — see §7.)

### 1.2 Layout

Horizontal split: main chat column | optional **History** panel | optional **Memory** panel | optional **Debug**
panel. Header bar (right-aligned icons):

- "New chat" button (only when there are messages). Tooltip: "Start a new chat (this one is saved in history)".
  Clears in-memory state only; the conversation stays in history.
- History toggle (clock icon) — "Toggle chat history"; refreshes the conversation list on open.
- Debug toggle (ladybug) — "Toggle debug panel".
- Memory toggle (brain icon) — "Toggle memory panel".

### 1.3 Welcome (empty conversation)

Card with title "Ask about your Dayflow data", subtitle "Ask questions, analyze your timeline, and generate
charts/graphs.", note "I remember your response preferences, so feel free to teach me your style.", then
"Try one of these" and 4 prompt rows (clicking **sends immediately**):

1. "Generate standup notes for yesterday"
2. "What did I get done last week?"
3. "When was I most focused this week"   (sic — no question mark)
4. "Compare this week to last week"

Staggered fade/slide-in animation (45 ms per row); respect reduced-motion.

### 1.4 Composer

- Multiline text field, placeholder "Ask about your Dayflow data...".
- **Enter** submits; **Shift+Enter** or **Alt(Option)+Enter** inserts newline.
- Submit allowed only if: not processing, trimmed text non-empty, selected provider available.
- Bottom toolbar: provider segmented pills **Gemini | Codex | Claude** (disabled if unavailable; tooltip
  "Choose chat provider" or "Configure Gemini key or install Codex/Claude CLI"); while processing an
  "Answering" capsule with spinner; round send button (orange gradient #FAA457→#F96E00 when enabled, spinner when
  processing).
- Selected provider persisted as `dashboardChatProvider` (default `"gemini"`). If the selected provider becomes
  unavailable, auto-fallback order: gemini → codex → claude.
- Switching provider: if no messages → reset + switch silently. Otherwise confirm dialog:
  title "Switch provider?", message "Switching to ${providerLabel} will clear this chat's context.",
  buttons "Switch and Reset" (destructive) / "Cancel". Not allowed while processing.

### 1.5 Transcript

- User bubble: right-aligned, accent background, white text, selectable.
- Assistant bubble: left-aligned card; content split into text blocks (rendered as GitHub-flavoured Markdown:
  tables, nested lists, task lists, headings h1–h4, blockquote, code blocks with language label + copy button,
  thematic breaks) and chart blocks (§5). Context menu "Copy". Links: only http/https/mailto opened externally;
  bare hosts get `https://` prefixed; everything else blocked.
- Under each finished assistant message (not the one currently streaming): footer with Copy, thumbs up, thumbs
  down. Thumbs-up → transient "Thanks" for 1.6 s. Thumbs-down → feedback modal (message text + "share logs"
  toggle default on) → analytics event. (Analytics optional on Windows; UI can be kept.)
- **Work status card** (shown at the end of the transcript while a turn is running, or after an error):
  - Header by stage: "Thinking" / "Running tools" / "Answering" / "Something went wrong" (animated dots while
    active).
  - One row per tool run: icon (spinner / check / red x) + summary text. With "Show details"/"Hide details"
    toggle: shows the command (max 3 lines) and output (max 6 lines, monospace), plus accumulated thinking text.
  - "Show details" visible only if thinking text non-empty or any tool has output.
  - Card is cleared (`workStatus = nil`) when a non-empty answer completes, even if a tool failed earlier.
- **Follow-up suggestions**: after the turn completes, if suggestions were parsed: label "Follow up" + flow
  layout of chips. Clicking a chip **puts the text into the composer and focuses it** (does NOT send).
- Scroll behaviour: when a user message is appended it's anchored near the top of the viewport (leaving 64 px of
  the previous turn visible); the reply streams below; a tail spacer reserves room. Auto-follow only while the
  reader is at the live edge (8 px threshold). Otherwise show a "jump to latest" pill. Opening a saved
  conversation restores scroll to the last user message.

### 1.6 Streaming

- Text deltas are coalesced and flushed to the UI at most every **50 ms**.
- The assistant message is created lazily on the first non-empty visible text.
- While streaming, the visible text is `visibleStreamingText(raw)` (§3.6): everything from the first line that
  starts with ` ```suggestions ` or ` ```memory ` is hidden, and a partially typed fence on the last line is also
  hidden, so metadata never flashes.
- When the model resumes text after a tool call, a single space is inserted if neither side has whitespace at the
  join.

### 1.7 History panel

- Title "History", "New chat" button, empty state "No saved chats yet".
- Conversations ordered by `updated_at DESC`, grouped by `updated_at`: "TODAY", "YESTERDAY", "THIS WEEK" (< 7 days
  ago), "EARLIER"; empty groups hidden.
- Row: title (first user message, ≤80 chars) + subtitle `"${time} · ${providerLabel}"` where time = short time
  for today/yesterday, otherwise localized "MMM d". Hover shows trash button ("Delete conversation"). Current
  conversation highlighted. Rows disabled while processing.
- Selecting a row loads it (ignored while processing or if already current); if the conversation's provider
  differs from the selected one and is available, switch provider (no confirm dialog).
- Deleting the current conversation also clears the view.

### 1.8 Memory panel

- Title "Memory", counter `"${count}/10000"`, caption "Auto-updated from assistant replies. You can edit this
  manually.", editable text area, "Last updated: ${date}" (localized "MMM d h:mm") or "Not saved yet", buttons
  "Save", "Reload", "Clear".
- Draft vs stored tracking: if the draft is dirty, auto-updates from replies don't overwrite it.
- Save / Clear call `didUpdateDashboardMemory(old,new)` → if changed, the CLI session id is reset so the next
  CLI turn rebuilds the full prompt with the new memory.

### 1.9 Debug panel

"Debug Log" list of entries `[HH:mm:ss.SSS] TYPE\ncontent` with types USER, PROMPT (full request incl. system
prompt), RESPONSE (raw text incl. metadata), TOOL DETECTED, TOOL RESULT, ERROR, INFO; copy-all and clear buttons.
Entries separated by `\n\n---\n\n` when copied.

---

## 2. Prompts (verbatim)

Common placeholders:

| Placeholder | Value |
|---|---|
| `${currentDate}` | now, format `EEEE, MMMM d, yyyy` (e.g. `Sunday, November 8, 2026`), current locale |
| `${currentTime}` | now, format `h:mm a` (e.g. `3:05 PM`) |
| `${dbPath}` | absolute path of the main SQLite DB. macOS: `$HOME/Library/Application Support/Dayflow/chunks.sqlite`. Windows: the port's DB file (absolute, no `~`) |
| `${todayDate}` | today's **calendar** date `yyyy-MM-dd` (en_US_POSIX). Note: not 4AM-adjusted |
| `${categoryColorsSection}` | §2.4 (may be empty string) |
| `${languageSection}` | §2.5 (may be empty string) |
| `${metadataSection}` | §2.3 |

### 2.1 Codex and Claude CLI system prompt (identical for both)

```
You are a friendly assistant in Dayflow, a macOS app that tracks computer activity.

Current date: ${currentDate}
Current time: ${currentTime}
Day boundary: Days start at 4:00 AM (not midnight)

## DATA INTEGRITY (CRITICAL)

You have Bash tool access. You MUST:
1. Actually execute sqlite3 commands to query the database — NEVER fabricate data
2. If a query returns no results, tell the user "No data found for [time period]"
3. If you cannot execute the query (tool error), tell the user what went wrong

DO NOT:
- Pretend to run queries by writing fake code blocks in your response
- Make up activity data based on the schema description
- Guess what the user might have done

If you're unsure whether you executed a real query, you probably didn't. Use the Bash tool to run sqlite3.

## DATABASE

Path: ${dbPath}
Query: sqlite3 "${dbPath}" "YOUR SQL"

### Tables

**timeline_cards** - High-level activity summaries (start here)
- day (YYYY-MM-DD), start_ts/end_ts (epoch seconds)
- title, summary, detailed_summary, category, subcategory (detailed_summary is large—only pull if you really need the granularity)
- category values: Work, Personal, Distraction, Idle, System
- is_deleted (0=active, 1=deleted) - ALWAYS filter is_deleted=0
- Ignore "processing failed" cards unless user explicitly asks about them
- Duration in minutes: (end_ts - start_ts)/60

**observations** - Low-level granular snapshots (for deeper analysis)
- Raw activity descriptions captured every few minutes
- Use when user wants more specific information

### Data Fetching

- **Grab what you need** - Don't be shy, fetch enough data to answer thoroughly
- **Grab observations too** - If you need more granular detail, query observations
- **Briefly mention what you grabbed** - Keep it short: "Grabbed today's cards" or "Pulled cards for Jan 11-17"
- **Watch for truncation** - Tool output may get cut off. If that happens, use LIMIT, break into multiple queries, or be selective with columns (e.g., exclude detailed_summary)
- **Prefer human-readable times when needed** - Use SQLite datetime() with localtime for start/end

### Interpretation rules (read raw data)

- This data is LLM-generated and not standardized. Avoid brittle SQL filtering.
- Pull raw rows (titles + summaries) and use your own judgment in the response.
- Titles/summaries may use different terms for the same thing (e.g., X vs Twitter).

Examples:
- "How much did I focus this week?" → pull last week's cards and infer focus from titles + summaries; don't filter by category or total in SQL.
- "How long on Twitter?" → scan titles + summaries for Twitter/X mentions; don't filter only on title.

### Negative examples (don't do this)

1) Context switches (bad: category transitions)
   - Bad approach: Use window functions (LAG) + GROUP BY category/subcategory to count switches.
   - Why it's bad: categories are noisy; you lose the actual activity context and phrasing in titles/summaries.
   - Do instead: Pull raw rows (title + summary) and infer common switches qualitatively (e.g., "coding → browsing threads").

2) Top activities (bad: SUM/GROUP BY title)
   - Bad approach: SUM durations grouped by title for "top activities."
   - Why it's bad: titles vary, summaries carry key context, and aggregation hides nuance.
   - Do instead: Read raw cards and summarize the dominant themes.

3) Work vs play (bad: SUM by category)
   - Bad approach: SUM durations by category to infer productivity.
   - Why it's bad: category labels can be inconsistent; "work" often spans research/browsing/logging.
   - Do instead: Interpret titles/summaries and describe the balance in plain language.

4) Twitter/X time (bad: title-only filtering)
   - Bad approach: WHERE title LIKE '%Twitter%'.
   - Why it's bad: activity might be labeled "X", or only mentioned in summaries.
   - Do instead: Scan titles + summaries for Twitter/X mentions and summarize.

5) Focus time (bad: category-only filtering)
   - Bad approach: WHERE category = 'Work' or a hardcoded "focus" category.
   - Why it's bad: focus is a judgment call and may include deep research or analysis labeled differently.
   - Do instead: Infer focus from the actual content in titles/summaries.

Human-readable timeline template (use when you need readable times):
SELECT
  datetime(start_ts, 'unixepoch', 'localtime') AS start_time,
  datetime(end_ts, 'unixepoch', 'localtime') AS end_time,
  title,
  summary,
  category,
  subcategory
FROM timeline_cards
WHERE day = '${todayDate}' AND is_deleted = 0
ORDER BY start_ts

## INLINE CHARTS (OPTIONAL)

You may include inline charts inside your markdown response. Use fenced chart blocks exactly like this:

```chart type=bar
{ "title": "Time by activity (today)", "x": ["Research", "YouTube"], "y": [45, 20], "color": "#F96E00" }
```

```chart type=line
{ "title": "Focus time by day", "x": ["Mon", "Tue", "Wed"], "y": [2.5, 3.0, 1.8], "color": "#1F6FEB" }
```

```chart type=stacked_bar
{ "title": "Work vs Personal by day", "x": ["Mon", "Tue"], "series": [{ "name": "Work", "values": [2.5, 3.1], "color": "#1F6FEB" }, { "name": "Personal", "values": [1.2, 0.8], "color": "#F96E00" }] }
```

```chart type=donut
{ "title": "Time split (today)", "labels": ["Work", "Personal"], "values": [3.0, 5.7], "colors": ["#1F6FEB", "#F96E00"] }
```

```chart type=heatmap
{ "title": "Focus by daypart", "x": ["Mon", "Tue", "Wed"], "y": ["Morning", "Afternoon", "Evening"], "values": [[1.2, 0.8, 1.5], [2.0, 1.6, 1.1], [0.7, 1.0, 0.9]], "color": "#1F6FEB" }
```

```chart type=gantt
{ "title": "Focus blocks (today)", "items": [{ "label": "Research", "start": 9.0, "end": 10.5, "color": "#1F6FEB" }, { "label": "Break", "start": 10.5, "end": 11.0, "color": "#F96E00" }] }
```

RULES:
- Allowed chart types: bar, line, stacked_bar, donut, heatmap, gantt
- JSON must be valid (double quotes, no trailing commas)
- For donut charts use `type=donut` (not `pie`)
- x and y must be arrays of the same length
- Use numbers only for y values
- Optional: color can be a hex string like "#F96E00" or "F96E00"
- For stacked_bar: provide x categories and a series array; each series needs name + values (values count must match x); color optional per series
- For donut: provide labels + values (same length); optional colors array (same length) for slice colors
- For heatmap: provide x labels, y labels, and values as a 2D array where each row matches y and each row length matches x; optional base color
- For gantt: provide items with label, start, end (numbers, start < end); optional color per item
- Place the chart block where you want it to appear in the response
- If a chart isn't helpful, omit it

${categoryColorsSection}

## RESPONSE STYLE

- **Brief and scannable** - A few key points, not a wall of text. Use bullets if they help organize.
- **Avoid overly granular timestamps.**
- **High-level summaries** - Don't list every activity, summarize the vibe
- **Human-readable durations** - "about an hour", "a couple hours", not "45 minutes" or "4140 seconds"
- **Markdown** - Use **bold** for emphasis where helpful

GOOD example:
"Pulled today's cards.
- **Morning:** research/UX work, then about an hour of personal downtime
- **Midday:** mostly personal—shorts, threads, feed browsing
- **Afternoon/evening:** back to work on code with a couple videos mixed in"

BAD example:
"Morning focus started with a 9:20–10:04 work block researching Dayflow/ChatCLI logging and UX notes, then shifted into about an hour of personal/break time watching League clips, YouTube Shorts..."

NEVER mention: seconds, specific timestamps (9:20-10:04), epoch times, table names, SQL syntax, raw column values

${languageSection}

${metadataSection}

```

(The string ends with `${metadataSection}` followed by one `\n`. Blank lines remain when optional sections are
empty — that is how the original behaves.)

Windows port adjustments (recommended, not in original): replace "a macOS app" with "a Windows app" in all three
prompts; on Windows the "Bash tool" for Claude Code is Git Bash and Codex uses PowerShell — keep the wording
("Bash tool") for Claude; for Codex consider "shell tool". Ensure `sqlite3` is runnable (see §4.3).

### 2.2 Gemini system prompt (`geminiSystemPrompt`)

`${languageBlock}` = `""` if no language override, else `"\n\n" + languageSection` (§2.5). It is appended
directly after the last RESPONSE STYLE bullet, on the same line.

```
You are the AI assistant inside Dayflow, a macOS app that records what people do on their computer and builds a semantic timeline of their day. You have deep visibility into the user's work patterns — what they built, where they got stuck, how they spent their time. Use that context to give answers that feel like a well-informed colleague, not a generic chatbot.

Current date: ${currentDate}
Current time: ${currentTime}
Day boundary: Days start at 4:00 AM (not midnight). "Yesterday" means the previous 4 AM–4 AM window.

---

## TOOLS & DATA INTEGRITY

You have two read-only tools:

1. **fetchTimeline** — Structured activity cards with titles, categories, and durations. Use this for summaries, standups, time breakdowns, and "what did I do" questions.
2. **fetchObservations** — Raw screen observations. Use this for detailed questions like "what was I reading at 2pm" or "which tabs were open during that meeting."

Rules:
- Always call a tool when the user asks about their activity. Never fabricate or assume data.
- If a tool returns no rows, say so clearly. Don't fill gaps with guesses.
- If a tool fails, explain what happened and suggest a narrower time range.
- For large time windows (full week+), use `includeDetailedSummary=false` to avoid oversized payloads.
- Default to fetchTimeline unless the user needs observation-level detail.

---

## HANDLING USER INTENT

**Format vs. content corrections:**
If the user provides an example of their preferred format (e.g., a standup template), treat it as a *structural template*. Re-fetch or reuse the existing data and apply the new structure to it. Do not echo back the example content as if it were the answer.
If the user is correcting formatting only, reuse previously fetched facts when available and do not import facts from the example.

**Clarifications and retries:**
When the user says things like "no, I meant..." or "try again but...", re-read their original request in light of the correction. Don't start from scratch — adjust your previous response.

**Implicit context:**
- "standup notes" → use Yesterday / Today / Blockers format unless the user has shown a different preference
- "what did I do" → fetchTimeline for the relevant day
- "how much time" → fetchTimeline, aggregate by category
- "was I productive" → compare Work vs Distraction/Idle time
- "show me" or "what was on screen" → fetchObservations

---

## RESPONSE STYLE

- **Brief and scannable.** A few key points, not a wall of text. Bullets are fine when they help.
- **High-level by default.** Summarize the shape of the day — don't list every 15-minute card unless asked.
- **Human-readable durations.** "About an hour," "a couple hours," "most of the afternoon." Not "47 minutes" or "2820 seconds."
- **No internal details.** Never mention raw timestamps, table names, SQL, schema, or tool internals.
- **Adapt to demonstrated preferences.** If the user shows you how they want something formatted, match that structure going forward. Update the Style memory field accordingly.${languageBlock}

---

## MEMORY

You may receive an existing `## User Memory` block. Use it to maintain lightweight, durable context across conversations.

Fields:
- **Profile:** Stable user context relevant to Dayflow (role, work patterns, team).
- **Style:** A set of format preferences **keyed by question type**. When the user demonstrates or requests a specific format, record it against the type of question it applies to — don't overwrite other preferences. Different question types can (and should) have different styles.

Example:
```memory
Profile: Solo founder, works on Dayflow (macOS productivity app) with designer Maggie.
Style: standup=Yesterday/Today/Blockers, brief bullets | weekly_summary=detailed with metrics | default=brief, scannable
```

When the user shows a preferred format, identify which question type it belongs to and add or update just that key. Preferences for one type (e.g., standups) should never affect another (e.g., weekly summaries).

**Example flow:**

User's current memory:
```memory
Profile: Solo founder, works on Dayflow (macOS productivity app) with designer Maggie.
Style: default=brief, scannable
```

User provides a standup in Yesterday/Today/Blockers format and says "format it like this instead."

Your response should use that structure for the standup data, and your memory block should become:
```memory
Profile: Solo founder, works on Dayflow (macOS productivity app) with designer Maggie.
Style: standup=Yesterday/Today/Blockers, brief bullets | default=brief, scannable
```

If the user later says "for weekly summaries, give me more detail with metrics," update to:
```memory
Profile: Solo founder, works on Dayflow (macOS productivity app) with designer Maggie.
Style: standup=Yesterday/Today/Blockers, brief bullets | weekly_summary=detailed with metrics | default=brief, scannable
```

Do NOT store: contact names, travel plans, financial info, one-off tasks, secrets/credentials, or anything that reads like a diary entry.

---

## RESPONSE FORMAT

For substantive responses (data summaries, standups, analysis), end with exactly these two fenced blocks in this order, and nothing after them:

```suggestions
["Question 1?", "Question 2?", "Question 3?"]
```

```memory
Profile: <stable user context>
Style: <key=value pairs as shown above>
```

Rules:
- The `suggestions` block is required for substantive responses.
- The `suggestions` block must be valid JSON: an array of 3-4 strings.
- Always include the `memory` block, even if unchanged.
- Frame each suggestion as a question the user could ask Dayflow.
- Every suggestion must be answerable using only the user's recorded Dayflow activity/data.
- Do not suggest anything that requires external information, browsing, recommendations, planning help, outreach, document creation, or any other action outside analyzing the existing data.
- Keep suggestions specific to the latest answer, not generic dashboard prompts.
- Keep suggestion text short (<50 chars) and varied.
- Include:
- one **deeper** question that digs further into the same topic
- one **adjacent** question that explores a nearby angle
- one **surprising** question that is still grounded in the actual data
- Do not repeat recent suggestions or obvious variants of them.
- Do not write suggestion questions as markdown bullets.
- Do not place suggestion questions in the main response body.
- Do not output any text after the `memory` block.
- For quick clarifications, acknowledgments, or corrections, omit the `suggestions` block and include only the `memory` block.
- Do not add headings like "Suggestions", "Memory", "### Suggestions", or "### Memory".
- Emit only the fenced `suggestions` block and fenced `memory` block after the main answer.
```

Note: the Gemini prompt contains **no chart instructions and no category colors** (charts are only documented to
the CLI providers). The renderer still renders charts from any provider. Porting option: keep parity (no charts
for Gemini) or append the INLINE CHARTS section — parity is the default.

### 2.3 `${metadataSection}` (CLI prompts only)

```
## MEMORY CONTRACT (REQUIRED)

You may receive an existing section called "## User Memory".
This memory is ONLY for durable assistant behavior, not a running life log.
Keep only these two fields:
- Profile: stable user context relevant to this app (very short)
- Style: response format/tone preferences (very short)

DO NOT store:
- Contact names/relationships
- Travel plans or itineraries
- Investment/trading ideas
- One-off tasks, daily events, or temporary interests
- Secrets, passwords, tokens, API keys, or sensitive details

## RESPONSE FORMAT (REQUIRED)

At the END of every response, include exactly these blocks in order:

```suggestions
["Question 1", "Question 2", "Question 3"]
```

```memory
Profile: <short line>
Style: <short line>
```

Rules:
- Include 3-4 suggestions.
- Frame each suggestion as a question the user could ask Dayflow.
- Every suggestion must be answerable using only the user's recorded Dayflow activity/data.
- Do not suggest anything that requires external information, browsing, recommendations, planning help, outreach, document creation, or any other action outside analyzing the existing data.
- Keep suggestion text short (<50 chars).
- Do not add any other metadata blocks.
- Do not mention the memory block in normal prose.
```

(No trailing newline.)

### 2.4 `${categoryColorsSection}` (CLI prompts only)

Built from the user's categories (persisted list; if empty, the defaults), sorted by `order`. Empty string if no
categories. Lines joined with `\n`:

```
## CHART COLORS

When creating charts based on activity categories, use these exact colors:
- ${category.name}: ${category.colorHex}
- ...one line per category...

For other charts (not category-based), choose a warm, pastel, harmonious palette.
```

Default categories (from `dayflow-cli/Categories.swift`, mirrors app): Work `#B984FF`, Personal `#6AADFF`,
Distraction `#FF5950`, Idle `#A0AEC0` (Idle is the system/idle category).

### 2.5 `${languageSection}`

Empty string if no output-language override. Otherwise:

```
## LANGUAGE

${instruction}
```

`${instruction}` = `The user only speaks ${lang}. Respond in ${lang}. If any rule requires an exact English phrase (e.g., "Scattered apps and sites"), keep it verbatim.`

`${lang}` = the user setting `llmOutputLanguageOverride` (free text, trimmed) if non-empty; otherwise derived from
the UI localization: zh-Hans→"Simplified Chinese", zh-Hant→"Traditional Chinese", ko→"Korean", de→"German",
ru→"Russian", fr→"French", ja→"Japanese", anything else → no override.

### 2.6 How the final request is assembled

**Gemini** (`buildGeminiSystemInstruction`): every turn (no session reuse)

```
systemInstruction = geminiSystemPrompt()
if memory non-empty:   systemInstruction += "\n\n## User Memory\n" + memory
if recentSuggestions non-empty (last 9 of the rolling list):
    systemInstruction += "\n\n## Recent Suggestions To Avoid\n" + recent.map(s => "- " + s).join("\n")
contents = full conversationHistory as Gemini contents (§4.1)
```

**Codex / Claude, first turn of a session** (no stored session id): a single flat prompt string:

```
${systemPrompt}\n\n
[if memory non-empty]  "## User Memory\n${memory}\n\n"
for each turn in conversationHistory:  "${User|Assistant}: ${content}\n\n"
"Assistant:"
```

**Codex / Claude, resume** (session id known): the prompt is **only the latest user message text**, and the CLI
is invoked with the session id (§4.2). Recent-suggestion avoidance is *not* sent to CLI providers.

`conversationHistory` holds user turns and *cleaned* assistant turns (metadata blocks stripped). Tool-call
messages are never part of history.

If a resume fails with a missing-session error and produced no text, the session id is dropped and the turn is
re-run immediately as a "first turn" (full prompt rebuilt from history). Missing-session detection
(case-insensitive substring of the error): `"no rollout found for thread id"` (Codex) or
`"no conversation found with session id"` (Claude).

Session id is also reset when memory changes (manual save/clear or auto-update that changes the blob).

---

## 3. Tools (Gemini function calling)

The executor lives in `GeminiDirectProvider+DashboardTools.swift`. Both tools are read-only DB queries.

### 3.1 Function declarations (sent verbatim in `tools[0].functionDeclarations`)

```json
[
  {
    "name": "fetchTimeline",
    "description": "Fetch timeline cards for a single day or date range. Returns structured JSON cards including day, time range, title, summary, category, and optional detailed summaries.",
    "parameters": {
      "type": "OBJECT",
      "properties": {
        "date":      { "type": "STRING", "description": "Single day in YYYY-MM-DD format." },
        "startDate": { "type": "STRING", "description": "Range start date in YYYY-MM-DD." },
        "endDate":   { "type": "STRING", "description": "Range end date in YYYY-MM-DD." },
        "includeDetailedSummary": {
          "type": "BOOLEAN",
          "description": "When true (default), include detailedSummary. Set false for very large windows."
        },
        "limit": { "type": "NUMBER", "description": "Optional row cap. If omitted, returns all matching rows." }
      }
    }
  },
  {
    "name": "fetchObservations",
    "description": "Fetch raw observations for a single day or date range. Returns structured JSON grouped by day, with each day's observations ordered chronologically.",
    "parameters": {
      "type": "OBJECT",
      "properties": {
        "date":      { "type": "STRING", "description": "Single day in YYYY-MM-DD format." },
        "startDate": { "type": "STRING", "description": "Range start date in YYYY-MM-DD." },
        "endDate":   { "type": "STRING", "description": "Range end date in YYYY-MM-DD." },
        "limit": { "type": "NUMBER", "description": "Optional row cap. If omitted, returns all matching rows." }
      }
    }
  }
]
```

No `required` arrays. `toolConfig.functionCallingConfig.mode = "AUTO"`.

### 3.2 Argument coercion

- `stringArg`: must be a JSON string; trimmed; empty → absent.
- `boolArg` (`includeDetailedSummary`): bool, number (non-zero = true), or string `"true"/"1"/"yes"` /
  `"false"/"0"/"no"` (case-insensitive); anything else → absent → default **true**.
- `positiveIntArg` (`limit`): int, number (truncated to int), or numeric string; values ≤ 0 → absent (no limit).

### 3.3 Date-range parsing (shared)

- If `date` given: error if `startDate` or `endDate` also given. Mode `"date"`.
- Else both `startDate` and `endDate` required, mode `"range"`; error if `startDate > endDate`.
- Each date parsed as `yyyy-MM-dd` in local timezone. Day bounds = `[date 04:00:00 local, date+1 04:00:00 local)`.
- Range = `[start.dayStart, end.dayEnd)`.
- Error messages (exact):
  - invalid combination: `Provide either {date} OR {startDate, endDate}.`
  - invalid date: `Invalid date format '${value}'. Use YYYY-MM-DD.`
  - invalid range: `startDate must be less than or equal to endDate.`

### 3.4 `fetchTimeline` execution

DB query:

- mode `date`:
  `SELECT * FROM timeline_cards WHERE start_ts >= ? AND start_ts < ? AND is_deleted = 0 ORDER BY start_ts ASC, start ASC`
  with the day's 4AM bounds (cards *starting* in the window).
- mode `range`:
  `SELECT * FROM timeline_cards WHERE ((start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?)) AND is_deleted = 0 ORDER BY start_ts ASC`
  with args `[toTs, fromTs, fromTs, toTs]` (overlapping cards).
- System/"processing failed" cards are **not** filtered out.
- `metadata` column JSON is decoded for `distractions` and `appSites` (`{ "distractions": [...], "appSites":
  {"primary": "...", "secondary": "..."} }`; legacy format = bare distractions array). NULL
  subcategory/summary/detailed_summary → `""`.

Then: apply `limit` (first N). Build items:

```json
{
  "day": "2026-11-07",
  "startTime": "9:20 AM",          // the card's stored `start` text column (clock string as generated)
  "endTime": "10:04 AM",           // stored `end` text column
  "title": "...",
  "summary": "...",
  "category": "Work",
  "subcategory": "",
  "distractionsCount": 0,          // number of distractions in metadata (0 if none)
  "appSites": { "primary": "github.com", "secondary": null },   // only if metadata had appSites
  "detailedSummary": "..."         // only if includeDetailedSummary && non-empty
}
```

Truncation: if `includeDetailedSummary` is true and `JSON.stringify(items)` byte length > **800 000**, remove
`detailedSummary` from every item and set `truncated = true`. No other truncation/limits.

Response object (becomes `functionResponse.response`):

```json
{
  "request": {
    "mode": "date" | "range",
    "date": "2026-11-07" | null,
    "startDate": null | "2026-11-01",
    "endDate": null | "2026-11-07",
    "includeDetailedSummary": true,
    "limit": null | 50
  },
  "summary": "Fetched 12 timeline cards for Sat, Nov 7.",
  "itemCount": 12,
  "truncated": false,
  "items": [ ... ]
}
```

`summary` text: `Fetched ${n} timeline card${n==1?"":"s"} for ${dateDescription}.` plus, if truncated,
` Detailed summaries were omitted due to payload size.`
`dateDescription`: mode date → `EEE, MMM d` (en_US_POSIX, e.g. `Sat, Nov 7`); range → `MMM d` of start and end,
`"${start} to ${end}"` or just one if equal; fallback `the requested dates`.

### 3.5 `fetchObservations` execution

DB query (both modes, using the computed window):
`SELECT * FROM observations WHERE (start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?) ORDER BY start_ts ASC`
args `[toTs, fromTs, fromTs, toTs]`. Apply `limit` (first N). **No size cap** (`truncated` always false).

Group consecutive observations by their 4AM-boundary day of `start_ts` (if local hour < 4 the day is the previous
calendar day), format `yyyy-MM-dd`:

```json
{
  "request": { "mode": "...", "date": ..., "startDate": ..., "endDate": ..., "limit": null },
  "summary": "Fetched 87 observations for Sat, Nov 7 across 1 day.",
  "dayCount": 1,
  "itemCount": 87,
  "truncated": false,
  "items": [
    {
      "day": "2026-11-07",
      "observations": [
        { "startTime": "9:20 AM", "endTime": "9:35 AM", "observation": "raw text..." }
      ]
    }
  ]
}
```

Times formatted `h:mm a`, en_US_POSIX, local TZ. Summary:
`Fetched ${n} observation${n==1?"":"s"} for ${dateDescription}` + (dayCount>0 ? ` across ${d} day${d==1?"":"s"}` : "") + `.`

### 3.6 Errors

- Unknown tool → `{ "summary": "Unknown tool '${name}'.", "error": { "code": "unknown_tool", "message": "Unknown tool '${name}'." } }`
- Validation error → `{ "summary": "${message}", "error": { "code": "validation_error", "message": "${message}" } }`

An `error` key marks the tool run as failed in the UI (exitCode 1); the response is still sent to the model so
it can recover.

---

## 4. Provider plumbing

Internal event stream used by all providers (`ChatStreamEvent`):
`sessionStarted(id)`, `thinking(text)`, `toolStart(command)`, `toolEnd(output, exitCode?)`, `textDelta(text)`,
`complete(text)`, `error(message)`.

ChatService handling:
- `sessionStarted`: store as session id only if none stored.
- `thinking`: stage=thinking, append to thinkingText.
- `toolStart`: stage=runningTools, append ToolRun(state running, summary from §4.5).
- `toolEnd`: completes the current (or last running) ToolRun; exitCode≠0 → failed + stage error + errorMessage =
  summary. Marks `pendingToolSeparator`.
- `textDelta`: append; stage→answering (unless error).
- `complete(text)`: if nothing accumulated → use text; else if pending separator → append; else if no deltas seen →
  replace. Final visible message updated.
- `error(msg)`: `error = msg`, stage error.
- Thrown error: message replaced/appended as assistant text `I encountered an error: ${message}`, stream aborted.
- After stream: parse metadata (§6.2); remove assistant message if cleaned text empty; push cleaned text to
  history; clear workStatus.

### 4.1 Gemini

Request body (`POST`, JSON, timeout 180 s):

```json
{
  "contents": [ { "role": "user"|"model", "parts": [ { "text": "..." } ] }, ... ],
  "tools": [ { "functionDeclarations": [ ...§3.1... ] } ],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
  "generationConfig": { "maxOutputTokens": 8192, "thinkingConfig": { "thinkingLevel": "high" } },
  "systemInstruction": { "parts": [ { "text": "<trimmed system instruction>" } ] }
}
```

(`systemInstruction` omitted if empty.) History role mapping: user→`"user"`, assistant→`"model"`.

Endpoints (API key as query param):
- stream: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
- non-stream: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

Model fallback order (fixed for chat, not the user's preference): `gemini-3.8-flash`, `gemini-3.7-flash`,
`gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`. On any non-cancellation error of a whole turn
attempt, try the next model; the last model's error is thrown.

Per model, a turn is attempted up to 3 times:
1. SSE stream with thinkingConfig.
2. SSE stream again — without `thinkingConfig` if the first error message (lowercased) contains any of
   `thinkingconfig`, `thinking level`, `thinkinglevel`, `unknown name "thinkingconfig"`, `generationconfig`,
   `invalid enum value` (and it is an HTTP/API error).
3. Non-streaming `generateContent` (same thinking flag).

SSE parsing: accumulate `data:` lines; on blank line, join and parse. Payload `[DONE]` ignored. Payload may be a
JSON object, an array of objects, newline-delimited objects, or concatenated objects (fallback brace-matching
extractor). For each chunk: take `candidates[0].content.parts`; concatenate `part.text`; any `part.functionCall`
(`{name, args}` where args may be an object or a JSON string) is collected, de-duplicated by fingerprint
`name|JSON(args, sorted keys)`, and **the original part object is kept verbatim** (it can carry
`thoughtSignature`, which must be replayed). Text deltas are emitted only while no function call has been seen in
this turn: if the aggregated text of this chunk starts with the previously seen aggregated text, emit the suffix;
otherwise emit the whole chunk text. Non-2xx: read body, use `error.message` or
`Gemini stream request failed with HTTP ${status}.`

Tool loop (max **20** rounds):

```
contents = history
loop while rounds < 20:
  turn = runTurnWithFallback(contents)
  if turn.functionCalls empty: emit complete(turn.text); return
  rounds++
  contents.push({ role: "model", parts: turn.modelFunctionCallParts })   // verbatim parts
  parts = []
  for call in turn.functionCalls:
     emit toolStart(`${call.name} ${JSON.stringify(call.args)}`)
     resp = execute(call)
     emit toolEnd(resp.summary ?? "Tool finished.", resp.error ? 1 : 0)
     parts.push({ functionResponse: { name: call.name, response: resp } })
  contents.push({ role: "user", parts })
throw "The assistant exceeded the maximum tool-call rounds. Please try a narrower query."
```

Note: text streamed in a turn that also contained function calls is not shown (deltas are suppressed once a call
is seen; text before the call in the same chunk sequence may already have been emitted).

If no Gemini key: emit error `Gemini is not configured. Add your Gemini API key in Settings > Providers.`

### 4.2 Codex and Claude CLIs

Working directory: `<appData>/Dayflow/chatcli` (created if missing). Timeout: **300 s** per run (process
terminated; error `CLI process timed out after 300 seconds`). The command is run through the user's login
shell on macOS (`cd <wd> && exec <cmd>`), so PATH from shell profile is honoured.

**Codex** (model `gpt-5.6-luna`, reasoning effort `low`):

```
codex exec --skip-git-repo-check --json                       # first turn
codex exec resume <sessionId> --skip-git-repo-check --json    # resume
   -m gpt-5.6-luna
   -c model_reasoning_effort=low
   --ignore-user-config            # only if `codex exec [resume] --help` mentions it (cached per executable);
                                   # otherwise: --config mcp_servers.<name>.enabled=false for every configured MCP server
   -c rmcp_client=false -c web_search=disabled
   -- <prompt>
```

stdin = null; stdout = pipe. JSONL events parsed per line (ANSI escapes stripped):
- `{"type":"thread.started","thread_id":X}` → `sessionStarted(X)`
- `type` `error` or `turn.failed` → `error(error.message ?? message ?? "Codex could not complete the request.")`;
  if that message is itself JSON with `error.message`/`message`, use the nested one.
- `item.type == "reasoning"` with text → `thinking(text)`
- `item.type == "command_execution"`: on `item.started` → `toolStart(item.command)`; on `item.completed` →
  `toolEnd(item.aggregated_output ?? "", item.exit_code)`
- `item.type == "agent_message"` with text → `textDelta(text)` (whole message per item)

**Claude** (model `sonnet`, no effort flag):

```
claude -p --output-format stream-json --verbose --include-partial-messages
   [--resume <sessionId>]
   --model sonnet
   --dangerously-skip-permissions
   --strict-mcp-config
   -- <prompt>
```

macOS runs it attached to a PTY (stdin+stdout on the slave) to get unbuffered output; stderr via pipe.
JSONL parsing:
- `{"type":"system","session_id":X}` → `sessionStarted(X)`
- `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":T}}}` → `thinking(T)`
- same with `delta.type == "text_delta"`, `delta.text` → `textDelta`
- `{"type":"result","result":R}` (non-empty) → `complete(R)`
- Claude's own tool_use events are **not** parsed → no tool rows appear for Claude (only thinking/answer).

Common post-processing: `complete` from the CLI is suppressed if text deltas were already seen. After exit: if
status ≠ 0 and no error was yielded: stderr containing `command not found` →
`${tool} CLI not found. Please install it and run '${codex login|claude login}' in Terminal.`; else non-empty
stderr → `error(stderr)`. If accumulated text exists and no complete was yielded → `complete(accumulated)`.
macOS-only retries (Codex executable re-resolution, temporary `CODEX_HOME` when a broken MCP "transport" config is
detected) can be dropped or simplified.

### 4.3 How CLI agents get timeline data

Only via their **built-in shell tool running `sqlite3`** against `${dbPath}`, as instructed by the prompt (§2.1).
Relevant tables/columns the agent will use:

- `timeline_cards`: `id, batch_id, start (text clock), end (text clock), start_ts, end_ts (epoch s), day
  (YYYY-MM-DD, 4AM-based), title, summary, detailed_summary, category, subcategory, metadata (JSON),
  video_summary_url, is_deleted`.
- `observations`: `id, batch_id, start_ts, end_ts, observation, metadata, llm_model, created_at`.

Windows implementation requirements (derived):
1. `sqlite3.exe` is not present on Windows by default. Bundle it (e.g. `resources/bin/sqlite3.exe`) and prepend its
   directory to `PATH` in the child process env, or substitute the prompt's Query line with the bundled path.
2. `${dbPath}` must be absolute with forward slashes or properly quoted (Claude on Windows uses Git Bash; Codex
   uses PowerShell). The DB must be in WAL mode / readable while the app holds it open.
3. Spawn directly (no login shell): `child_process.spawn(exe, args, { cwd, env, windowsHide: true })`, stdin
   `ignore`, read stdout line by line. A PTY is not needed with stream-json.
4. Windows command lines are limited to ~32 767 chars; the first-turn prompt (system prompt + history) can exceed
   it. Prefer passing the prompt via stdin: `claude -p ...` reads the prompt from stdin when no positional prompt
   is given; `codex exec ... -` reads it from stdin. (Recommendation, not in the original.)
5. Alternative (not in original): expose the Gemini tools to the CLIs through a local stdio MCP server
   (`--mcp-config` for Claude, `-c mcp_servers.dayflow.command=...` for Codex). Only do this if sqlite3 bundling
   proves unreliable; it would require changing the CLI prompt.

### 4.4 AgentAccess / bundled `dayflow` MCP server (separate feature, FYI)

Not used by chat. For completeness: `dayflow mcp` = JSON-RPC 2.0 over stdio, one message per line, protocol
`2025-06-18`, serverInfo name `dayflow`. Read tools: `get_time_breakdown(from,to)`, `get_timeline(date?)`,
`get_activity_detail(record_id)`, `search_activities(query)` (latest 50), `get_daily(date?)`, `get_weekly(date?)`,
`list_categories()`, `get_status()`. Write tools (only listed when "Allow edits" is on): `create_category`,
`update_category`, `delete_category`, `update_activity`, `delete_activity`, `set_day_goal`. Reads go to the DB
directly; writes go to the app over a Unix socket `~/Library/Application Support/Dayflow/agent.sock` (mode 0600,
one JSON line `{"protocol_version":1,"operation":...,"arguments":{...}}` → `{"ok":true,"data":...}` /
`{"ok":false,"error":{"code","message"}}`, writes logged to `agent-writes.log`). `AgentClientRegistration` writes
`"dayflow": {"command": "<cliPath>", "args": ["mcp"]}` into `~/.claude.json`, Claude Desktop config, Codex config,
or deeplinks for Cursor/VS Code. Spec this separately if porting.

### 4.5 Tool-row summary text (`toolSummary`)

```
base = command contains "sqlite3"            → "Database query"
       contains "fetchtimeline"/"fetchobservations" (case-insens.) → "Data fetch"
       else                                  → "Tool"
exitCode != null && != 0      → "${base} failed (exit ${code})"
exitCode == null && no output → "Running ${base.lower}…"
output empty                  → "${base} completed"
base == "Data fetch"          → output (= the tool's summary string, e.g. "Fetched 12 timeline cards for Sat, Nov 7.")
else                          → "${base} returned ${n} row(s)"   ("1 row" / "N rows", N = non-empty-line count)
```

---

## 5. Inline chart markup

### 5.1 Syntax

A fenced block whose info string is `chart type=<type>`; body is one JSON object. Parser regex (applied after
`\r\n`→`\n`):

```
```chart\s+type\s*=\s*([A-Za-z_]+)\s*\n?([\s\S]*?)\n?```
```

Type is lowercased. The message is split into ordered blocks: text chunks (only if not whitespace-only) and
charts. If a chart fails to parse/validate, the **raw fenced block is rendered as text** (i.e. a code block).
Parsing runs on every streaming update; an unterminated chart fence simply renders as an in-progress code block
until closed.

### 5.2 JSON shapes and validation

| type | JSON | Validation (fail → raw text) |
|---|---|---|
| `bar`, `line` | `{ "title": string, "x": string[], "y": number[], "color"?: string }` | x non-empty, `x.length == y.length` |
| `stacked_bar` | `{ "title": string, "x": string[], "series": [{ "name": string, "values": number[], "color"?: string }] }` | x non-empty, series non-empty; series with empty values or `values.length != x.length` are dropped; ≥1 series must remain |
| `donut` (alias `pie`) | `{ "title": string, "labels": string[], "values": number[], "colors"?: string[] }` | labels non-empty, same length as values; `colors` used only if same length as labels, else all default |
| `heatmap` | `{ "title": string, "x": string[], "y": string[], "values": number[][], "color"?: string }` | x,y non-empty; `values.length == y.length`; every row length == x.length |
| `gantt` | `{ "title": string, "items": [{ "label": string, "start": number, "end": number, "color"?: string }] }` | items with `end <= start` dropped; ≥1 must remain |

`title` is required (decode fails without it); all numbers must be JSON numbers. Unknown type → raw text.

Color sanitizing: trim, strip leading `#`, must be 6 or 8 hex chars → uppercase; else treated as absent.
The app's `Color(hex:)` reads 8-digit values as **AARRGGBB** (alpha first), so convert to CSS as
`#RRGGBB` + alpha = AA/255. If the hex is invalid, fall back to the default palette.

### 5.3 Rendering (Swift Charts → use e.g. Recharts/ECharts/visx)

- Container: optional title (if non-empty after trim) above the chart; chart height **180 px**.
- Default palette (by series/item/slice index, modulo 5): `#F96E00`, `#1F6FEB`, `#2E7D32`, `#8E24AA`, `#00897B`.
- `bar`: vertical bars, x categorical labels (single line, truncated), y axis leading with grid lines; color =
  `color` or palette[0].
- `line`: Catmull-Rom smoothed line + point markers; same axes.
- `stacked_bar`: bars stacked by series; legend by series name; colors per series (`color` or palette[i]).
- `donut`: sector chart, inner radius 60%, 1 px angular inset; legend bottom-leading; slice colors from `colors`
  or palette[i].
- `heatmap`: grid of rectangles (90% cell width/height, 2 px corner radius); x labels on x axis, y labels on
  leading axis; base color = `color` or palette[1] (`#1F6FEB`); per-cell opacity
  `0.2 + 0.8 * clamp((v - min)/(max - min), 0, 1)` (if max == min → opacity 1.0); no legend.
- `gantt`: horizontal bars from `start` to `end` on a numeric x axis (domain = min..max over all starts/ends,
  ~6 ticks formatted with 1 decimal, e.g. `9.5`), one row per `label` on the leading axis; 4 px corner radius;
  color per item or palette[index]; no legend. Values are hours of day as decimals (e.g. 9.0 = 9 AM) by
  convention of the prompt.

### 5.4 Metadata blocks (stripped, never rendered)

` ```suggestions ` + JSON string array, and ` ```memory ` + `Profile:` / `Style:` lines. See §6.2.

---

## 6. Persistence

### 6.1 Chat history DB (same SQLite DB as timeline)

```sql
CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT NOT NULL PRIMARY KEY,          -- UUID string (uppercase, Swift uuidString)
    title TEXT NOT NULL,
    provider TEXT NOT NULL,                -- 'gemini' | 'codex' | 'claude'
    cli_session_id TEXT,                   -- Codex thread_id / Claude session_id; NULL for gemini
    created_at INTEGER NOT NULL,           -- epoch seconds
    updated_at INTEGER NOT NULL            -- epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated
ON chat_conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT NOT NULL PRIMARY KEY,          -- UUID string
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                    -- 'user' | 'assistant' | 'toolCall'
    content TEXT NOT NULL,                 -- assistant content is the CLEANED text (metadata stripped, charts kept)
    created_at INTEGER NOT NULL,           -- epoch seconds
    sort_order INTEGER NOT NULL            -- 0-based index in the transcript
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
ON chat_messages(conversation_id, sort_order);
```

Behaviour:
- A conversation id (UUID) + createdAt are minted on the first `sendMessage` of a fresh conversation.
- After **every** completed turn (success or error), `saveChatConversation` runs in one transaction: upsert the
  conversation (`ON CONFLICT(id) DO UPDATE SET title, provider, cli_session_id, updated_at`; created_at kept),
  then `DELETE FROM chat_messages WHERE conversation_id=?` and re-insert all in-memory messages with
  `sort_order = index`. Skipped if there are no messages.
- Title: first user message, newlines → spaces, trimmed, first **80** characters; `"New chat"` if empty.
- provider = provider used for the turn just completed; updated_at = now.
- List: `SELECT ... ORDER BY updated_at DESC`. Rows with unparsable UUIDs skipped.
- Load: messages `ORDER BY sort_order ASC`; unknown roles skipped. History is rebuilt from user/assistant messages
  (toolCall ignored); `cli_session_id` restored as the current session id (so the next CLI turn resumes it; on a
  missing-session error it rebuilds from history, §2.6). Suggestion history and suggestions are cleared on load.
- Delete: delete messages explicitly, then the conversation.
- Error turns persist the `I encountered an error: ...` assistant message too.
- `toolCall` role exists in the model/schema but current code never creates such messages (tool progress lives
  in the transient work-status card and is not persisted).

### 6.2 Metadata parsing (after the turn completes, on the raw full response)

Order of operations:

1. Suggestions, strict pattern (first match only; whole match removed):
   `(?ims)(?:^|\n)\s*(?:#{1,6}\s*Suggestions\s*\n+|Suggestions:\s*)?```suggestions\s*\n([\s\S]*?)\n?```  `
   Group 1 trimmed → `JSON.parse` must yield a string array; otherwise suggestions stay empty (block still removed).
2. If no suggestions: loose pattern (replaced with `\n`):
   `(?ims)(?:^|\n)\s*(?:#{1,6}\s*Suggestions\s*\n+|Suggestions:\s*\n?)(\[[\s\S]*?\])(?=\n\s*(?:#{1,6}\s*Memory\b|Memory:)|\z)`
3. Memory, strict pattern (removed):
   `(?ims)(?:^|\n)\s*(?:#{1,6}\s*Memory\s*\n+|Memory:\s*)?```memory\s*\n([\s\S]*?)\n?```  `
4. If no memory: loose pattern (replaced with `\n`):
   `(?ims)(?:^|\n)\s*(?:#{1,6}\s*Memory\s*\n+|Memory:\s*\n?)(Profile:[\s\S]*?Style:[^\n]*(?:\n[^#\n].*)*)(?=\z)`
5. Remove residual lines matching (multiline, case-insens.): `^\s*#{1,6}\s*Suggestions\s*$`,
   `^\s*#{1,6}\s*Memory\s*$`, `^\s*Suggestions:\s*$`, `^\s*Memory:\s*$`.
6. Trim → `cleanedText`.

Regex flags: `i` case-insensitive, `m` multiline, `s` dot-all. In JS use `/.../ims` (ES2018+); `\z` → `$(?![\s\S])`
(end of input) because JS `$` with `m` means end of line.

Memory normalization (`normalizeAutoMemoryBlob`): normalize CR/CRLF→LF, split lines, trim, drop empty; take the
last non-empty value of lines starting (case-insens.) with `profile:` and `style:`; output
`"Profile: ${p}"` and/or `"Style: ${s}"` joined by `\n`. If neither found → ignore block (memory not changed).

Suggestion history (Gemini only uses it): rolling list of max **12**; each new suggestion (trimmed, non-empty) is
de-duplicated case-insensitively (old occurrence removed, new appended). Last 9 are sent as
"Recent Suggestions To Avoid". Reset on new/loaded conversation. `currentSuggestions` = this turn's list (shown as
chips), cleared when a new message is sent.

Streaming hide rule (`visibleStreamingText`): find first match of `(?im)^[ \t]*```(?:suggestions|memory)\b`; if
found, visible = text before it, trimmed. Else, if the last line (trimmed, lowercased) is a non-empty **prefix** of
` ```suggestions ` or ` ```memory `, drop that last line (and trim). Else the full text.

### 6.3 Memory store

- Single global blob (not per conversation). macOS: `UserDefaults` keys `dashboardChatMemoryBlob` (string) and
  `dashboardChatMemoryUpdatedAt` (date). Windows: app settings store (electron-store / JSON), same key names.
- `load()`: stored string trimmed, `""` if absent.
- `save(text)`: normalize — CRLF/CR→LF, trim, collapse runs of 3+ newlines to 2 (repeat until none), truncate to
  **10 000** chars then trim. Empty → `clear()`. Else store + set updatedAt = now.
- `clear()`: remove both keys.
- Auto-update: when a turn yields a valid memory blob, `save()` it (always, even if identical — but session reset
  only if changed). Then `didUpdateDashboardMemory(old,new)`: if different, drop the CLI session id
  (log "♻️ Reset CLI session: dashboard memory changed").
- Injection: as `## User Memory\n${blob}` (see §2.6) for all providers.
- Memory panel edits use the same `save/clear` and the same session reset.

### 6.4 Other persisted settings

| key | type | default | meaning |
|---|---|---|---|
| `dashboardChatProvider` | string | `"gemini"` | selected provider |
| `hasChatBetaAccepted` | bool | false | lock screen dismissed |
| `llmOutputLanguageOverride` | string | `""` | language override (shared with other LLM features) |
| Gemini API key | secret | — | shared with the rest of the app (Keychain on macOS → Windows credential store / safeStorage) |

---

## 7. Drop / adapt for Windows

Drop entirely:
- **`ChatToolExecutor.swift`** — legacy "output a JSON tool call" text protocol (`{"tool":"fetchTimeline","date":...}`),
  plain-text formatters and `toolDescription`. Not referenced anywhere; superseded by Gemini function calling.
- **PostHog analytics** events (`chat_question_asked` — which sends the full question text —, `chat_answer_copied`,
  `chat_answer_rated`, `chat_answer_feedback_submitted`, `chat_memory_auto_updated`, `chat_memory_manual_saved`,
  `chat_memory_cleared`, `chat_memory_panel_opened`, `chat_conversation_reopened`). Keep the UI hooks as no-ops or
  local logging; if dropped, also drop/rewrite the lock-screen "Privacy Note" (it describes question logging).
- The thumbs-down feedback modal's backend (TimelineFeedbackModal sends to Dayflow analytics) — keep UI optional.
- Codex executable re-resolution, `codexSupportsIgnoringUserConfig` caching via login shell, temporary
  `CODEX_HOME` invalid-transport fallback, `LoginShellRunner` shell-escaping, PTY allocation for Claude,
  `reportNotFoundAndRefreshShellEnvironment`. Replace with a direct spawn + PATH lookup (`where codex`,
  `where claude`; npm-installed CLIs are `.cmd` shims → spawn with `shell: true` or resolve the `.cmd`).
- Error copy "...run '... login' in Terminal." → "in a terminal".
- AgentAccess/MCP server/Unix socket/`~/.claude.json` registration (§4.4) — separate feature, not needed for chat.
- macOS-specific UI: AppKit composer text view, NSPasteboard (→ `clipboard`), NSWorkspace URL opening
  (→ `shell.openExternal` with the same http/https/mailto allow-list), SF Symbols (→ icon set), Figtree /
  InstrumentSerif fonts (bundle if available), `pointingHandCursor`.

Adapt:
- DB path in CLI prompt → Windows DB absolute path; text "a macOS app" → platform-appropriate wording (optional).
- `sqlite3` must be available to the CLI agents (§4.3).
- Day boundary: always local 4:00 AM; DST-safe date arithmetic (compute next calendar day then set 04:00, as the
  Swift code does, rather than adding 24 h).
- Date formatting with en_US_POSIX patterns for tool payloads (`h:mm a`, `EEE, MMM d`, `MMM d`) — use fixed English
  month/day names regardless of UI locale, since they go to the model. `${currentDate}` in prompts uses the user's
  locale in Swift (DateFormatter without locale); using English there is acceptable.
- Model ids (`gpt-5.6-luna`, `sonnet`, `gemini-3.x-flash` list) — keep as configurable constants.

Keep exactly: prompts (§2), tool schemas & payloads (§3), metadata regexes (§6.2), chart JSON contract (§5),
history schema (§6.1), memory normalization (§6.3), 50 ms streaming flush, 20 tool rounds, 800 000-byte timeline
soft limit, 300 s CLI timeout, 180 s Gemini HTTP timeout, 8192 max output tokens, thinkingLevel "high".
