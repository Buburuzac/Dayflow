# Dayflow web dashboard

The browser dashboard for the Dayflow Sync Server. It is a Vite + React 19 + TypeScript app with no UI framework, and its charts are hand-written SVG. The Sync Server serves the built `dist/` at `/` on the same origin.

The contract is in `docs/sync-server-design.md`. Shared types are imported by relative path from `windows/src/shared/sync-types.ts`, which is the single source and must not be forked.

## Scripts

```sh
npm install
npm run dev      # http://localhost:5173, /api proxied to http://127.0.0.1:8790
npm run build    # type-check, then build into dist/
npm test         # vitest: date ranges, lane layout, rounding, timesheet payloads
```

### Mock mode (dev only)

Open `http://localhost:5173/?mock=1` to run every page against an in-browser fake API (`src/mock/mock.ts`). `?mock=nosession` shows the signed-out page. The mock is loaded only behind `import.meta.env.DEV`, so `vite build` leaves it out of `dist/`.

## Auth

The dashboard never handles Google OAuth. The desktop app calls `POST /api/auth/web-link` and opens the returned one-time URL. The server sets the HttpOnly session cookie and redirects to `/`. Every request uses `credentials: 'same-origin'`. Any 401 shows "Open the dashboard from the Dayflow app (Settings → Sync & team → Open web dashboard)".

Routing uses the URL hash (`#/projects/<id>/report`), so the server only has to serve `index.html` at `/`.

## Pages

| Route | Page |
|---|---|
| `#/` | My time: day/week lanes per device on a 4 AM to 4 AM axis, category and project totals, card details |
| `#/projects` | Workspace projects with this week's totals |
| `#/projects/:id/feed` · `/report` · `/standup` | Project feed (fields limited by share level), report (member bars, day bars, member × day heat grid), standup |
| `#/projects/:id/settings` | Name, colour, description, rules, default share, Odoo mapping, archive, members, roles, share overrides, invites (admin) |
| `#/timesheets` | Proposals as day × project lines with editable hours (0.25 h steps) and descriptions, a confirmation modal, and per-line results |
| `#/workspace` | Odoo connection (write-only API key), connection test, employee mapping, match by e-mail (admin) |
| `#/account` | Profile, devices with revoke, sign out |

## API surface used

These are the routes as implemented in `server/src/routes/*`. Response shapes are the shared types, or what the handlers return.

- `GET /api/me` returns `MeResponse`. `POST /api/auth/logout`. `DELETE /api/devices/:id`.
- `GET /api/me/timeline?from&to` returns `TimelineResponse`. An optional `categories` field (the user_doc `'categories'` payload) is used when present. Otherwise the default Work/Personal/Distraction/Idle colours apply.
- `GET /api/workspaces/:id/projects?includeArchived=1` returns `{ projects }`. Also `POST /api/workspaces/:id/projects` and `PATCH /api/workspaces/:id/projects/:projectId`; both return the project. Archiving is `PATCH { archived }`. Clearing the Odoo mapping is `odoo: null`.
- `GET /api/projects/:id/feed|report|standup` return `ProjectFeedResponse`, `ProjectReport` and `ProjectStandupResponse`.
- `GET /api/projects/:id/members` returns `{ members: { userId, shareLevel }[] }`. `PUT /api/projects/:id/members/:userId` takes `{ shareLevel | null }`.
- `GET /api/workspaces/:id/members`, `PATCH …/members/:userId { role }`, `DELETE …/members/:userId`.
- `GET|POST /api/workspaces/:id/invites` (POST returns `{ url, … }`) and `DELETE …/invites/:inviteId`. Only `status: 'pending'` invites are listed.
- `GET /api/timesheets/proposals?from&to&workspaceId` returns `{ odooConfigured, employeeMapped, proposals }`. `POST /api/timesheets/submit` takes `TimesheetSubmitRequest` and returns `TimesheetSubmitResult`.
- `GET|PUT /api/workspaces/:id/odoo`, `POST …/odoo/test`, `PUT …/odoo/employee-map { map }`, `POST …/odoo/auto-map`.

Errors are read as `{ error, message }`, and `message` is shown to the user.
