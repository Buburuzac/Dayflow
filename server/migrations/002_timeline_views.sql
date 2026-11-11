-- Who opened whose timeline (admin view of a member's timeline). Shown to the member on their Account page.
CREATE TABLE timeline_views (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  viewer_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  range_from   text NOT NULL,
  range_to     text NOT NULL,
  viewed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timeline_views_user ON timeline_views(user_id, viewed_at DESC);
