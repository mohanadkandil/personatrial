CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0,
  last_chat_sequence bigint NOT NULL DEFAULT 0,
  profile jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner_id);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('active', 'ended')),
  end_reason text CHECK (end_reason IN ('disconnect', 'hangup', 'goodbye', 'cancel')),
  ended_sequence bigint,
  recovery_handled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_call ON calls(conversation_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_event_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('chat', 'voice')),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  text text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  final boolean NOT NULL,
  sequence bigint NOT NULL,
  received_sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  source_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  text text NOT NULL,
  rendered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, source_key),
  UNIQUE(conversation_id, sequence)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('gmail.search', 'demo.search')),
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  revision integer NOT NULL DEFAULT 1,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, idempotency_key),
  UNIQUE(evidence_id, kind)
);
CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS job_outbox (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name IN ('task.requested', 'call.recovery', 'input.final')),
  subject_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  UNIQUE(name, subject_id)
);
CREATE INDEX IF NOT EXISTS job_outbox_pending ON job_outbox(available_at) WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS evidence_conversation_sequence ON evidence(conversation_id, sequence DESC);
CREATE INDEX IF NOT EXISTS evidence_call_sequence ON evidence(call_id, sequence DESC);

CREATE TABLE IF NOT EXISTS turns (
  evidence_id uuid PRIMARY KEY REFERENCES evidence(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reply text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gmail_connections (
  owner_id uuid PRIMARY KEY,
  connection_id text NOT NULL UNIQUE,
  verified_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS received_sequence bigint;
UPDATE evidence SET received_sequence = sequence WHERE received_sequence IS NULL;
ALTER TABLE evidence ALTER COLUMN received_sequence SET NOT NULL;
