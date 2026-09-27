CREATE TABLE IF NOT EXISTS gmail_connect_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('creating', 'pending', 'completed', 'failed', 'cancelled')),
  connection_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  verification_token uuid,
  verification_until timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gmail_connect_attempts_owner_created
  ON gmail_connect_attempts(owner_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS gmail_connect_attempts_one_pending
  ON gmail_connect_attempts(owner_id) WHERE status IN ('creating', 'pending');

ALTER TABLE gmail_connect_attempts ENABLE ROW LEVEL SECURITY;
