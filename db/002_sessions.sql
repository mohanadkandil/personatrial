CREATE TABLE IF NOT EXISTS browser_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_sessions_expiry ON browser_sessions(expires_at);

ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS http_rate_limits (
  owner_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('message', 'call')),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (owner_id, operation)
);

ALTER TABLE http_rate_limits ENABLE ROW LEVEL SECURITY;
