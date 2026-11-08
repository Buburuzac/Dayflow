# Spec: Weekly page (weekly review dashboard)

Port spec for the Windows port (Electron + TS + React, SVG charts).
Swift source used: `Core/Weekly/*`, `Views/UI/Weekly/**`, `Core/Net/FaviconService.swift`,
`Core/Analysis/TimeParsing.swift`, `Models/TimelineCategory.swift`,
`Core/Recording/StorageManager+TimelineCards.swift`, `StorageManager+Reprocessing.swift`.
Reference image: `docs/images/weekly.png`. It is a marketing composite. It shows the heatmap, "Time
distribution", treemap, interactions graph and Sankey. The **current** `WeeklyView` mounts a slightly
different set (see §1.3). Section 9 covers the two sections that are built but not mounted.

**There is no LLM usage on the weekly page.** Every number is computed deterministically from
timeline cards. No prompts. The only network use is favicon fetching (§3.9).

---

## 1. Page structure

### 1.1 Gating (two levels)

1. **Global unlock (access lock).** The weekly page unlocks only after enough analysis has been completed overall:
   - `completedBatchCount = SELECT COUNT(*) FROM analysis_batches WHERE status IN ('completed','analyzed')`
   - Constants: `batchDurationMinutes = 15`, `batchesPerRecordedHour = 4`, `recordedHourTarget = 30`,
     `completedBatchTarget = 30*4 = 120`.
   - `isComplete = completedBatchCount >= 120`. `progress = min(max(count,0),120) / 120`.
   - Recorded-time text, using `minutes = cappedCount * 15`: `"0h / 30h"`, `"{m}m / 30h"`,
     `"{h}h / 30h"` or `"{h}h {m}m / 30h"`.
   - Estimated unlock date: `now + remainingBatchCount * 15 min`.
   - The state is refreshed on appear, every 30 s, and when the app becomes active.
   - A hidden flag `weeklyAccessManuallyLocked` (persisted, default false) forces the locked state. Unlocked = `isComplete && !manuallyLocked`.
   - **Locked view:** blurred, animated preview of the dashboard filled with fixture data. On top of it sits a centered card, 485x276, corner radius 10:
     - Title: "Unlock Weekly" (serif 22).
     - Subtitle: "Weekly unlocks after 30 hours of recorded timeline data" (14).
     - A pill showing the recorded-time text (serif 22, color `FF7856`, fill `FFECE0`, 1px stroke `FF8904`@50%).
     - A progress bar, 420x24: capsule track `F2F2F2`, linear gradient fill `C6D9FF -> FF9A78`, and a 24px orange (`FF6E00`) knob with the Dayflow logo.
     - A button, 188x36. Its title comes from the notification state: idle "Notify me when ready", requesting "Setting reminder...", scheduled "We'll notify you", denied "Open notification settings", failed "Try again". When unlocked the title is "View Weekly". The button is disabled while requesting or scheduled.
     - Preview behind the card: opacity 0.46, blur 2.2, scale `min(0.95, max(0.58, (w-96)/958))`. It slowly auto-scrolls (26 s linear, autoreverse) unless reduced motion is on.
   - Windows: the notify button can schedule a native `Notification` at the estimated date. Settings deep link: drop it, or open `ms-settings:notifications`.

2. **Per-week data gate.** The week needs at least 15 h of recorded time:
   - `recordedMinutes = floor( SUM(end_ts - start_ts)/60 )` over `timeline_cards WHERE start_ts >= weekStart AND start_ts < weekEnd AND is_deleted = 0 AND category != 'System'`.
   - If `recordedMinutes < 15*60`, the header still shows, but all sections are replaced by a 360px-tall card:
     - "Keep recording to unlock this week" (serif 24).
     - "Weekly insights need at least 15 hours of recorded activity for the selected week." (14, secondary).
     - A pill `"{rec} / 15h"`. Duration format: `0h` if <=0, `{m}m`, `{h}h` or `{h}h {m}m`.
     - The same 420x24 progress bar, with progress = rec/900.
     - `"{remaining} more to unlock this week"` (13).
   - While loading, `recordedMinutes` is unknown, so the gate is not shown.

### 1.2 Default week on entry
On appear, when the page is unlocked, search backwards from the current week for up to **52** weeks:
- Return the first week with `recordedMinutes >= 900`.
- Otherwise use the first week (newest first) with `recordedMinutes > 0`.
- Otherwise use the current week.

### 1.3 Section order (top to bottom, as in current `WeeklyView`)
1. **Header**: `<` week title `>`.
2. **Top row**, two cards side by side if `rawContentWidth >= 958`, otherwise stacked with 18px spacing:
   - a. **Weekly distribution**: donut + legend (left).
   - b. **Context shift and distractions comparison**: line chart + insight footer (right).
3. **Your workflow this week**: 15-min category grid with a "Week total" footer.
4. **Focus and distraction heat map**: 5-min diverging heatmap.
5. **Most used per category**: nested squarified treemap with week-over-week deltas.
6. **Weekly breakdown**: 3-column Sankey (week -> categories -> apps).

Every card has a hover-revealed "download PNG" button (§8).

### 1.4 Layout constants
```
designContentWidth = 958; maximumContentWidth = 1500
horizontalPadding = min(56, max(24, panelWidth*0.03))
rawContentWidth = max(1, panelWidth - 2*horizontalPadding); contentWidth = min(1500, rawContentWidth)
topRowHeight = 300; topRowSpacing = 27
donutCardWidth = min(620, max(461, floor((contentWidth-27)*0.44)))
contextCardWidth = max(1, contentWidth - 27 - donutCardWidth)
workflowHeight = 292 (natural height in refreshed style); heatmapHeight = 238; treemapHeight = 549
sankeyHeight = contentWidth*933/1748; dataGateHeight = 360
sectionSpacing = 32; headerBottomPadding = 40; topPadding = 40; bottomPadding = 48
```
The page scrolls vertically with the scroll bar hidden. Content is horizontally centered.

### 1.5 Loading / refresh
Reload for the selected week whenever any of these happens: the week changes, the categories change, or the window becomes active/focused.
1. Fetch the cards for `[weekStart, weekEnd)`.
2. Fetch the cards for the previous week (used for the treemap deltas).
3. Build the snapshot off the main thread (worker or main process).
4. Compute `recordedMinutes`.

Discard stale results with a load-generation counter. `isLoading` only affects the donut, which shows a spinner.

Card fetch (overlap query, **System cards included**):
`WHERE ((start_ts < weekEnd AND end_ts > weekStart) OR (start_ts >= weekStart AND start_ts < weekEnd)) AND is_deleted = 0 ORDER BY start_ts`.

---

## 2. Week range rules

- Weeks start on **Monday at 04:00 local time** and end 7 days later (next Monday 04:00). ISO weeks: firstWeekday Monday, minimumDaysInFirstWeek 4.
- `containing(date)`:
  ```
  monday = Monday 00:00 of the ISO week containing date
  start  = monday at 04:00
  if date < start: start -= 7 days
  end    = start + 7 days      // calendar-day add, DST-safe
  ```
- `shifted(weeks)`: `start + 7*weeks days`, `end = start + 7 days`.
- Navigation:
  - The left arrow always goes back one week.
  - The right arrow goes forward one week. It is enabled only if `weekStart < containing(now).weekStart`. When disabled it has opacity 0.35 and no hover.
- The 7 days of the week are `weekStart + offset` days (offset 0..6). Each day is formatted `yyyy-MM-dd` and matched against `card.day`. `card.day` is the logical day with a 4 AM boundary, already stored on the card.
- Title: `"{start} - {end}"`, where `end = weekStart + 6 days`. Each date uses the locale template `EEEEMMMMd`. TS: `new Intl.DateTimeFormat(locale,{weekday:'long',month:'long',day:'numeric'})`, giving for example "Monday, September 8 - Sunday, September 14".
- Header styling: height 34. Title in serif 26, 448px wide, centered, black (white in dark mode). Arrows are 24px icons inside a 30px hit circle, with hover fill `FFEBD3`@79%. Spacing 14.

---

## 3. Shared preprocessing

### 3.1 Time parsing
Card times are clock strings such as `"9:30 AM"`. Accepted formats: `h:mma`, `hh:mma`, `h:mm a`, `hh:mm a` (case-insensitive, en_US_POSIX).
- `parseMinute(s) = hour*60 + minute` (0..1439), or null if it fails to parse.
- On Windows, use `card.startTime` / `card.endTime`. Equivalently, take the local clock time of `startTs` / `endTs`.
- Distractions use `distraction.startTime` / `endTime` in the same format.

### 3.2 4 AM normalization (used everywhere)
```ts
function normalizedMinuteRange(start: number, end: number) {
  const s = start < 240 ? start + 1440 : start;
  let e = end < 240 ? end + 1440 : end;
  if (e <= s) e += 1440;
  return { start: s, end: e };           // minutes on a 240..1680 "logical day" axis
}
```
`durationMinutes = max(round(end - start), 0)`. Cards with a duration of 0 are dropped.

### 3.3 Keys
- **Builder key** (`normalizedKey`), used by heatmap, workflow, treemap, Sankey, context charts and interactions:
  1. Trim.
  2. Case- and diacritic-fold, lowercase.
  3. Map every non-letter/non-digit character to `-`.
  4. Split on `-`, drop empty parts, join with `_`.

  Example: `"Coding / Debugging"` -> `coding_debugging`.
  TS: `s.trim().normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'-').split('-').filter(Boolean).join('_')`.
- **Donut/overview key**: trim, then case- and diacritic-fold, lowercase only. No underscore conversion.
- `displayName(category) = trimmed || "Uncategorized"`.

### 3.4 Category lookup
- Sort user categories by `order` (on Windows, the array index).
- Build `key(category.name) -> category`. **The first one wins** when keys collide.
- Category flags:
  - `isSystem = cat?.isSystem || key == "system"`. On Windows, also treat `card.isError` as system.
  - `isIdle = cat?.isIdle || key == "idle"`.
- Resolved name: `cat?.name ?? trimmed card.category`.
- Resolved color: `cat?.colorHex ?? fallbackColor(key)`. Strip `#` and uppercase. If the result is empty, use `BFB6AE`.

### 3.5 Fallback color (djb2 with 64-bit wrapping)
```ts
function fallbackColorHex(key: string, palette: string[]) {
  let h = 5381n;
  for (const b of new TextEncoder().encode(key)) h = BigInt.asIntN(64, (h << 5n) + h + BigInt(b));
  const a = h < 0n ? -h : h;
  return palette[Number(a % BigInt(palette.length))];
}
// builder palette (6):  ["93BCFF","DE9DFC","6CDACD","FFA189","FFC6B7","BFB6AE"]
// donut/overview (5):   ["93BCFF","DE9DFC","6CDACD","FFA189","BFB6AE"]
```
Constants: `otherKey = "other"`, `otherColorHex = "BFB6AE"`.

### 3.6 CardFact (builder record per card)
For each card:
1. Parse start and end with `parseMinute`. Skip the card if either fails.
2. Normalize the range (§3.2) and compute the duration. Skip the card if the duration is 0.

Fields:
- `id`: `"card-{recordId}"`, or else `"{day}-{start}-{end}-{key(title)}"`.
- `dayString = card.day`.
- `dayOrder` = offset 0..6 if `day` is in the week, else `Infinity`.

**Facts are NOT filtered by day.** Cards from the overlap query whose `day` is outside the week still feed the treemap, Sankey and interactions. Heatmap, workflow and context charts select by `dayString` per day, so they ignore such cards. The donut filters to week days. Port this as is.

Facts are sorted by `(dayOrder, startMinute)`.

Fields continued:
- `categoryKey`, `categoryName`, `categoryColorHex` (§3.4, using the builder palette).
- `isSystem`, `isIdle`.
- `isDistraction` (§3.7).
- `appKey`, `appName`, `appColorHex` (§3.8).
- `faviconPrimaryRaw = appSites.primary` and `faviconSecondaryRaw = appSites.secondary` (raw strings).
- `faviconPrimaryHost` / `faviconSecondaryHost = normalizedHost(raw)` (§3.9).
- `appKind` (§3.10).

"Visible facts" = `!isSystem && !isIdle`. This filter is used by every builder section.

### 3.7 Focus vs distraction
- `isDistractionCard`:
  - `true` if `card.distractions` is non-empty.
  - Otherwise `true` if `lower("{categoryName} {subcategory} {title} {summary}")` contains `"distraction"` or `"distracted"`.
- `isFullDistractionFact`, used by the heatmap and distracted-minutes:
  1. If `lower("{categoryName} {subcategory}")` contains `"distraction"` or `"distracted"`, return true.
  2. Else, if the card has embedded distractions, return false (the card is focus with embedded distraction intervals).
  3. Else return `isDistraction`, which is then true only via the title/summary text match.
- Workflow "distraction bucket": `categoryKey` contains `"distraction"`, or `categoryName` contains it (case-insensitive).
- Embedded distraction intervals, aligned to the parent card:
  1. Parse the distraction's start and end. Normalize them (§3.2).
  2. Build candidates `{n, n-1440, n+1440}`.
  3. Keep candidates where `start >= parentStart-2 && end <= parentEnd+2 && end > start`.
  4. Pick the one minimizing `|start-parentStart| + |parentEnd-end|*0.1`.
  5. Drop the distraction if no candidate remains.
- `distractedMinutes(facts)` = Σ over facts of: full-distraction fact -> `end-start`, otherwise -> the sum of aligned embedded interval lengths.

### 3.8 App identity (name, key, color)
1. `rawApp` = first non-empty trimmed of `[appSites.primary, appSites.secondary]`.
2. `source` = `rawApp`, else `fallbackAppName("{title} {summary}")`. The fallback is the first candidate whose lowercase is contained in the lowercased text, else `"Other"`. Candidates, in order:
   `ChatGPT, Claude, Codex, Cursor, Xcode, Dayflow, Figma, Slack, Zoom, YouTube, Reddit, Substack, Notion, Linear, GitHub, Safari, Chrome, Calendar, Mail, Messages`.
3. `prettyAppName(source)`. The first mapping whose needle is contained in `lower(source)` wins. Order matters:
   ```
   chatgpt→ChatGPT, claude→Claude, codex→Codex, cursor→Cursor, xcode→Xcode, dayflow→Dayflow,
   figma→Figma, slack→Slack, zoom→Zoom, meet.google→Meet, "google meet"→Meet, youtube→YouTube,
   reddit→Reddit, twitter→X, x.com→X, substack→Substack, notion→Notion, linear→Linear,
   github→GitHub, safari→Safari, chrome→Chrome, calendar→Calendar, mail→Mail, messages→Messages,
   maps→Maps, clickup→ClickUp, runway→Runway, flora→Flora
   ```
   If nothing matches:
   1. Take the first part of `source` split on any of `, ; | \n`.
   2. Remove `https://`, `http://`, `www.` and `com.apple.`, then trim.
   3. If the result contains `.` and no space, the name is TitleCase of the first dot-segment (`docs.google.com` -> `Docs`).
   4. Otherwise the name is TitleCase of the cleaned string. If the cleaned string is empty, the name is `"Other"`.

   TitleCase = uppercase the first character of each space-separated word and leave the rest as is.
4. `appKey = key(name)`. If it is empty, use `"other"`.
5. `appColorHex`: the first needle contained in `lower(name)` wins:
   ```
   chatgpt 333333, claude D97757, codex 111111, cursor 111111, xcode 4085FD, dayflow FF7A2F,
   figma FF7262, slack 36C5F0, zoom 4085FD, meet 34A853, youtube FF0000, reddit FF613C,
   x 111111, substack FF6E3E, notion 111111, linear 5E6AD2, github 24292F, safari 2E8BFF,
   chrome 4285F4, calendar A29993, mail 4F8EF7, messages 38D06E, other D9D9D9
   ```
   Otherwise use `fallbackColorHex(name, builderPalette)`.
   Note: the `"x"` needle matches any name that contains the letter x (for example "Xcode" is caught earlier, "Max" -> 111111). Port this as is.

### 3.9 Favicons
- `normalizedHost(raw)`:
  1. Return null if raw is empty.
  2. Trim and lowercase.
  3. If it parses as a URL with a host, return the host.
  4. Else, if it contains `/`, parse `"https://"+s` and return that host.
  5. Else, if it has no `.`, return `s + ".com"`.
  6. Else return `s`.

  Note: Swift `URL(string:"github.com")` has no host, so plain domains fall through to the later rules.
- Host aliases: `codex.com -> chatgpt.com`, `codex.so -> chatgpt.com`.
- **Raw overrides** (bundled icons; substring match on the lowercased raw string, first match wins):
  ```
  dayflow, chat.openai|chatgpt (ChatGPT), claude|anthropic (Claude), gemini, github, discord,
  youtube|youtu.be, reddit, twitter|x.com (X), leagueoflegends|"league of legends",
  meet.google|"google meet" (Google), imessage, messages, facetime, findmy|"find my",
  icloud.com/mail|calendar|notes|reminders|photos, music.apple, tv.apple, news.apple, books.apple,
  podcasts.apple, maps.apple, weather.apple, fitness.apple, health.apple, wallet.apple,
  freeform.apple, shortcuts.apple, translate.apple, passwords.apple, apps.apple, keynote, numbers,
  pages.apple, safari, finder, settings|"system preferences"|"system settings", calculator, preview,
  contacts, "voice memos"|voicememos, "app store"|appstore, ghostty, terminal, iterm, xcode,
  "vs code"|vscode|"visual studio code", "google chrome"|chrome
  ```
  Dual patterns (both substrings required): `mail+apple`, `calendar+apple`, `notes+apple`, `reminders+apple`, `photos+apple`, `home+apple`, `stocks+apple`, `files+apple`, `clock+apple`, `music+apple`, `books+apple`, `podcasts+apple`, `weather+apple`, `translate+apple`.
  On Windows, ship whichever of these icons you have, and add Windows equivalents (Explorer, Windows Terminal, VS Code, Edge…).
- Resolution order for an item:
  1. Raw override for the primary raw.
  2. Fetch the primary host.
  3. Raw override for the secondary raw.
  4. Fetch the secondary host.
  5. Otherwise nothing (the caller shows its fallback).
- Fetch:
  - Race Google S2 `https://www.google.com/s2/favicons?domain={host}&sz=64` against `https://{host}/favicon.ico`. The direct request starts 150 ms later.
  - The first non-empty 200 image wins. Timeout 4 s per request, 6 s per resource.
  - Keep an in-memory LRU cache of 256 entries and dedupe in-flight requests per host.
- `hasFaviconSource(item)`:
  - false if the item is "Other" (id `other` or name `Other`), an aggregate, or a placeholder.
  - true if any of the four raw/host fields is non-empty after trimming.
  - otherwise `hasRawOverride(name)`.

  `fallbackFaviconRaw = hasRawOverride(name) ? name : null`.

### 3.10 App kind (work / personal / distraction)
1. If `isDistraction`, the kind is `distraction`.
2. Else let `text = lower("{appName} {categoryName}")`:
   - If it contains any of `youtube, reddit, x, twitter, tiktok, netflix, game`, the kind is `distraction`. The single letter `"x"` matches broadly; keep it.
   - Else, if it contains any of `personal, shopping, maps, messages, photos, music`, the kind is `personal`.
   - Else the kind is `work`.

The app aggregate kind is `distraction` if any of its facts is a distraction, else `personal` if any is personal, else `work`.

### 3.11 Time-window helpers (workflow + heatmap)
```
weeklyActivityWindow(visibleFacts):
  if none: return [540, 1320]                       // 9:00–22:00 fallback
  paddedStart = max(240, minStart - 30); paddedEnd = min(1680, maxEnd + 30)
  start = floor(paddedStart/15)*15; end = ceil(paddedEnd/15)*15
  if end == 1440: end = 1680                         // quirk: midnight snaps to 4 AM
  if end <= start: return [540,1320]
timeLabels(start,end): every whole hour h*60 from ceil(start/60)*60 through floor(end/60)*60,
  id "time-{minute}", label = hourAxisLabel(minute)
hourAxisLabel(m): hour = (round(m)/60)%24, min = round(m)%60; if min==0 → locale hour only
  ("9 AM" / "09 Uhr"), else locale short time. TS: Intl.DateTimeFormat(loc,{hour:'numeric'}).
```
X-axis label placement (workflow and heatmap):
- Each label is 34px wide. Its offset is `progress*gridWidth - 17`, clamped to `[0, gridWidth-34]`.
- A label at the start is left-aligned and a label at the end is right-aligned. All others are centered.

### 3.12 Day descriptors
Ids `mon..sun`. Labels `Mon, Tue, Wed, Thur, Fri, Sat, Sun` (note **"Thur"**).

---

## 4. Section: Weekly distribution (donut)

**Data** (`WeeklyDonutBuilder`, uses raw cards with donut keys §3.3 and the 5-color palette):
1. Keep cards whose `day` is one of the 7 week day strings.
2. Skip a card if any of these holds: its key is `system` or `idle`, its category is system or idle, or its duration is <=0.
3. Sum minutes per key. Name = category name, else the trimmed card category. Color = the category color without `#`, else the fallback color. Order = category order, else Infinity.
4. Sort by minutes desc, then order asc, then name (case-insensitive) asc.
5. **Top-N**: `maxVisibleItems = 5`. If there are more than 5 items, keep the first 4 and add an `{id:"other", name:"Other", color:"BFB6AE", minutes: Σ rest}` item.
6. `totalMinutes` = Σ of the visible items. If there are no items, use the empty state.

**Render**: card 300px tall, width per the layout, corner radius 4, 1px border `EBE6E3`, fill white@46%.
- Title "Weekly distribution": serif 20, color `FF9A64`, at (18,16).
- Content is an HStack (donut, then a 38px gap, then the legend). It has 18px horizontal padding, is centered in the card, then offset by (+30, +17).
- Donut size: `base = min(235, max(176, width*0.43))`, `size = min(230, max(110, base*0.86))`.
  - Background disc: color `solid` (white / `272A3C` dark). Shadow rgba(99,71,56,0.35), blur 5.
  - Ring diameter `size-4`. Inner radius = 0.75 x outer radius. Sectors are proportional to minutes, in item order, starting at 12 o'clock and going clockwise (Swift Charts default).
  - Angular inset between sectors: 1.5 (pt of arc, padding). Corner radius 6.
  - Sector fill: the category color at 80% opacity, plus a 4px full-color inner glow band blurred by 4. Optional in SVG: use a stroke of the same color with an inner shadow filter.
  - Center hole: diameter `ringDiameter*0.75 - 6`, filled `solid`. In dark mode the hole is transparent.
  - Center text: "TOTAL" (bold 8, muted `A5A5A5`), then `"{h} hours"` and `"{m} minutes"` (serif 16, pluralized).
- Legend rows (spacing 8):
  - A 12x8 swatch (radius 1.5), then 8px, then the name (14, single line).
  - Then a spacer, then `"{round(minutes/total*100)}%"` (14, min width 32, right-aligned) with a trailing inset of 70px.
- Loading state: a spinner of donut size.
- Empty state: a disc with a 20px `EBE6E3` ring stroke at diameter `size-20`, "TOTAL" and "No activity" (serif 16, secondary). The legend is empty.

---

## 5. Section: Context shift and distractions comparison (line chart)

**Data** (`buildContextCharts`). For each of the 7 days in order Mon..Sun:
1. Take day facts where `dayString == day && visible`, sorted by `startMinute`.
2. `shifts` = the number of consecutive pairs whose `categoryKey` differs.
3. `distractionTimes` = for each fact:
   - If it has embedded distractions, add the parsed `startTime` of each one (unparseable ones are skipped). Raw minutes, not normalized.
   - Else, if `fact.isDistraction`, add `[fact.startMinute]`.
   - Else add nothing.
4. `distracted = distractionTimes.length`.
5. Output `{day: label, distracted, shifts}`.

Insight:
- Find the first day with the max of `distracted+shifts`.
- If that sum is 0, the insight is `"No context shift or distraction pattern was detected in this week."`
- Otherwise: `"{day} had the most interruptions, with {shifts} context shifts and {distracted} distractions."` (`day` is the label, e.g. "Thur").

(The builder also produces a `distribution` list, capped at 80 events. Each event has a time in `HH:mm` for context shifts and distractions between 10:00 and 18:00. It is **not rendered** in the current page; it can be skipped.)

**Render**: card 300px tall, contextCardWidth wide, corner radius 6, border `EBE6E3`.
- Upper part: height 242, padding top 16 and horizontal 24, transparent.
- Footer: height 58, fill `FAF7F5`, with a 1px `EBE6E3` divider above it.
- Title: "Context shift and distractions comparison", serif 20, `FF9A64`, single line. If it does not fit, scale the font down to 0.82.
- Legend: an HStack with spacing 34. Each item is a 10px dot, then 6px, then the label (12):
  - `FF8A8A` "Number of times distracted"
  - `A78CFF` "Number of context shifts"
- Then the label "Count" (12). Then the chart: `chartWidth = max(320, width-48)`, height 104.
  - X domain is day index `0..6`, so the points sit at exact edges, not at band centers.
  - Y domain: `0 .. max(maxValue+2, 4)`.
  - Two series. Each is a Catmull-Rom smoothed line (2px) plus point markers (symbol area 42, about a 7px diameter dot), in its series color.
  - No gridlines or ticks. There is an L-shaped axis: a left vertical line and a bottom horizontal line, 1px, color `5A534C`@90%.
- Day labels (12) sit below the chart, spread with space-between across `chartWidth`.
- Footer: a 10px dot `F5AD41`, then the insight text (14, max 2 lines), padding 24.

---

## 6. Section: Your workflow this week (category grid)

**Data** (`buildWorkflow`, visible facts):
- `window = weeklyActivityWindow`. `slotMinutes = 15`. `slotCount = max(1, floor((end-start)/15))`.
- There is one row per day, Mon..Sun (ids `mon..sun`, labels §3.12). Each row has `slotCount` cells.
- Cell `i`: the slot is `[start+15i, start+15i+15)`.
  1. For each day fact, compute `overlap = max(0, min(f.end,slotEnd) - max(f.start,slotStart))`.
  2. Add the overlap to the fact's bucket:
     - The distraction bucket (§3.7) is `{id:"distraction", name:"Distraction", color:"FF5950"}`.
     - Otherwise the bucket is `{id: categoryKey, name: categoryName, color: categoryColorHex}`.
  3. The dominant bucket = max minutes, ties broken by name asc.
  4. Cell = `{categoryName, colorHex of dominant, minutes: round(Σ all buckets), occupancy: min(1, Σ/15)}`.
  5. If there is no overlap, the cell is `{null, null, 0, 0}`.
- Totals:
  1. Group visible facts by bucket id and sum `durationMinutes`. Drop groups with 0 minutes.
  2. Sort by minutes desc, then name asc. **Top 7.**
  3. `duration` uses `durationText`: `"{h}h {m}m"`, `"{h}h"` or `"{m}m"`.

**Render**: width = contentWidth, corner radius 4, border `EBE6E3`, fill white@46%.
- Title: `"Your workflow this week"`, serif 20, `FF9A64`. Position: top 16, left `36+30+13 = 79` (aligned with the grid).
- Grid panel padding: top 53, leading 36, bottom 6, trailing 52.
- Day labels: 11px, right-aligned in a 30px column. Row height 13, row gap 2. Then 13px to the grid.
- Cells: 13x13, gap 2, radius 2.5.
  - Fill: `color @ (0.3 + 0.7*occupancy)`.
  - An empty cell (no color, or occupancy 0) is filled `989898`@10% (dark: white@8%).
  - Tooltip: `"{rowLabel} {slotStart}-{slotEnd}: {categoryName}, {duration}"`, or `"{rowLabel} {range}: No activity"`. Times are in locale short time. Slot end is `min(windowEnd, start+15)`.
- `gridWidth = n*13 + (n-1)*2`. The grid scrolls horizontally if it is wider than the card (scroll bar hidden). The export width grows to fit the grid.
- Below the grid: 10px spacing, a 0.9px `E5DFD9` line, 5px, then the hour labels (10).
- A divider, then the footer: fill `FAF7F5`, padding (14,16,12,16), horizontally scrollable, single line.
  - Text "Week total" (serif 14, secondary `777777`).
  - Then, for each total: the name (12, text color) and, 2px later, the duration (semibold 12, in the bucket color). Items have 8px spacing.
  - Empty state: `"Week total  No captured activity during {start}-{end}"` (12, secondary), with the window times in locale short time.

---

## 7. Section: Focus and distraction heat map

**Data** (`buildHeatmap`, visible facts):
- `window = weeklyActivityWindow`. `bucketMinutes = 5`. `bucketCount = max(1, ceil((end-start)/5))`. `endMinute = start + 5*bucketCount`.
- **Row order: Sun, Mon, Tue, Wed, Thur, Fri, Sat.** The day offsets are `[6,0,1,2,3,4,5]`, so "Sun" is the Sunday at the *end* of this week.
- Per row (day facts sorted by start):
  ```
  focus[], distraction[], switch[] = zeros(bucketCount)
  prev = null
  for f in facts:
    if prev && f.start - prev.end <= 20 && sig(f) != sig(prev):  // sig = "{categoryKey}|{appKey}"
       switch[floor((f.start - winStart)/5)] += 1   (only if f.start in [winStart, winEnd))
    if isFullDistraction(f): addInterval(distraction, f.start, f.end)
    else:
       addInterval(focus, f.start, f.end)
       for iv in embeddedIntervals(f): addInterval(distraction, iv, +1); addInterval(focus, iv, -1)
    prev = f
  addInterval(values, s, e, w): clamp s,e to the window; for each touched bucket add overlap*w
  ```
  Scores:
  ```
  clean[i] = focus[i] >= 5*0.6 && distraction[i] < 1
  run[i]   = length of the run of consecutive clean buckets containing i (0 if not clean)
  focusRatio = clamp01(focus[i]/5); distRatio = clamp01(distraction[i]/5)
  sustained  = min(1, run[i]/6)
  focusStrength       = focusRatio * (0.35 + 0.65*sustained)
  distractionStrength = min(1, distRatio*1.25)
  switchStrength      = min(1, switch[i]/2) * 0.22
  raw[i] = clamp(distractionStrength + switchStrength - focusStrength, -1, 1)
  smoothing (only if count > 2): for raw[i] < 0, take neighbors i-1..i+1 (in range) with value < 0;
     if more than 1 such (including itself): v = clamp(raw[i]*0.55 + avg*0.45, -1, 1)
     (the smoothing reads the original raw array, not the already-smoothed values)
  ```
  The final value lies in [-1, 1]. Negative means focused, positive means distracted, 0 means empty.
- Labels: title "Focus and distraction heat map", focused label "Focused work", distracted label "Distracted".

**Color mapping (render side)**:
```
neutralThreshold = 0.045; edgeFadeStrength = 0.65; centerBoostStrength = 0.34
focusSoft E3DBFD, focusDark 4276E9, distractionSoft F8D1CA, distractionDark FC7645,
neutral = 989898@10% (dark: white@8%)
adjusted(v, row, i):
  if |v| < 0.045 → v
  sign = sign(v); run = maximal same-sign run around i (|x| >= 0.045 and same sign)
  if run.length < 4 → v
  center = (len-1)/2; t = clamp01(1 - |(i-run.start) - center| / max(center,1)); t = t*t*(3-2t)
  edge = max(0.045, |v|*(1-0.65)); peak = min(1, |v|+0.34)
  return sign * (edge + (peak-edge)*t)
color(v'): |v'| < 0.045 → neutral; p = clamp01(|v'|)^0.72
  v' < 0 → lerpRGBA(focusSoft → focusDark, p); else lerpRGBA(distractionSoft → distractionDark, p)
```
**Render**: card height 238, corner radius 4, border, fill white@46%. Padding: top 34, leading 44, trailing 46, bottom 42.
- Header row: the title (serif 20, `FF9A64`) on the left and the legend on the right, 7px down.
  - The legend is a bar 8px tall with radius 2, width `min(max(282.156, width*0.32), 420)`. Its gradient runs `4276E9 -> E3DBFD -> F8D1CA -> FC7645`.
  - Below the bar, 4px down: "Focused work" on the left and "Distracted" on the right (10).
- 25px below the header: the day labels (10, left-aligned, 22px wide, row height 12), then 6px gap, then the grid.
- Cells: 6x12, gap 1, radius 0.5. `gridWidth = n*6 + (n-1)*1`. The grid scrolls horizontally if it overflows.
- Below the grid: 8px, then the hour labels (10, no axis line).

`buildFlowFocus` is a paywall payload for another screen. It is not needed here.

---

## 8. Section: Most used per category (treemap)

**Data** (`buildTreemap`):
- Current = visible facts. Previous = visible facts of the previous week (built with the previous week range).
- `prevLookup["{categoryKey}|{appKey}"] = Σ minutes` (previous week).
- Group the current facts by `categoryKey`. Within each category, group by `appKey`. For each app:
  - `minutes` = Σ.
  - `faviconSource` = the first fact with any favicon field, else the first fact.
  - `change`:
    - If `prev == 0`, there is no change.
    - Otherwise `delta = cur - prev`. Positive gives `"+ {delta}m"`, negative gives `"- {|delta|}m"`, zero gives neutral `"0m"`.
  - Item = `{id:"{catKey}-{appKey}", name: appName, duration: minutes*60 s, change, favicon fields}`.
- Apps are sorted by weight desc, then name asc (`weight = max(durationSeconds, 1)`). **Keep the top 8 apps per category.**
- Category = `{id: catKey, name: categoryName, palette from categoryColorHex, apps}`. `totalDuration` = Σ of the *kept* apps.
- Categories are sorted by weight desc, then name. **Keep the top 5.**
- Title: "Most used per category".
- Duration string: `"{h}hr {m}m"`, `"{h}hr"` or `"{m}m"` (from seconds, using floor minutes).

**Palette per category** (base = category color):
- shell fill: base@0.25
- shell border: base@0.75, 0.75px
- tile fill: base@0.42
- tile border: base, 0.5px
- header text: `6D6D6D` (dark: `DFDFDF`)

Change badge:
- positive: text `089041`, fill `D1EAE4` (dark: text `E0FBEE`, fill `58927F`)
- negative: text `E25922`, fill `FAE0D8` (dark: text `FCE3E1`, fill `CA6D59`)
- neutral: text `8D8C8A`, no fill

The badge text is monospaced, with padding 5x2 and radius 4.

**Layout**:
- The card is 549px tall. The title is at (40,34), serif 20, `FF9A64`.
- The content rect starts at (40,86). Its size is `max(797, width-80) x 400`.
- Categories are laid out with the squarified algorithm into the content rect, with `gap = 6`. Each placement frame is inset by `gap/2` on every side.
- Category card:
  - corner radius 4
  - header: padding 10 horizontal, 8 top, 8 bottom. The name and duration (12, header color) sit on one row. If that does not fit, they stack in two lines. If that still does not fit, only the name shows.
  - leaf area: padding 8 horizontal, 8 bottom
  - tile gap 4
- Leaf aggregation, applied before rendering a category:
  ```
  working = apps sorted
  while working.count > 1:
     place(working) in leafRect with gap 4
     if no non-aggregate leaf has (w < 44 || h < 28 || w*h < 1600): break
     merge the smallest non-aggregate (last in order) into the "Other" aggregate
        (create {id:"other", name:"Other", change:null, isAggregate:true} if missing; sum durations)
     re-sort
  ```
- Squarified layout. Port it verbatim:
  ```
  place(items, rect, gap): visible = value>0, sorted by order; areas = value/total * rect.area
     squarify → each frame inset by gap/2; drop frames with w<=0 or h<=0
  squarify(items, rect):
     if 1 item → [rect]
     while remaining && rect non-empty:
        short = min(w,h); row=[]; best=∞
        for item in remaining: cand=row+[item]; worst = worstAspect(cand, Σarea, short)
            if row empty || worst <= best: row=cand; best=worst else break
        strip = Σrow/short
        if w >= h:  // vertical column on the left
           stack row items top→bottom, each width=strip, height=area/strip; rect.x += strip, rect.w -= strip
        else:       // horizontal row at the top
           place items left→right, each height=strip, width=area/strip; rect.y += strip, rect.h -= strip
        remaining.removeFirst(row.count)
  worstAspect(areas, total, short): strip = total/short; max over a of max(strip/(a/strip), (a/strip)/strip)
  ```
- Leaf tile:
  - fill = tile fill, radius 4
  - Typography by size:
    - large if w>=160 && h>=110: name 20, detail 12, line spacing 4, padding 12
    - medium if w>=90 && h>=54: 16 / 12 / 3 / 10
    - compact otherwise: 13 / 10 / 2 / 6
  - Presentation:
    - `fullHeight` = `hasChange ? (hasFavicon ? 92 : 72) : (hasFavicon ? 70 : 56)`.
    - full if w>=90 && h>=fullHeight. Contents: name row, duration, change badge.
    - compact if w>=58 && h>=34. Contents: name row (font -2, min 11) and duration (font -1, min 10).
    - Otherwise labelOnly: the name row only (font -3, min 10).
  - Name row: an optional favicon of size `max(12, round(font*1.15))`, then 4px, then the name (serif, centered, 1 line, min scale 0.7).
  - All contents are centered.
- Hover: applies to leaves that are not in full mode. It shows a 176x92 hover card:
  - name (serif 17), duration (12), badge
  - fill tooltip white@96% with shell fill@85% over it; stroke shell border@95%
  - shadow blur 14, y 6
  - Position: centered on the tile, clamped horizontally. It goes 10px above the tile if there is room, otherwise 10px below, clamped. It fades and scales in from 0.96.
- Empty week: there are no category cards; only the title shows. No explicit empty text.

---

## 9. Section: Weekly breakdown (Sankey)

### 9.1 Snapshot (`buildSankey`, visible facts)
- If there are no visible facts, the snapshot is empty: id `empty-weekly-sankey`, with empty categories, apps and links.
- `visibleBuckets(key, name, color, maxVisible)`:
  1. Group facts and sum minutes. Name and color come from the first fact of each group.
  2. Sort by minutes desc, then name asc.
  3. If there are more than `maxVisible` buckets:
     - Keep the first `maxVisible-1`.
     - Sum the rest into `{key:"other", name:"Other", color:"BFB6AE"}`, appended last.
     - If a kept bucket already has key `other`, remove it and add its minutes to the overflow.
  4. Keys outside the visible set map to `"other"`.
- Categories: `maxVisible = 6`, using category key, name and color. Apps: `maxVisible = 10`, using app key, name and color.
- App favicon source: the first fact per app key with a favicon field, else the first fact.
- Links:
  1. For each fact, add its minutes to `"{catBucket}|{appBucket}"`.
  2. Keep links with minutes > 0. Each link is `{id:"{from}-{to}", from, to, minutes}`.
  3. Sort by `from` asc. Within the same `from`, sort by minutes desc.
- `id = "weekly-sankey-{yyyy-MM-dd of weekStart}"`.
- `sourceName = "{MMMd(start)}-{MMMd(start+6d)}"`, e.g. "Apr 20-Apr 26". TS: `{month:'short', day:'numeric'}`.

### 9.2 Model build (virtual canvas 1748 x 933, scaled to `width x width*933/1748`)
Column specs `{x, width, top, bottom, gap, minHeight, labelX, labelTop, labelBottom, labelWidth, labelHeight, labelSpacing}`:
```
source:     {72,   12, 273, 706,  0,  0, 105,  0,   0, 220, 52,  0}
categories: {760,  12, 126, 828, 20, 40, 802, 64, 874, 260, 54, 12}
apps:       {1334, 12,  54, 928, 20, 28, 1372, 38, 923, 330, 56, 10}
sourceCurveTension = 0.15
```
- `totalMinutes` = Σ category minutes. App minutes = the snapshot minutes. If those are 0, use the Σ of incoming links.
- `allocateBands(items, spec)`:
  ```
  available = max(n*minH, bottom - top - gap*(n-1)); flexible = max(0, available - minH*n)
  cursor = top; for each item: h = minH + flexible*minutes/total  (total 0 → equal share)
     bar = {x: spec.x, y: cursor, w: spec.width, h}; cursor += h + gap
  ```
- The category bands keep snapshot order (minutes desc, Other last).
- **App ordering by barycenter**:
  - `bary(app) = Σ(categoryBar.midY * linkMinutes)/Σ linkMinutes` over incoming links. If there are no links, use 999.
  - Sort apps by bary asc, with `other` always last. Then allocate the app bands.
- Source node:
  - id `source-weekly-activity`, name = sourceName
  - metric = `formatDuration(total)`, percent `"100%"`, bar color `D9CBC0`
  - bar = `{72, 273, 12, 433}`
  - label at `(105, bar.midY - 26)`, width 220
- `allocateStackSegments(items, top, height)`: split the height proportionally to minutes, top to bottom in the given order. If the total is 0, split equally.
- **Left flows** (source -> category):
  - The source bar is split into segments in category order.
  - Each flow: `x0 = 84` (source maxX), `y0` = the segment top/bottom. `x1 = 760`, `y1` = the full category bar top/bottom.
  - Tension 0.15. `opacity = 0.14 + 0.08*sqrt(catMin/total)`.
- **Right flows** (category -> app):
  - Each category's outgoing links are sorted by the target app bar's `minY`. Stack them in the category bar.
  - Each app's incoming links are sorted by the source category bar's `minY`. Stack them in the app bar.
  - Each flow: `x0 = cat.maxX (772)` to `x1 = app.minX (1334)`, using the respective segments.
  - Tension 0.42. `opacity = 0.08 + 0.18*sqrt(min/maxLinkMinutes)`.
- `formatDuration(m)`: `"{m}min"` if under 1 h, else `"{h}hr {m}min"`. `formatPercent = max(1, round(m/total*100)) + "%"`, or `"0%"` when the total is 0.
- **Label placement** (per column):
  1. Sort the nodes by `bar.midY`. Set `cursor = labelTop`.
  2. For each node: `y = max(midY - labelHeight/2, cursor)`, then `cursor = y + labelHeight + labelSpacing`.
  3. If the last label overflows (`y + labelHeight > labelBottom`):
     - Shift the last label up by the overflow.
     - Walk backwards: `y[i] = min(y[i], y[i+1] - labelHeight - labelSpacing)`.
     - If the first label ends up above `labelTop`, set it to `labelTop`. Then walk forwards: `y[i] = max(y[i], y[i-1] + labelHeight + labelSpacing)`.
  4. Return the nodes in their original order.
- App icon:
  - If the id is `x`, or the name is `x`, or `"{id} {name}"` contains "twitter", use the bundled X favicon.
  - Else, if `hasFaviconSource`, use the favicon (14px, radius 3).
  - Else use a monogram: the first letter uppercased, in a rounded square (radius 3) with the app color as background, white text, bold 8.

### 9.3 Rendering
- Card: fill white@46%, border `EBE6E3`, radius 4.
- Title: "Weekly breakdown", serif 20, `FF9A64`, at virtual (72,64).
- Ribbon path (scale virtual coordinates to the display):
  ```
  curve = max(90, (x1-x0)*tension)
  M x0,y0Top  C x0+curve,y0Top  x1-curve,y1Top  x1,y1Top
  L x1,y1Bottom  C x1-curve,y1Bottom  x0+curve,y0Bottom  x0,y0Bottom  Z
  ```
- Underlays, drawn first and only if there are categories and apps:
  1. Source -> category column envelope. It runs from the source bar to the span from the first category top to the last category bottom, with tension 0.15. Its horizontal gradient: `E6DBD1@.48 (0)`, `EFE9E3@.34 (.42)`, `F4EEE9@.2 (.76)`, `F7F2ED@.08 (1)`.
  2. Category -> app envelope, from x=772 to the app column, with tension 0.22. Opacity 0.72 overall. Gradient: `EFE7E0@.08`, `F4EEE9@.11 (.46)`, `EFE7E0@.07`.
- Ribbon fill is a horizontal linear gradient from x0 to x1. Let `strength = clamp(opacity, 0.08, 0.36)`.
  - The tint maps `000000`/`333333` to `CAC2BA`, and `D9D9D9`/`BFB6AE` to `CFC8C1`. Other colors pass through.
  - Source flows: `E3D8CF@.18 (0)`, `ECE3DC@.16 (.24)`, `to@min(.12,s*.42) (.58)`, `to@min(.2,s*.72) (.82)`, `to@min(.32,s*1.08) (1)`.
  - Category flows: `from@min(.2,s*.68) (0)`, `from@min(.11,s*.4) (.24)`, `to@min(.05,s*.2) (.54)`, `to@min(.12,s*.42) (.78)`, `to@min(.27,s*.9) (1)`.
- Bars: rectangles in the node color (source `D9CBC0`).
- Category/source labels: the name (10, text color), then 2px, then `"{metric} | {percent}"` (10, secondary). The separator is a 0.5x11 rule, color `CFC7C1`.
- App labels: the icon (14) and the name (10), followed inline by the metric, a rule (0.5x10) and the percent (9, secondary). Height 56 virtual, vertically centered.
- Interaction:
  - `active = pinned ?? hovered`. Hovering or clicking a bar or label sets or toggles that node.
  - Hovering a ribbon activates the ribbon's `to` node. Hit test: the ribbon expanded vertically by 8 display px, topmost (last drawn) first.
  - Clicking a ribbon toggles its `to` node. Clicking empty space unpins.
  - Leaving the card clears hover. Changing the week clears both.
  - Flow opacity: 1 if there is no active node, or if the flow touches the active node (the source as active node lights everything). Otherwise 0.12.
  - Node opacity: 1 if the node is active, if the source is active, or if a flow links it directly to the active node. Otherwise 0.25.
- The dev dataset switcher (Timeline / Figma baseline / Random stress) is hidden on the page (`showsControls:false`). Drop it.

---

## 10. Built but not mounted (optional; shown in `weekly.png`)

### 10.1 Interactions between most used applications (graph)
**Data** (`buildApplicationInteractions`):
- App facts = visible facts with `appKey != "other"`.
- Empty state: subtitle `"No recorded app interactions for this week yet."`, no nodes or edges. The rabbit hole shows `{id:"none", name:"No app", initial:"-", color:"D9D9D9", avg:"0m avg"}`.
- Aggregates per app key: `minutes`, `visits = fact count`, `kind` (§3.10). Sort by minutes desc, then name. **Top 14 are visible.**
- Node positions are fixed slots, indexed by rank, in a 565x561 canvas:
  `(256.5,253.3) (106.5,411.3) (134,154.3) (220,136.8) (308.5,167.8) (342.5,108.8) (436.1,142.8) (501.5,255.8) (391.1,310.8) (391.5,415.8) (296,380.3) (62,304.8) (111,233.8) (179.5,343.3)`.
  - Size: rank 0 is 76. Others are `30 + sqrt(min/maxMin)*28`.
  - `mark` = the first letter, uppercased. `isPrimary` = rank 0. `isMuted` = rank > 5.
- Transitions:
  - Per day, sort by start and skip facts whose app is not visible.
  - Count a transition `prev -> cur` whenever the app keys differ.
  - Sort by count desc, then `"{from}-{to}"` asc.
- Edges: the first 18 transitions.
  - `weight = count/maxCount`.
  - `kind`: distraction if either end is a distraction, else personal if either end is personal, else work.
  - `curveOffset = [-42,24,-55,-22,52,-14,30,-30,18,-62][i%10]`.
  - Each edge is a quadratic curve. The control point is the midpoint plus `(0, curveOffset)`.
  - Stroke style per kind:
    - work: color `A9C3FF`, opacity `.24+.24w`, width `.9+.95w`
    - personal: color `D5D0CA`, opacity `.18+.2w`, width `.8+.75w`
    - distraction: color `FC7645`, opacity `.66+.34w`, width `.95+1.05w`
- Node style:
  - Circle fill: work `EEF3FF`. Personal is a vertical gradient `FFDCCF -> E6E6E6`. Distraction is a vertical gradient `FFDCCF -> E6E6E6 -> EEF3FF`.
  - Border: work `4779E9`, personal `B8B8B8`, distraction `FC7645`. Width 2.5, or 3 for the primary node.
  - The primary node has an extra 5px `EEF3FF` halo. Muted nodes have opacity 0.3.
  - Mark: bold 13 (primary 20). Color `4779E9` for work, otherwise `8D8C8A`. The image shows favicons instead of letters; using favicons is fine.
- Legend: Work, Personal and Distraction swatches at (158,507).
- Subtitle: `"About {pct}% of recorded app time was spent using these applications."`, where pct = visible minutes / total minutes, rounded to 0 decimals.
- Patterns (side panel): up to 2 non-distraction transitions.
  - `avg = max(1, round(count/activeDays))`.
  - Text: `"Moves from {A} to {B} an average of {avg} times per active day."`
- Rabbit hole:
  - Take the first transition from a non-distraction app to a distraction app. Its source is the hub. The targets are the distraction transitions from the same hub, up to 4.
  - Fallback: the hub is the top app, and the targets are the visible distraction apps, up to 4.
  - `avg = "{durationText(max(1, round(Σmin/Σvisits)))} avg"`.

### 10.2 Time distribution (overview)
Shown in the image as "Time distribution". `WeeklyOverviewBuilder` uses donut keys and excludes `system` categories (idle categories are included).
- Rows: one per day, Mon..Sun. Labels Mon..Sun and full names Monday..Sunday.
- Segments:
  - Each card is clipped to **09:00–18:00** (540..1080 on the normalized axis).
  - Categories outside the top keys become `other` with color `BFB6AE`.
  - Adjacent same-key segments with a gap of 1 minute or less are merged.
- Visible keys: the top 5 by minutes. If there are more than 5, keep the top 4 and add a legend "Other".
- Legend order: category order, then name.
- Stats:
  - `contextSwitchTotal`: per-day count of consecutive category changes (all non-system cards).
  - `contextSwitchAverage = round(total/7)`.
  - `totalFocusMinutes` = Σ of non-idle categories.
  - `primaryFocus`: the top non-idle category.
  - `longestFocus`: the longest per-day merged run of non-idle cards, where gaps under 5 min are merged. Reported as `{weekdayName, minutes}`.
- Render: rows 18px tall (fill `F2F2F2`, border `E5E4E3`, radius 2), segments 12px tall, bar width 836, day label 26px wide, axis labels 9 AM..6 PM, footer 65px tall.

Highlights and 1:1 suggestions builders exist but are private and unused. Skip them.

---

## 11. PNG export (per card)
- On hover, a 24x20 download button fades in next to the card title:
  - offset = title origin + title width + 8px
  - icon color `DF8351`, fill `FFF5EA`, border `F7E4CE` (0.75px), radius 6
  - tooltip `"Download {title} as a full-resolution PNG"`
- On click, render the card at design size on background `FBFBFB`, in light mode, at 2x scale. Add a watermark pill in the corner, 14px in: logo 16px, then "Generated with" (semibold 10, secondary) and "Dayflow" (bold 10, `FF9A64`). Pill: height 26, fill white@96%, border `EBE6E3`.
  - Corner: bottom-trailing for all cards except the Sankey, which uses bottom-leading.
- Then open a Save dialog with the default name `dayflow-weekly-{slug(weekTitle)}-{graphic}.png`. Graphic slugs: `weekly-distribution`, `context-charts`, `weekly-workflow`, `focus-heatmap`, `focus-breakdown`, `weekly-breakdown`.
- Export sizes:
  - donut 461x300
  - context 958x300
  - workflow `max(958, 36+30+13+gridW+52)` x 292
  - heatmap `max(958, 44+22+6+gridW+46)` x 238
  - treemap 958x549
  - Sankey 958 x 958*933/1748
- Windows: serialize the SVG/DOM to a canvas (or use `webContents.capturePage` on an offscreen view), then `dialog.showSaveDialog`.

---

## 12. Data structures (TypeScript)

```ts
type Hex = string; // 6-digit, no '#'

interface WeeklyDateRange { weekStart: Date; weekEnd: Date }       // Mon 04:00 .. +7d

interface WeeklyDashboardSnapshot {
  donut: WeeklyDonutSnapshot;
  contextCharts: WeeklyContextChartsSnapshot;
  workflow: WeeklyWorkflowSnapshot;
  heatmap: WeeklyFocusHeatmapSnapshot;
  treemap: WeeklyTreemapSnapshot;
  sankey: WeeklySankeySnapshot;
  overview?: WeeklyOverviewSnapshot;                       // optional (§10.2)
  applicationInteractions?: WeeklyApplicationInteractionsSnapshot; // optional (§10.1)
}

interface WeeklyPageState {
  unlocked: boolean; completedBatchCount: number;          // target 120
  recordedMinutes: number | null;                          // gate at 900
  isLoading: boolean; canNavigateForward: boolean; title: string;
}

interface WeeklyDonutItem { id: string; name: string; colorHex: Hex; minutes: number }
interface WeeklyDonutSnapshot { items: WeeklyDonutItem[]; totalMinutes: number }

interface WeeklyContextComparisonDay { day: string; distracted: number; shifts: number }
interface WeeklyContextChartsSnapshot {
  comparison: { days: WeeklyContextComparisonDay[]; insight: string };
  distribution?: { days: string[]; start: '10:00'; end: '18:00';
    events: { day: string; kind: 'context' | 'distraction'; time: string }[] }; // unused
}

interface WeeklyTimeLabel { id: string; label: string; minute: number }

interface WeeklyWorkflowCell { id: string; categoryName: string | null; colorHex: Hex | null;
  minutes: number; occupancy: number }                     // occupancy 0..1
interface WeeklyWorkflowRow { id: string; label: string; cells: WeeklyWorkflowCell[] }
interface WeeklyWorkflowTotalItem { id: string; name: string; minutes: number;
  duration: string; colorHex: Hex }
interface WeeklyWorkflowSnapshot { title: string; startMinute: number; endMinute: number;
  slotMinutes: 15; timeLabels: WeeklyTimeLabel[]; rows: WeeklyWorkflowRow[];
  totals: WeeklyWorkflowTotalItem[] }

interface WeeklyFocusHeatmapRow { id: string; label: string; values: number[] } // -1..1
interface WeeklyFocusHeatmapSnapshot { title: string; focusedLabel: string;
  distractedLabel: string; startMinute: number; endMinute: number; bucketMinutes: 5;
  timeLabels: WeeklyTimeLabel[]; rows: WeeklyFocusHeatmapRow[] }   // rows Sun..Sat

interface FaviconFields { faviconPrimaryRaw?: string | null; faviconSecondaryRaw?: string | null;
  faviconPrimaryHost?: string | null; faviconSecondaryHost?: string | null }
interface WeeklyTreemapChange { text: string; kind: 'positive' | 'negative' | 'neutral' }
interface WeeklyTreemapApp extends FaviconFields { id: string; name: string;
  durationSeconds: number; change: WeeklyTreemapChange | null;
  isAggregate: boolean; isPlaceholder: boolean }
interface WeeklyTreemapCategory { id: string; name: string; colorHex: Hex; apps: WeeklyTreemapApp[] }
interface WeeklyTreemapSnapshot { title: string; categories: WeeklyTreemapCategory[] }

interface WeeklySankeySnapshotCategory { id: string; name: string; minutes: number; colorHex: Hex }
interface WeeklySankeySnapshotApp extends FaviconFields { id: string; name: string;
  minutes: number; colorHex: Hex }
interface WeeklySankeySnapshotLink { id: string; from: string; to: string; minutes: number }
interface WeeklySankeySnapshot { id: string; sourceName: string;
  categories: WeeklySankeySnapshotCategory[]; apps: WeeklySankeySnapshotApp[];
  links: WeeklySankeySnapshotLink[] }

// render model (virtual 1748x933 coords)
type SankeyIcon = { type: 'asset'; name: string } | ({ type: 'favicon'; fallbackRaw?: string } & FaviconFields)
  | { type: 'monogram'; text: string; backgroundHex: Hex; foregroundHex: Hex } | { type: 'none' };
interface Rect { x: number; y: number; width: number; height: number }
interface WeeklySankeyNode { id: string; name: string; metric: string; percent: string;
  minutes: number; barColorHex: Hex; icon: SankeyIcon; bar: Rect;
  label: { x: number; y: number; width: number } }
interface WeeklySankeyFlow { id: string; from: string; to: string; fromColorHex: Hex;
  toColorHex: Hex; x0: number; y0Top: number; y0Bottom: number; x1: number;
  y1Top: number; y1Bottom: number; curveTension: number; opacity: number }
interface WeeklySankeyModel { id: string; source: WeeklySankeyNode;
  categories: WeeklySankeyNode[]; apps: WeeklySankeyNode[]; flows: WeeklySankeyFlow[] }

// internal
type WeeklyApplicationKind = 'work' | 'personal' | 'distraction';
interface WeeklyCardFact extends FaviconFields { id: string; card: TimelineCard;
  dayString: string; dayLabel: string; dayOrder: number; startMinute: number;
  endMinute: number; durationMinutes: number; categoryKey: string; categoryName: string;
  categoryColorHex: Hex; isSystem: boolean; isIdle: boolean; isDistraction: boolean;
  appKey: string; appName: string; appColorHex: Hex; appKind: WeeklyApplicationKind }

// optional sections
interface WeeklyApplicationNode { id: string; name: string; x: number; y: number; size: number;
  kind: WeeklyApplicationKind; mark: string; isPrimary: boolean; isMuted: boolean }
interface WeeklyApplicationEdge { from: string; to: string; kind: WeeklyApplicationKind;
  weight: number; curveOffset: number }
interface WeeklyPatternApp { id: string; name: string; initial: string; colorHex: Hex; avg: string }
interface WeeklyApplicationInteractionsSnapshot { subtitle: string; nodes: WeeklyApplicationNode[];
  edges: WeeklyApplicationEdge[];
  patterns: { id: string; from: WeeklyPatternApp; via: null; to: WeeklyPatternApp;
    count: number; description: string }[];
  rabbitHole: { from: WeeklyPatternApp; targets: WeeklyPatternApp[]; avg: string } }
interface WeeklyOverviewSnapshot {
  rows: { id: string; label: string; weekdayName: string;
    segments: { id: string; categoryKey: string; colorHex: Hex; startMinute: number; endMinute: number }[] }[];
  legendItems: { id: string; name: string; colorHex: Hex }[];
  contextSwitchTotal: number; contextSwitchAverage: number; totalFocusMinutes: number;
  longestFocus: { weekdayName: string; minutes: number } | null;
  primaryFocus: { name: string; minutes: number; colorHex: Hex } | null }
```
Windows input mapping:
- `TimelineCard {startTime, endTime, day, category, subcategory, title, summary, detailedSummary, distractions[], appSites{primary, secondary}, isError}`.
- `recordId` maps to `id`.
- Categories come from settings: `Category {name, color, isIdle?}`. Order = array index, and `isSystem` = (name key == "system").

---

## 13. Palette (light / dark)
```
title FF9A64/FF9A64          accent DF8351/F77952       text 333333/FFFFFF
secondaryText 777777/DDDDDD  mutedText A5A5A5/B4B4B4    cardBorder EBE6E3/4E4E4E
cardFill white@46%/7F7A94@10%   footerSectionFill FAF7F5/7F7A94@10%   solid FFFFFF/272A3C
rowFill F2F2F2/white@8%      rowBorder E5E4E3/4E4E4E    divider E5DFD9/4E4E4E
axis 5A534C@90%/DDDDDD       axisSoft C9C2BC/white@25%  emptyCell 989898@10%/white@8%
swatchNeutral CFC7C1/6E6E6E  softAccentFill FFF5EA/F77952@18%  softAccentBorder F7E4CE/F77952@40%
highlightChipFill FFECE0/F77952@18%  tooltipFill white@96%/272A3C@96%  shadow black@5%/black@25%
canvas: transparent (main panel bg shows through)
```
Fonts:
- "InstrumentSerif-Regular" for titles and large numbers.
- "Figtree" (Regular/Medium/SemiBold/Bold) for everything else.

Both fonts are bundled with the app (OFL licensed).

---

## 14. Drop as macOS-specific
- SwiftUI `Charts`, `Canvas`, `ImageRenderer`, `NSSavePanel`, `NSImage` and `NSAppearance`. Replace them with SVG, a canvas export and an Electron save dialog.
- `NotificationService` and `x-apple.systempreferences:` deep links. Use Electron `Notification` and `ms-settings:notifications`.
- `StylePreview.showAfter` "before/after" style toggle. Implement only the **after** values used above (cream canvas `FBF6EF` is "before").
- `.help()` tooltips map to `title` / a custom tooltip; `pointingHandCursorOnHover` maps to CSS `cursor:pointer`; `hoverScaleEffect` maps to a CSS transform.
- macOS-only raw-favicon assets (Finder, Apple apps, iCloud…). Keep the mechanism and swap in Windows app icons.
- `buildFlowFocus` / Flow bridge payload (paywall web view), Sankey dev controls, figma/random fixtures, `#Preview` blocks.
- The locked-page preview can reuse fixture snapshots, or be a static blurred screenshot.
- PostHog `favicon_fetch_failed` analytics.
