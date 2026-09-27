ALTER TABLE conversations
  ADD COLUMN gmail_mode text NOT NULL DEFAULT 'default'
  CHECK (gmail_mode IN ('default', 'personal'));

CREATE TABLE demo_mailbox (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  connection_id text NOT NULL REFERENCES gmail_connections(connection_id) ON DELETE CASCADE
);

ALTER TABLE demo_mailbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE tasks ADD COLUMN gmail_connection_id text;

UPDATE tasks SET gmail_connection_id = gmail_connections.connection_id
FROM conversations JOIN gmail_connections ON gmail_connections.owner_id = conversations.owner_id
WHERE tasks.conversation_id = conversations.id AND tasks.kind = 'gmail.search';
