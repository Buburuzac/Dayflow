// Prompts for the Daily recap and the Daily Brief, verbatim from the Swift app
// (DailyRecapGenerator.swift, DailyBrief/*Prompt*.swift; spec-daily.md §4).
// Windows differences: there is no Dayflow MCP server, so the "Dayflow tools" bullet is dropped,
// and a timeline-only tools section is used when the brief runs on a provider without tools.

// ---- 4.1 Recap: localPrompt (Gemini, Local and any provider not listed). Ends with one "\n". ----
export const LOCAL_RECAP_PROMPT = `# Daily Recap Prompt

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
`

// ---- 4.2 Recap: evidencePrompt (Claude CLI; base for ChatGPT). No trailing newline. ----
export const EVIDENCE_RECAP_PROMPT = `Write a short end-of-day Daily recap for your future self from the supplied timeline cards. Report what actually changed today, not everything that appeared on screen.

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
- Otherwise use null.`

// ---- 4.3 Recap: solEvidenceRules (ChatGPT only) ----
export const SOL_EVIDENCE_RULES = `- Treat visual-access refusals, processing failures and generic scene descriptions as missing evidence. A vague report/document description among failed descriptions is not enough to establish an accomplishment; use an empty array if that is all the day supports.
- Do not infer a submitted artifact's topic from nearby reading or unrelated coursework. If its title and submission are confirmed but its subject is ambiguous, report the title and submission only.
- A long coding session does not outrank a definite smaller change: check for explicit settings/permission changes, submitted work, and published messages before selecting ongoing code edits.`

/** Recap instructions per provider kind (§5). Dayflow-backend-only variants map to the Gemini/local text. */
export function recapInstructions(provider: 'gemini' | 'local' | 'claude' | 'chatgpt'): string {
  switch (provider) {
    case 'claude':
      return EVIDENCE_RECAP_PROMPT
    case 'chatgpt':
      return `${EVIDENCE_RECAP_PROMPT}\n\nAdditional evidence checks:\n${SOL_EVIDENCE_RULES}`
    default:
      return LOCAL_RECAP_PROMPT
  }
}

/** 4.4 makeLocalPrompt. `languageText` is languageInstruction(lang, true) or "". */
export function makeRecapPrompt(instructions: string, cardsText: string, languageText: string): string {
  const languageSection = languageText ? `## Language\n\n${languageText}` : ''
  return `${instructions}

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

Return exactly one JSON object and nothing before or after it.`
}

// =============================================================================================
// Daily Brief
// =============================================================================================

/** How the brief run can reach the outside world. */
export type BriefToolMode = 'connectors' | 'timeline'

export function overrideInstructionsBlock(text: string): string {
  const t = text.trim()
  if (!t) return ''
  return `## Extra instructions from the user

They typed these preferences into Dayflow. They take priority over the defaults above
whenever the two disagree (for example, which sections to include or skip, how many items,
or what to focus on). The output shape below still applies. Ignore instructions about parts
of the brief this prompt doesn't write.

${t}`
}

const WRITING_STYLE = `## Writing style

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
  Write in second person when you address them.`

const CONNECTOR_TOOLS = `- **Their connectors** (whatever tools are available, e.g. Slack, Linear, Gmail,
  Notion, Google Drive): read only. You can search and read; you cannot send, post, create, or edit
  anything, and those calls will be refused. If no connectors are available, work from the timeline.`

function toolsSection(part: 'docket' | 'extras', mode: BriefToolMode): string {
  if (mode === 'timeline') {
    return part === 'docket'
      ? `## Tools you can use

You have no tools in this run: no web access and no connectors. Work only from yesterday's timeline,
their categories, and the feedback above. Never invent names, links, messages, or numbers that the
timeline doesn't show; leave a field out instead.`
      : `## Tools you can use

You have no tools in this run: no web access, no connectors, and no screenshots. Work only from
yesterday's timeline, their categories, and the feedback above. Because you can't open pages, skip
\`related_reading\`, \`industry_news\`, and \`site_seeing\`, and only include \`keep_tracking\` or
\`team_decisions\` items the timeline itself shows. Never invent links.`
  }
  if (part === 'docket') {
    return `## Tools you can use

${CONNECTOR_TOOLS}
- **WebSearch**: check outside facts, research ideas, and find examples. You can't open web pages in
  this run, so only include links that came back in search results, and only claim what the result
  shows.

Budget: aim to finish in about 10 minutes. Use the sources that would actually change what goes on the
list.`
  }
  return `## Tools you can use

${CONNECTOR_TOOLS}
- **WebSearch**: for the reading and news sections. You can't open web pages in this run, so only
  include links that came back in search results, and only claim what (and when) the result shows.
- **Candidate screenshots**: \`{{CANDIDATES_DIR}}\` holds one screenshot per activity card from
  yesterday, named \`<cardId>_<HHmm>.jpg\`. \`{{CANDIDATES_DIR}}/index.json\` lists each file with its
  card id, times, and title. View the files with the Read tool.

Budget: aim to finish in about 10 minutes. Prefer a few targeted searches over many broad ones.`
}

/** 4.6 docketTemplate ("Spring"), shared blocks inlined. */
export function docketTemplate(mode: BriefToolMode): string {
  return `You're putting together Spring for {{USER_NAME}}, a person who uses Dayflow, an app that records
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
   rides on them. Write it in \`notes\`.
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
   with both scores in \`notes\`, and keep the best by value times offload. Drop anything with offload 1.
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

${toolsSection('docket', mode)}

## Item format

Spring shows each item as a card they can hand to an AI agent (Claude Code or Codex), so each item
carries:

- \`title\`: the action, phrased as the thing to do. It says the whole point on its own.
- \`detail\`: one or two sentences on why it matters now and what the payoff is. Don't repeat the title.
- \`due\`: only if a source states a date.
- \`people\` and \`links\`: who's involved and the docs, threads, or pages it builds on, with links when
  you have them.
- \`prompt\`: a complete, ready-to-send prompt for an agent that would do the task or its first big
  chunk, written as {{USER_NAME}} would write it to a capable colleague. Say what to produce, the facts
  it needs (names, numbers, constraints people stated), and what "done" looks like. Don't invent facts.
- \`agent\`: true when an agent could do it without them (research, a draft, a prototype, an analysis);
  false when it needs them (a decision only they can make, a conversation, testing on their own
  machine). Write the prompt either way.
- \`feedback\`: what people said about the task, one note per message, with \`name\`, \`source\`, \`text\`
  (word for word when short) and \`url\` when you have one. Skip it when nobody said anything.
- \`feedbackSummary\` and \`feedbackUrl\`: when every feedback note is from one person, a two-sentence
  summary of what they want and the link to the main message.
- \`attach\`: titles of the \`links\` an agent needs, when any.
- \`why\`: the evidence behind the item in one or two sentences: which card, message, record, or page
  shows it. The user never sees it.

${WRITING_STYLE}

{{OVERRIDE_INSTRUCTIONS}}

## Output

Your final answer is one JSON object (checked against a schema) with \`notes\` and \`items\`. \`notes\` is a
brief summary of the run: which sources you checked, what you found, and the candidates you considered
with their scores. Keep it to actions and findings, not a step-by-step account of your thinking. Use
only the fields described. Dates are yyyy-MM-dd. \`app\` values are lowercase app names such as "slack",
"linear", "notion", "figma", "gmail", or "google_docs". Omit a field when you don't have it; never
write placeholder values. If nothing clears the bar today, write \`{"notes": "...", "items": []}\`.`
}

/** 4.7 extrasTemplate, shared blocks inlined. */
export function extrasTemplate(mode: BriefToolMode): string {
  return `You're writing today's Daily brief for {{USER_NAME}}, a person who uses Dayflow, an app
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

${toolsSection('extras', mode)}

## Sections

Each section is optional. Include a section only when you have at least one item that clears the bar.
Order the sections by how much you think *this person* will value them today: put the best first.
Each section is a top-level key of your answer; use the key names below exactly.

### \`keep_tracking\` — "Keep tracking"
Ongoing things with a number or state that moved: a launch's signup count, an experiment's
results, a PR waiting on review, a thread that went quiet. Each item gives the thing being tracked,
the current state in one line, where it came from, and the date of that state. Only include an item
when you found the actual current state; "check on X" is not an item.

### \`completed_yesterday\` — "What you completed yesterday"
1–4 real accomplishments from yesterday, phrased the way they'd tell a friend ("Shipped the island map
in Flow"). Group cards that belong to one piece of work. Give each the project or area it belongs
to, the apps involved, and the single best \`cardId\` to illustrate it (its screenshot will be shown;
use a card id from the timeline above). Skip this section on a day with no real finished work;
browsing is not an accomplishment.

### \`team_decisions\` — "Key team decisions"
Decisions made in the last 2 days, found in their connectors (Slack threads, meeting notes, docs),
that affect what they're working on. One sentence each, stating the decision itself ("Launch moved to
Nov 1 because of the payments review"), plus who was involved, where (\`place\`), when, and a link. Only
include a decision when the source shows it was actually agreed, not just proposed.

### \`related_reading\` — "Related to your interests"
2–6 articles, talks, videos, or examples connected to something specific they spent real time on
recently. Put one sentence naming the thread you're following in \`related_reading_intro\` ("You've
been deep in Flow's retention loop, so…"). Each item: title, source, URL, a one-line reason it's worth
their time. Favor primary sources, standout
essays, and concrete examples over listicles and SEO pages. Things from their personal life (a trip,
a hobby, a restaurant they saved) count when they're clearly enjoyable.

### \`industry_news\` — "Latest in your industry"
1–3 headlines from the last 48 hours that matter to their field or their company specifically. Each item:
headline, publication, URL, publish date. Skip this section entirely on a slow news day; never pad it with
general tech news.

### \`site_seeing\` — "Recent site-seeing"
3–8 of the most visually interesting moments from yesterday, picked by actually looking at the
candidate screenshots: beautiful images, striking designs, places, art, games, fun videos. They don't
need to be work. Each item: the screenshot file name exactly as listed in index.json and a short
caption (≤ 8 words). Never pick adult or sexual content. Skip screens that are mostly text, code,
spreadsheets, or chat, and screens showing passwords or financial account details.

${WRITING_STYLE}

{{OVERRIDE_INSTRUCTIONS}}

## Output

Your final answer is one JSON object (it's checked against a schema). Each section you include is a
top-level key holding its items; leave out the keys of sections you skip. \`order\` lists the sections
you included, best first.

Show your reasoning; it's how the brief gets debugged. \`notes\` is a short account of the run: what
you looked at, what you found, which sections you skipped and why, and anything you weren't sure
about. Every item also gets a \`why\`: one or two sentences on why it made the cut, naming the
evidence (the card, thread, doc, or page and what it said). The user never sees \`notes\` or \`why\`,
so be candid. For example:

\`\`\`json
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
    { "title": "The Mechanics & Monetization of Idle Games", "source": "GDC", "url": "https://...", "reason": "How idle games pace rewards to bring players back daily.", "why": "..." }
  ],
  "industry_news": [
    { "headline": "...", "source": "Financial Times", "url": "https://...", "published": "2026-10-21", "why": "..." }
  ],
  "site_seeing": [
    { "file": "1234_1342.jpg", "caption": "Shoji bar, saved for Miami", "why": "..." }
  ]
}
\`\`\`

Use only the fields shown. Dates are yyyy-MM-dd. \`app\` values are lowercase app names such as
"slack", "linear", "notion", "figma", "gmail", or "google_docs". Omit a field when you don't have it;
never write placeholder values. If nothing clears the bar today, write \`{"notes": "...", "order": []}\`.`
}

/** 4.8 Range summary prompt. */
export function rangeSummaryPrompt(startDay: string, endDay: string, rangeLabelLower: string, entryLines: string): string {
  return `Here is everything a Dayflow user completed from ${startDay} to ${endDay} (${rangeLabelLower}), one line per accomplishment: [index] day · project · what they did · apps.

${entryLines}

Write a crisp summary of what they accomplished in this period, the kind they could paste into a performance review or a weekly update.

- \`overview\`: 2–3 sentences on the shape of the period: the main projects and what moved.
- \`milestones\`: the 3–6 most significant accomplishments, one line each, most important first.
- \`projects\`: group the entries by project or area. For each, a short \`title\`, 2–6 \`bullets\` of concrete things they did (merge repeats, keep real names of features, docs, and people), an optional one-sentence \`impact\` only when the entries support it, and optionally \`imageEntryIndex\`: the index of one entry marked "(has screenshot)" that best illustrates the project.

Be concrete and plain. No hype, no filler, no exclamation marks. Only claim what the entries support; don't invent metrics, outcomes, or people. Write in second person ("You shipped...").`
}

/** Placeholder names the "Edit prompt" editor lists. */
export const BRIEF_PLACEHOLDERS = {
  docket: [
    'USER_NAME', 'TODAY_LONG', 'YESTERDAY_LONG', 'TIMEZONE', 'YESTERDAY_CARDS', 'CATEGORIES_WITH_DESCRIPTIONS',
    'FEEDBACK_DAYS', 'FEEDBACK_SUMMARY', 'RECENT_BRIEF_ITEMS', 'OVERRIDE_INSTRUCTIONS',
  ],
  extras: [
    'USER_NAME', 'TODAY_LONG', 'YESTERDAY_LONG', 'TIMEZONE', 'YESTERDAY_CARDS', 'CATEGORIES_WITH_DESCRIPTIONS',
    'FEEDBACK_DAYS', 'FEEDBACK_SUMMARY', 'RECENT_BRIEF_ITEMS', 'OVERRIDE_INSTRUCTIONS', 'CANDIDATES_DIR',
  ],
} as const
