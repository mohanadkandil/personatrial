ALTER TABLE messages ADD COLUMN channel text NOT NULL DEFAULT 'chat'
  CHECK (channel IN ('chat', 'voice'));

ALTER TABLE messages ADD COLUMN call_id uuid REFERENCES calls(id) ON DELETE SET NULL;

UPDATE messages AS message
SET channel = 'voice', call_id = evidence.call_id
FROM evidence
WHERE evidence.conversation_id = message.conversation_id
  AND evidence.channel = 'voice'
  AND message.source_key IN ('input:' || evidence.id::text, 'turn:' || evidence.id::text);

UPDATE messages AS message
SET channel = 'voice', call_id = evidence.call_id
FROM tasks JOIN evidence ON evidence.id = tasks.evidence_id
WHERE tasks.conversation_id = message.conversation_id
  AND evidence.channel = 'voice'
  AND message.source_key = 'accepted:' || tasks.id::text;

CREATE INDEX messages_chat_sequence ON messages(conversation_id, sequence)
  WHERE channel = 'chat';

CREATE INDEX messages_call_sequence ON messages(call_id, sequence);
