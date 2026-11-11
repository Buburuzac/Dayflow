# Dayflow Sync Server — design contract

Shared contract for three parallel implementations: the **server** (`server/`), the **desktop client sync module**
(`windows/src/main/sync/`, `windows/src/main/features/sync.ts`) and the **web dashboard** (`server/web/`).
Types shared by all three live in `windows/src/shared/sync-types.ts` (single source; the server imports it by
relative path and bundles it).

## Goals

1. One user, several computers: every device keeps analysing locally; the server relays results (cards, observations,
   standups, goals, categories, projects, user edits) so every device and the web dashboard see the whole day.
2. Teams: workspaces with members and shared **projects**. Each person decides what leaves their machine.
3. Odoo 15 timesheets: confirmed project time becomes `account.analytic.line` records.

Non-goals: syncing screenshots or the accessibility log (they never leave the device), server-side screen analysis.

## Deployment

- Host `megaserv` = `192.168.0.90` (Ubuntu 26.04, Docker 29, compose v2). SSH `jkl@192.168.0.90 -p 60022`, docker via `sudo`.
- Compose project `dayflow` in `/srv/dayflow`: `dayflow-server` (Node 24) + `dayflow-postgres` (postgres:17), volume `dayflow_pg`.
- Published on the LAN at `http://192.168.0.90:8790` (port 8790 is free; do not touch the existing traefik on :80 —
  it belongs to oduflow). Reachable from Torzym/other sites through the existing WireGuard routes. No Internet publishing
  in this phase.
- Config via `/srv/dayflow/.env` (not in git): `DATABASE_URL`, `PUBLIC_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` (Desktop-app OAuth client), `ALLOWED_EMAIL_DOMAINS` (optional, e.g. `velesagro.pl`),
  `BOOTSTRAP_ADMIN_EMAILS`, `DEV_AUTH=0|1`, `ODOO_*` defaults (optional).

## Authentication

- **Google sign-in from the desktop app** (OAuth 2.0 for installed apps, loopback redirect + PKCE):
  1. Client `GET /api/auth/google/config` → `{ clientId }` (server keeps the secret).
  2. Client opens the system browser at Google's authorize URL with `redirect_uri=http://127.0.0.1:<random port>/callback`,
     `code_challenge` (S256), `scope=openid email profile`, and listens on that port.
  3. Client posts `{ code, codeVerifier, redirectUri, device: { name, platform } }` to `POST /api/auth/google/exchange`.
     The server exchanges the code with Google (it holds the client secret), verifies the ID token (issuer, audience,
     `email_verified`, optional domain allowlist), upserts the user, registers the device and returns
     `{ deviceToken, user, device }`.
- **Device token**: opaque random 32 bytes, stored hashed (SHA-256) server-side; sent as `Authorization: Bearer …`.
  Revocable per device. The client stores it with safeStorage/DPAPI like the API keys.
- **Web dashboard**: `POST /api/auth/web-link` (device token) → `{ url }` with a one-time code valid 60 s; opening it sets
  an HttpOnly, SameSite=Strict session cookie (JWT, 12 h). The desktop app opens it with `shell.openExternal`.
- **Dev auth** (`DEV_AUTH=1` only, for tests): `POST /api/auth/dev` `{ email, deviceName }` → device token. Disabled in prod.
- First user whose email is in `BOOTSTRAP_ADMIN_EMAILS` becomes owner of a default workspace.

## Data model (PostgreSQL)

All synced rows carry `id uuid` (client-generated), `user_id`, `device_id`, `hlc text` (hybrid logical clock,
see below), `deleted boolean`, `server_seq bigint` (monotonic, assigned on write; drives pull cursors).

```
users(id, email unique, name, avatar_url, created_at)
devices(id, user_id, name, platform, token_hash, last_seen_at, revoked_at)
workspaces(id, name, created_at)
memberships(workspace_id, user_id, role: owner|admin|member|viewer)
invites(id, workspace_id, email, role, token_hash, expires_at, accepted_at)

projects(id uuid, workspace_id, name, color, description, rules jsonb, default_share: 'time'|'cards'|'detailed',
         odoo jsonb  -- { projectId, taskId, projectName, taskName }
         , archived, hlc, server_seq)
project_members(project_id, user_id, share_level: 'time'|'cards'|'detailed' | null = use project default)

-- personal synced records (the user's devices and dashboard; workspace admins get a cut-down view, see "Admin views")
cards(id, user_id, device_id, start_ts, end_ts, day, title, summary, detailed_summary, category, subcategory,
      metadata jsonb, is_error, hlc, field_hlc jsonb, deleted, server_seq)
card_projects(card_id, project_id, share real 0..1, source: 'manual'|'rule'|'llm', confidence real,
              confirmed boolean, hlc, server_seq)
observations(id, user_id, device_id, start_ts, end_ts, text, hlc, server_seq)
standups(id = user_id+day, user_id, day, payload jsonb, hlc, server_seq)
day_goals(id = user_id+day, user_id, day, payload jsonb, hlc, server_seq)
user_docs(user_id, kind: 'categories'|'project_rules_local'|…, payload jsonb, hlc, server_seq)

-- team-visible projection (derived on the server from cards + card_projects + share levels)
project_entries(card_id, project_id, user_id, start_ts, end_ts, minutes, title nullable, summary nullable,
                detailed nullable, share_level, updated_at)

timesheet_exports(id, project_id, user_id, day, minutes, odoo_line_id, status: 'pending'|'sent'|'failed',
                  error, card_ids uuid[], created_at, sent_at)
odoo_connections(workspace_id, url, db, login, api_key_encrypted, employee_map jsonb)
```

`server_seq` comes from one global sequence; every insert/update sets `server_seq = nextval(...)`.

## Sync protocol

Endpoints (device token):

- `POST /api/sync/push` body `{ changes: Change[] }` (≤ 1000 per request, ≤ 5 MB) →
  `{ accepted: number, rejected: { id, reason }[], serverTime }`.
- `GET /api/sync/pull?cursor=<server_seq>&limit=1000` → `{ changes: Change[], cursor, more: boolean }` — returns every
  record the user may see with `server_seq > cursor`, **including** their own records from other devices (and the
  echo of this device's own writes, which the client ignores by `device_id` + `hlc`).
- `GET /api/sync/stream` — Server-Sent Events; emits `event: changed` (no payload) when something the user can see
  changed. Client then pulls. Heartbeat every 25 s.

```ts
type Entity = 'card' | 'card_project' | 'observation' | 'standup' | 'day_goal' | 'user_doc' | 'project' | 'project_member'
interface Change {
  entity: Entity
  id: string            // uuid (or composite key string for standup/day_goal/user_doc)
  deviceId: string
  hlc: string           // "<unix ms, 13 digits>-<counter, 4 hex>-<deviceId>"
  deleted?: boolean
  data?: Record<string, unknown>   // full record for upserts (fields per entity in sync-types.ts)
  fieldHlc?: Record<string, string> // cards only: per-field HLC for user edits (title, category, subcategory)
}
```

**Conflict rules**
- HLC ordering = string compare (zero-padded). Last writer wins per record.
- Cards: the generating device owns analysis fields (times, summaries, metadata). User-editable fields
  (`title`, `category`, `subcategory`, `deleted`) merge **per field** using `fieldHlc`: a rename on one PC and a category
  change on another both survive.
- card_projects: LWW per (card_id, project_id).
- The server rejects changes whose `deviceId` is not the caller's device, or whose `user_id` is not the caller,
  or for entities the caller may not write (project/project_member need admin/owner of the workspace).
- Clock skew guard: the server rejects HLCs more than 5 min in the future; the client advances its HLC from
  `serverTime` and pulled HLCs.

**What the client pushes** (filtering happens on the client before upload):
- Its own cards (non-error), observations, standups, day goals, categories doc, card_projects.
- Nothing from excluded apps beyond what already ended up in cards. Never screenshots, accessibility logs, chat history.
- Personal records go to the server encrypted at rest (pg volume), readable by the owner's devices and the server
  (needed for the dashboard and team projection). E2E encryption is a later option.

### Admin views

Workspace admins and owners (`GET /api/workspaces/:id/report`, `/users`, `/members/:userId/timeline`) see:
- the team projection (`project_entries`), as every member does in project reports;
- a member's cards, lane per device, cut on the server: cards confirmed for projects of this workspace at the
  lowest share level among those projects (`time`: project names instead of the title, no text; `cards`: title,
  summary, category; `detailed`: plus detailed summary and distractions); every other card as a time-only
  "Out of scope" block. `appSites` and category descriptions are never returned;
- never private, deleted or error cards, and never work confirmed only for projects of other workspaces.

An admin may not open an owner's timeline or see an owner's own tracked time (owners see everyone). Every view
of someone else's timeline is stored in `timeline_views` (deduplicated per viewer, member and period for
10 minutes) and listed to the member by `GET /api/me/timeline-views` (dashboard Account page).

## Projects and assignment

- Projects belong to a workspace; members see the workspace's projects (synced as `project` entities).
- Assignment of a card to projects (client side, at card creation and on rule/edit changes):
  1. manual (`source='manual'`, `confirmed=true`);
  2. rules (`project.rules`: `{ apps?: string[], domains?: string[], titleKeywords?: string[], repos?: string[] }`,
     matched against `window_label`s of the card's screenshots, `appSites`, title/summary) → `source='rule'`, confirmed;
  3. LLM: the cards prompt gets the project list (name + description) and returns `"projects":[{"name","share","confidence"}]`
     per card → `source='llm'`; `confirmed = confidence ≥ 0.8`.
  Unconfirmed assignments show a "confirm project" chip in the timeline.
- Shares on one card sum to ≤ 1.

## Sharing levels (per project, overridable per member)

| level | team sees in `project_entries` |
|---|---|
| `time` | minutes + day only |
| `cards` | + title + summary |
| `detailed` | + detailed summary + distractions |

The server builds `project_entries` from **confirmed** card_projects only, honouring the member's level
(`project_members.share_level ?? project.default_share`). Users can additionally mark a card `private`
(`metadata.private=true`) → never projected.

## Team & dashboard API (session cookie or device token)

- `GET /api/me` → user, devices, workspaces + roles.
- `DELETE /api/devices/:id` revoke.
- `GET /api/workspaces/:id/projects`, `POST`/`PATCH`/`DELETE` (admin) — create/edit projects, rules, Odoo mapping,
  default share.
- `POST /api/workspaces/:id/invites` (admin) `{ email, role }` → invite link; `POST /api/invites/:token/accept`.
- `GET /api/me/timeline?from=YYYY-MM-DD&to=…` — the caller's own merged cards from all devices (device lanes).
- `GET /api/projects/:id/feed?from&to` — project_entries visible to the caller (members only).
- `GET /api/projects/:id/report?from&to` — totals per member/day/category.
- `GET /api/projects/:id/standup?day=` — per member: done/next from their standups restricted to cards of that project
  (only titles/summaries the share level allows).

## Odoo 15 timesheets

- Workspace admin configures `odoo_connections` (URL, db, login, API key — key encrypted with `JWT_SECRET`-derived key)
  and maps users → `hr.employee` ids, projects → `project.project`/`project.task`.
- User flow (dashboard "Timesheets" page and desktop): pick day range → server proposes lines = sum of confirmed
  card_project minutes per (user, day, project/task), rounded to 0.25 h, with a description built from card titles.
  User reviews/edits → `POST /api/timesheets/submit` → server creates `account.analytic.line`
  (`name`, `date`, `unit_amount` hours, `project_id`, `task_id`, `employee_id`, `user_id`) via XML-RPC
  (`/xmlrpc/2/object execute_kw`), stores `odoo_line_id`, never creates duplicates (idempotent per
  user+day+project+task: update the existing line instead).
- Never write to Odoo without the user's explicit submit. Testing uses a mock XML-RPC server or an oduflow dev
  environment — never production.

## Security notes

- Validate every input (zod schemas). Postgres access only via parameterised queries.
- Rate-limit auth endpoints. CORS: dashboard is same-origin; no wildcard.
- The server runs as non-root in the container; Postgres not published on the host.
- Logs never contain tokens, API keys or card text.
