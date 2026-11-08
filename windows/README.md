# Dayflow for Windows

A Windows port of [Dayflow](https://github.com/JerryZLiu/Dayflow), the private, automatic work journal.
The macOS app is native Swift/SwiftUI; this port is a rewrite in Electron + TypeScript + React
that keeps the same pipeline, prompts and database layout.

## How it works

1. **Capture**: every 10 s (configurable) a screenshot is taken of the display under the mouse
   cursor, scaled to 720p/1080p and saved as JPEG. Each frame is labelled with the foreground
   window's process name and title. Capture pauses while the screen is locked or the PC is
   asleep, and skips frames entirely while an excluded app is in front.
2. **Batching**: frames are grouped into 15-minute batches (split on gaps over 2 minutes).
   Batches where the keyboard and mouse were idle are marked idle without calling an LLM.
3. **Transcription**: the AI provider turns the batch's frames into timestamped observations.
4. **Cards**: observations from the last 45 minutes, plus the cards already in that window,
   are rewritten into timeline cards (title, summary, detailed summary, category, distractions).
   Coverage and duration are checked, with retries, using the same rules as the macOS app.

## AI providers

| Provider | Setup |
| --- | --- |
| Gemini | API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Local (Ollama / LM Studio) | Any OpenAI-compatible server with a vision model, e.g. `ollama pull qwen2.5vl:7b`, URL `http://localhost:11434/v1` |
| Claude Code CLI | `npm i -g @anthropic-ai/claude-code`, sign in once with `claude` |
| ChatGPT (Codex CLI) | `npm i -g @openai/codex`, sign in once with `codex` |

API keys are encrypted with Windows DPAPI (Electron `safeStorage`).

## Data

Everything lives in `%APPDATA%\Dayflow`:

- `chunks.sqlite`: timeline, batches, observations, LLM call log
- `recordings\YYYY-MM-DD\*.jpg`: screenshots, purged by the retention period and disk limit
- `settings.json`, `secrets.bin`

## Develop

Requires Node 22+.

```powershell
cd windows
npm install
npm run dev          # Electron with hot reload
npm test             # unit tests (time parsing, JSON extraction, validation, batching, storage)
npm run typecheck
npm run dist         # dist\Dayflow Setup <version>.exe (NSIS installer)
```

Set `DAYFLOW_DATA_DIR` to run against a throwaway data folder instead of `%APPDATA%\Dayflow`.

## Differences from the macOS app

| macOS | Windows port |
| --- | --- |
| ScreenCaptureKit | Electron `desktopCapturer`, with a GDI fallback through a PowerShell helper |
| Gemini gets an MP4 timelapse | Gemini gets up to 30 JPEG frames inline, each with a timestamp label |
| Accessibility API for app names | `GetForegroundWindow` via PowerShell |
| Keychain | DPAPI |
| GRDB | built-in `node:sqlite` (no native modules) |
| Menu bar | System tray |

## Features

| Page | What it does |
| --- | --- |
| Timeline | Cards per day (4 AM boundary), category totals, day goals, card detail with frame scrubber and timelapse video, edit title/category, delete, reprocess, Markdown export, card review |
| Daily | Standup recap (done / next / blockers) generated each morning, editable and copyable; Daily Brief (task docket, completed work, things to track; with Claude Code it can also use the web and your connectors, behind a read-only guard) |
| Weekly | Category donut, context shifts vs distractions, 15-minute workflow grid, focus/distraction heatmap, app treemap with week-over-week change, Sankey; PNG export |
| Chat | Ask questions about your timeline. The model reads it through two read-only tools (`fetchTimeline`, `fetchObservations`): Gemini/OpenAI function calling, or a bundled stdio MCP server for the Claude and Codex CLIs. Answers can include charts; conversations and a memory note are stored locally |
| Flow | Focus sessions with goals and a timer; a distraction agent checks the screen every 15 s and a small always-on-top creature nudges you when you drift |
| Review | Rate cards (swipe or arrow keys) to mark how accurate the timeline was |

Optional: **accessibility log** (Settings → Recording, off by default). UI Automation records window switches, on-screen text,
clicks and typing (never password fields or excluded apps), condensed and added to the prompt for the Claude/Codex
providers.

Design notes and the original-feature specs used for the port are in `docs/spec-*.md`.

Not ported: the Dayflow Pro account and hosted backend provider, surveys and analytics, the
hosted dayflow.so Flow pages (replaced by native screens), and macOS-only bits (menu-bar extras, Sparkle updates).
