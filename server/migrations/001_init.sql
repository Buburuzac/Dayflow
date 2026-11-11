-- Dayflow Sync Server schema. See docs/sync-server-design.md.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One global sequence drives every pull cursor.
CREATE SEQUENCE sync_seq;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text NOT NULL DEFAULT '',
  avatar_url  text,
  google_sub  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  platform     text NOT NULL DEFAULT '',
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE web_link_codes (
  code_hash  text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspaces_one_default ON workspaces(is_default) WHERE is_default;

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz
);
CREATE INDEX invites_workspace ON invites(workspace_id);

CREATE TABLE projects (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  color         text NOT NULL DEFAULT '',
  icon          text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  rules         jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_share text NOT NULL DEFAULT 'time' CHECK (default_share IN ('time','cards','detailed')),
  odoo          jsonb,
  archived      boolean NOT NULL DEFAULT false,
  deleted       boolean NOT NULL DEFAULT false,
  device_id     text NOT NULL DEFAULT 'server',
  hlc           text NOT NULL,
  server_seq    bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_seq ON projects(server_seq);
CREATE INDEX projects_workspace ON projects(workspace_id);

CREATE TABLE project_members (
  id          text NOT NULL UNIQUE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_level text CHECK (share_level IN ('time','cards','detailed')),
  deleted     boolean NOT NULL DEFAULT false,
  device_id   text NOT NULL DEFAULT 'server',
  hlc         text NOT NULL,
  server_seq  bigint NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_seq ON project_members(server_seq);

CREATE TABLE cards (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- generating device: owns the analysis fields
  device_id        uuid NOT NULL,
  start_ts         bigint NOT NULL DEFAULT 0,
  end_ts           bigint NOT NULL DEFAULT 0,
  day              text NOT NULL DEFAULT '',
  title            text NOT NULL DEFAULT '',
  summary          text NOT NULL DEFAULT '',
  detailed_summary text NOT NULL DEFAULT '',
  category         text NOT NULL DEFAULT '',
  subcategory      text NOT NULL DEFAULT '',
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_error         boolean NOT NULL DEFAULT false,
  private          boolean NOT NULL DEFAULT false,
  deleted          boolean NOT NULL DEFAULT false,
  -- hlc = max over every applied clock; analysis_hlc = generating device's last analysis write
  hlc              text NOT NULL,
  analysis_hlc     text NOT NULL,
  field_hlc        jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_device_id   uuid NOT NULL,
  server_seq       bigint NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cards_user_seq ON cards(user_id, server_seq);
CREATE INDEX cards_user_day ON cards(user_id, day);

CREATE TABLE card_projects (
  id         text NOT NULL UNIQUE,
  card_id    uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL,
  share      real NOT NULL DEFAULT 1,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','rule','llm')),
  confidence real NOT NULL DEFAULT 1,
  confirmed  boolean NOT NULL DEFAULT false,
  deleted    boolean NOT NULL DEFAULT false,
  hlc        text NOT NULL,
  server_seq bigint NOT NULL,
  PRIMARY KEY (card_id, project_id)
);
CREATE INDEX card_projects_user_seq ON card_projects(user_id, server_seq);
CREATE INDEX card_projects_project ON card_projects(project_id);

CREATE TABLE observations (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL,
  start_ts   bigint NOT NULL DEFAULT 0,
  end_ts     bigint NOT NULL DEFAULT 0,
  text       text NOT NULL DEFAULT '',
  deleted    boolean NOT NULL DEFAULT false,
  hlc        text NOT NULL,
  server_seq bigint NOT NULL
);
CREATE INDEX observations_user_seq ON observations(user_id, server_seq);

CREATE TABLE standups (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL,
  day        text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted    boolean NOT NULL DEFAULT false,
  hlc        text NOT NULL,
  server_seq bigint NOT NULL
);
CREATE INDEX standups_user_seq ON standups(user_id, server_seq);
CREATE INDEX standups_user_day ON standups(user_id, day);

CREATE TABLE day_goals (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL,
  day        text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted    boolean NOT NULL DEFAULT false,
  hlc        text NOT NULL,
  server_seq bigint NOT NULL
);
CREATE INDEX day_goals_user_seq ON day_goals(user_id, server_seq);

CREATE TABLE user_docs (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL,
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted    boolean NOT NULL DEFAULT false,
  hlc        text NOT NULL,
  server_seq bigint NOT NULL
);
CREATE INDEX user_docs_user_seq ON user_docs(user_id, server_seq);

-- Team-visible projection, derived from cards + card_projects + share levels.
CREATE TABLE project_entries (
  card_id      uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          text NOT NULL,
  start_ts     bigint NOT NULL,
  end_ts       bigint NOT NULL,
  minutes      real NOT NULL,
  title        text,
  summary      text,
  category     text,
  detailed     text,
  distractions jsonb,
  share_level  text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, project_id)
);
CREATE INDEX project_entries_project_day ON project_entries(project_id, day);
CREATE INDEX project_entries_user ON project_entries(user_id);

CREATE TABLE odoo_connections (
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  url               text NOT NULL,
  db                text NOT NULL,
  login             text NOT NULL,
  api_key_encrypted text NOT NULL,
  employee_map      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE timesheet_exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day             text NOT NULL,
  odoo_project_id integer,
  odoo_task_id    integer,
  -- coalesce(odoo_task_id, 0): idempotency key is user + day + project + task
  task_key        integer NOT NULL DEFAULT 0,
  minutes         real NOT NULL DEFAULT 0,
  hours           real NOT NULL DEFAULT 0,
  description     text NOT NULL DEFAULT '',
  odoo_line_id    integer,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error           text,
  card_ids        uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (user_id, day, project_id, task_key)
);
