# Dayflow Sync Server

Relays Dayflow results between a user's computers, builds the team view of shared projects, and turns
confirmed project time into Odoo 15 timesheets. The contract is [`docs/sync-server-design.md`](../docs/sync-server-design.md);
types shared with the desktop app and the dashboard live in
[`windows/src/shared/sync-types.ts`](../windows/src/shared/sync-types.ts). The server imports that file by relative path
and esbuild bundles it into `dist/index.js`.

## Architecture

```
desktop app ──(device token)──► /api/sync/push|pull|stream ─┐
dashboard   ──(session cookie)► /api/me, projects, feed …   ├─ Fastify (Node 24) ── PostgreSQL 17
                                /api/timesheets/* ──────────┘          │
                                         └── XML-RPC ──► Odoo 15 (account.analytic.line)
```

| Path | Purpose |
|---|---|
| `src/index.ts` | entry: config, migrations (with retry), listen |
| `src/app.ts` | Fastify setup: logging with redaction, rate limits, security headers, errors, static dashboard |
| `src/config.ts` | environment parsing (zod) |
| `src/db.ts` | pg pool, transactions, `withSeqTx` (serialised `server_seq` writers), SQL migration runner |
| `src/crypto.ts` | random tokens, SHA-256, AES-256-GCM box for the Odoo API key (HKDF from `JWT_SECRET`) |
| `src/access.ts` | workspace roles, membership changes |
| `src/auth/google.ts` | Google code exchange (PKCE) and ID-token verification against Google's JWKS (`jose`) |
| `src/auth/auth.ts` | sign-in, bootstrap admin, device tokens, web session JWT, request authentication |
| `src/sync/engine.ts` | push (validation, HLC guard, merge rules, ownership) and pull (cursor pages) |
| `src/sync/projection.ts` | `project_entries` projection honouring share levels |
| `src/sync/hub.ts`, `notify.ts` | in-process SSE fan-out |
| `src/odoo/xmlrpc.ts`, `client.ts` | hand-rolled XML-RPC codec and Odoo client (`common.version`, `authenticate`, `execute_kw`) |
| `src/odoo/timesheets.ts` | proposals (0.25 h rounding) and idempotent submit |
| `src/routes/*.ts` | HTTP endpoints |
| `migrations/*.sql` | plain SQL, applied in order at start-up (`schema_migrations`) |
| `test/*.test.ts` | `node:test` suite against a real Postgres, mock Google and mock Odoo |
| `test/e2e/run.ts` | end-to-end script used by `deploy.sh e2e` |

### Sync rules (summary)

- Every synced row has `hlc` and `server_seq` (one global sequence). Writers take a transaction advisory lock, so
  sequence values commit in order and a pull cursor never skips a row.
- Push rejects, per change: `foreign_device` (deviceId is not the caller's device), `hlc_device_mismatch`,
  `invalid_hlc`, `hlc_in_future` (more than 5 min ahead, record or field clock), `not_owner`/`user_mismatch`,
  `forbidden` (project/project_member need admin; a member may set their own share level), `forbidden_project`
  (card assigned to a project of a workspace the caller is not a member of), `invalid_data`, `missing_data`.
  Limits: 1000 changes and 5 MB per request; pull pages of up to 1000.
- Cards: the generating device (first writer, or `data.originDeviceId` when it is one of the user's devices) owns
  the analysis fields (times, summaries, metadata, isError) with record-level LWW. User fields `title`, `category`,
  `subcategory`, `deleted` and `private` (= `metadata.private`) merge per field: an explicit `fieldHlc[f]` is a user
  edit and beats analysis output; among user edits the later clock wins. Analysis output without a field clock only
  sets a field that has never been edited. A non-generating device that sends no `fieldHlc` at all has every changed
  user field treated as an edit at the change's `hlc`.
- Other entities: LWW per record (card_projects per `(card_id, project_id)`).
- Pull returns everything the user may see past the cursor: own personal records from all devices (including the
  echo of this device), projects and project members of the user's workspaces. Joining a workspace re-stamps its
  projects so the new member's devices receive them.
- `/api/sync/stream` (SSE) sends `changed` on connect and whenever the user can pull something new, `feed`
  (`{ projectIds }`) when a team feed changed, and `ping` every 25 s. A revoked device's stream closes at the next ping.

### Projection

`project_entries` is rebuilt on card, card_project, project (default share, delete), project member and membership
changes. Only confirmed assignments of non-deleted, non-error, non-private cards of workspace members are projected.
Level = `project_members.share_level ?? projects.default_share`: `time` (minutes, day), `cards` (+ title, summary,
category), `detailed` (+ detailed summary, distractions). Minutes = duration × share; if a card's confirmed shares sum
above 1 they are scaled down.

## API

Auth column: **device** = `Authorization: Bearer <device token>` only; **any** = device token or session cookie;
admin = workspace role admin or owner. Requests carrying the cookie and an `Origin` that is neither the request host
nor `PUBLIC_URL` are refused for non-GET methods.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/health` | none | `{ ok, version, time, devAuth, googleConfigured }` |
| `GET /api/auth/google/config` | none | `{ clientId, webClientId, devAuth }` |
| `POST /api/auth/google/web` | none, rate-limited | Google Identity Services `{ credential }` → Dashboard session cookie |
| `POST /api/auth/google/exchange` | none, rate-limited | `{ code, codeVerifier, redirectUri (loopback), device }` → `AuthResponse` |
| `POST /api/auth/dev` | none, `DEV_AUTH=1` only (else 404) | `{ email, deviceName, platform?, deviceId? }` → `AuthResponse` |
| `POST /api/auth/web-link` | device, rate-limited | `{ url, expiresAt }`, one-time code valid 60 s |
| `GET /api/auth/web-link/:code` | none (the code) | sets `df_session` (HttpOnly, SameSite=Strict, 12 h), 302 → `/` |
| `POST /api/auth/logout` | none | clears the cookie |
| `GET /api/me` | any | user, devices, workspaces + roles |
| `DELETE /api/devices/:id` | any (own devices) | revoke; also ends web sessions created from that device |
| `GET/POST /api/workspaces` | any | list / create (creator becomes owner) |
| `GET /api/workspaces/:id`, `GET …/members` | member | |
| `PATCH /api/workspaces/:id` | admin | rename |
| `PATCH /api/workspaces/:id/members/:userId` | admin (owner for owner changes) | `{ role }` |
| `DELETE /api/workspaces/:id/members/:userId` | admin, or self (leave) | keeps at least one owner |
| `POST /api/workspaces/:id/invites` | admin | `{ email, role }` → `{ token, url, expiresAt }` (7 days) |
| `GET /api/workspaces/:id/invites`, `DELETE …/invites/:inviteId` | admin | |
| `GET /api/invites/:token`, `POST /api/invites/:token/accept` | any; email must match | |
| `GET /api/workspaces/:id/projects[?includeArchived=1]` | member (incl. viewer) | |
| `POST /api/workspaces/:id/projects` | admin | `{ id?, name, color, icon?, description, rules, defaultShare, odoo, archived }` |
| `PATCH/DELETE /api/workspaces/:id/projects/:projectId` (alias `/api/projects/:id`) | admin | delete = tombstone |
| `GET /api/projects/:id` | member | |
| `GET /api/projects/:id/members` | member | share levels |
| `PUT /api/projects/:id/members/:userId` | admin, or self | `{ shareLevel: 'time'|'cards'|'detailed'|null }` |
| `POST /api/sync/push` | device | `PushRequest` → `PushResponse` |
| `GET /api/sync/pull?cursor&limit` | device | `PullResponse` |
| `GET /api/sync/stream` | any | SSE |
| `GET /api/me/timeline?from&to` | any | `TimelineResponse` (own cards, device lanes, projects, categories doc) |
| `GET /api/projects/:id/feed?from&to` | member | `ProjectFeedResponse` |
| `GET /api/projects/:id/report?from&to` | member | `ProjectReport` (+ `byCategory`) |
| `GET /api/projects/:id/standup?day=` | member | `ProjectStandupResponse` |
| `GET /api/workspaces/:id/report?from&to` | admin | `WorkspaceReport`: every member (also without time) with total, active days, projects, hours sent to Odoo, last device sync; projects; person × project and person × day minutes. Same projection as project reports |
| `GET /api/workspaces/:id/users?from&to` | admin | `WorkspaceUsersResponse`: every member with devices (revoked ones only with time in range), tracked minutes per device (synced cards minus private/deleted/error and work confirmed only for other workspaces), project minutes, active days. Owners shown to an admin are `restricted` (no own time) |
| `GET /api/workspaces/:id/members/:userId/timeline?from&to` | admin | `MemberTimelineResponse`: the member's cards from all devices, lane per device. Private/deleted/error cards left out; content cut to the lowest share level among the card's confirmed projects in this workspace (`shareLevel`), other cards as time-only "Out of scope"; never `appSites`; no work confirmed only for other workspaces. 403 for an admin opening an owner. Views of someone else's timeline are logged |
| `GET /api/me/timeline-views` | any | who opened the caller's timeline (latest 100) |
| `GET /api/timesheets/proposals?from&to&workspaceId` | any (member) | `{ odooConfigured, employeeMapped, proposals: TimesheetProposal[] }` |
| `POST /api/timesheets/submit` | any (member, not viewer) | `TimesheetSubmitRequest` → `TimesheetSubmitResult` |
| `GET /api/timesheets/exports?from&to[&workspaceId]` | any | the caller's export history |
| `GET/PUT/DELETE /api/workspaces/:id/odoo` | admin | `{ url, db, login, apiKey? }`; the key is never returned |
| `POST /api/workspaces/:id/odoo/test` | admin | `common.version` + `authenticate` → `{ ok, serverVersion, uid | error }` |
| `PUT /api/workspaces/:id/odoo/employee-map` | admin | `{ map: { [userId]: { employeeId, odooUserId? } } }` |
| `PATCH /api/workspaces/:id/odoo/employee-map/:userId` | admin | entry or `null` |
| `POST /api/workspaces/:id/odoo/auto-map` | admin | match members by `hr.employee.work_email` / `res.users.login` (read-only in Odoo) |
| `GET /api/workspaces/:id/odoo/employees|projects|tasks?search&projectId` | admin | pickers for the mapping UI |

Ranges are inclusive `YYYY-MM-DD`, at most 93 days. Errors: `{ error, message, details? }`.

### Timesheets

Proposals sum confirmed card_project minutes per (user, day, project) and round to 0.25 h; the description joins
card titles (private cards add minutes but never their titles). Submit maps each line to
`account.analytic.line { name, date, unit_amount, project_id, task_id, employee_id, user_id }`. The key
user + day + project + Odoo task is stored in `timesheet_exports`; a repeat submit `write`s the stored line (or
creates a new one if it was deleted in Odoo). Nothing is written to Odoo except on `POST /api/timesheets/submit`.

## Configuration (`/srv/dayflow/.env`, mode 600)

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `postgres://dayflow:<pw>@dayflow-postgres:5432/dayflow` |
| `POSTGRES_PASSWORD` | used by the postgres container (same password as in `DATABASE_URL`) |
| `PUBLIC_URL` | external base URL, used in web-link and invite URLs (`http://192.168.0.90:8790`) |
| `JWT_SECRET` | ≥ 32 chars; signs session cookies and derives the Odoo-key encryption key. Changing it logs out web sessions and makes stored Odoo keys unreadable (re-enter them) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client of type **Desktop app** (below) |
| `GOOGLE_WEB_CLIENT_ID` | OAuth client of type **Web application** for direct Dashboard sign-in; register the origin of `PUBLIC_URL` under Authorized JavaScript origins |
| `ALLOWED_EMAIL_DOMAINS` | optional comma list of domains and/or exact addresses, e.g. `velesagro.pl,someone@gmail.com`; empty = any verified Google account may sign in (it sees nothing until invited). Addresses in `BOOTSTRAP_ADMIN_EMAILS` are always allowed |
| `BOOTSTRAP_ADMIN_EMAILS` | comma list; these users become owners of the default workspace on sign-in |
| `DEV_AUTH` | `1` enables `/api/auth/dev` (tests only). `deploy.sh` refuses to deploy with `DEV_AUTH=1` |
| `ODOO_URL`, `ODOO_DB`, `ODOO_LOGIN`, `ODOO_API_KEY` | optional defaults used by workspaces without their own connection |
| `LOG_LEVEL` | `info` |
| `AUTH_RATE_LIMIT` | requests/min/IP on sign-in, web-link and invite endpoints (default 20) |
| `TRUST_PROXY` | `1` only behind a reverse proxy (for client IPs in rate limiting) |
| `DAYFLOW_ENV_FILE`, `DAYFLOW_BIND`, `DAYFLOW_PORT`, `DAYFLOW_IMAGE` | compose wiring |

## Deploy, update, operate

Host `megaserv` (192.168.0.90), compose project `dayflow`, directory `/srv/dayflow`
(`.env`, `src/` = uploaded source, `backups/`), volume `dayflow_pg`, port 8790. Postgres is not published.

```bash
server/deploy.sh            # first deploy and every update: upload, create .env once, build on the host, up -d, health check
server/deploy.sh test       # npm test in a throwaway container + throwaway Postgres (project dayflow-e2e, removed afterwards)
server/deploy.sh e2e        # temporary DEV_AUTH=1 stack on 127.0.0.1:18790 + e2e script + mock Odoo, then down -v
server/deploy.sh status     # compose ps + /api/health
server/deploy.sh logs
server/deploy.sh backup     # pg_dump -Fc into /srv/dayflow/backups (mode 600)
```

Manual equivalents on the host:

```bash
cd /srv/dayflow/src/server
DC="sudo docker compose -p dayflow --env-file /srv/dayflow/.env -f docker-compose.yml"
$DC up -d --build                      # update after uploading new source
$DC restart dayflow-server             # e.g. after editing .env
$DC logs -f dayflow-server
# backup / restore
$DC exec -T dayflow-postgres pg_dump -U dayflow -d dayflow -Fc > /srv/dayflow/backups/dayflow-$(date +%F).dump
$DC exec -T dayflow-postgres pg_restore -U dayflow -d dayflow --clean --if-exists < /srv/dayflow/backups/dayflow-YYYY-MM-DD.dump
```

The image builds the dashboard from `server/web` when `server/web/package.json` exists and serves it at `/`
(SPA fallback for non-API paths). If the dashboard build fails the image still builds without it (warning in the
build log); pass `--build-arg WEB_BUILD_STRICT=1` to make that fatal.

Local development: `npm ci`, `npm run typecheck`, `npm run build`; `npm test` needs `TEST_DATABASE_URL`
(a Postgres superuser URL; each test file creates and drops its own database).

## Google sign-in: create the OAuth Desktop client

1. Google Cloud Console → select or create a project.
2. **APIs & Services → OAuth consent screen**: user type *Internal* if all users are in the velesagro.pl Google
   Workspace (otherwise *External* and add test users), app name "Dayflow", support e-mail, scopes `openid`,
   `email`, `profile`. Save.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: Desktop app**,
   name "Dayflow desktop". Create, then copy the client ID and client secret.
4. On megaserv put them into `/srv/dayflow/.env`:
   `GOOGLE_CLIENT_ID=…apps.googleusercontent.com` and `GOOGLE_CLIENT_SECRET=…`
   (optionally `ALLOWED_EMAIL_DOMAINS=velesagro.pl`).
   For direct browser sign-in, create a second OAuth client of type **Web application**, add the exact origin of `PUBLIC_URL` to its Authorized JavaScript origins, and set `GOOGLE_WEB_CLIENT_ID` to that client's ID. The Dashboard verifies this token on the server and uses an HttpOnly session cookie.
5. Restart: `server/deploy.sh` (or `$DC up -d` on the host). `GET /api/health` then shows `"googleConfigured": true`.

Desktop clients use a loopback redirect (`http://127.0.0.1:<port>/callback`) with PKCE; Desktop-app clients allow
any loopback port, so nothing else needs registering. The first sign-in of `claude@velesagro.pl` creates the default
workspace with that user as owner.

## Security notes

- Device tokens are 32 random bytes, stored as SHA-256; revocable per device. Revoking a device also invalidates web
  sessions started from it and closes its SSE stream at the next heartbeat.
- Web sessions: one-time 60 s code → HS256 JWT in an HttpOnly, SameSite=Strict cookie (`Secure` when `PUBLIC_URL` is
  https), 12 h. Cookie-authenticated writes require a matching `Origin`. Sync push/pull and web-link creation require a
  device token. No CORS headers are sent (same-origin dashboard only).
- Google ID tokens are verified against Google's JWKS: issuer, audience = our client ID, expiry, `email_verified`, and
  the optional domain allowlist (`hd` and the e-mail domain). The client secret never leaves the server.
- All input is validated with zod; all SQL is parameterised. Push enforces device and user ownership, workspace roles
  and a 5-minute future-clock guard.
- The Odoo API key is encrypted at rest (AES-256-GCM, key derived from `JWT_SECRET` with HKDF) and never returned by the
  API. Odoo is only written on an explicit timesheet submit. Odoo URLs are set by workspace admins (trusted).
- Logs: no request bodies; `Authorization`/`Cookie` headers are redacted, one-time codes and invite tokens are redacted
  from URLs, and sync errors log only the entity and SQLSTATE.
- Personal records (cards, observations, standups) are readable by the server (needed for the dashboard and
  projection); they are protected by the host and the Postgres volume, not end-to-end encrypted.
- Rate limits on sign-in, web-link, invite and Odoo test endpoints. Security headers: `nosniff`, `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`.
- Container: non-root `node` user, read-only root filesystem, `no-new-privileges`, all capabilities dropped. Postgres
  is reachable only on the compose network. HTTP is plain on the LAN; put TLS in front before any Internet exposure
  and then set `PUBLIC_URL=https://…` (enables `Secure` cookies) and `TRUST_PROXY=1`.
