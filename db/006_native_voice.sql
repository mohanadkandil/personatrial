ALTER TABLE calls
  ADD COLUMN native_input_token text,
  ADD COLUMN native_input_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN native_input_sequence bigint,
  ADD COLUMN native_input_chat_sequence bigint,
  ADD COLUMN goodbye_requested boolean NOT NULL DEFAULT false;

CREATE TABLE voice_tool_calls (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, tool_call_id)
);

ALTER TABLE voice_tool_calls ENABLE ROW LEVEL SECURITY;
