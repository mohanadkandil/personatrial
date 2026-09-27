import type { Database, Transaction } from "../database";
import type { Scope } from "../conversation/types";

type Mailbox = { connectionId: string; source: "personal" | "demo" };

export async function resolveMailbox(
  sql: Database | Transaction,
  scope: Scope,
): Promise<Mailbox | null> {
  const [row] = await sql`
    SELECT own.connection_id AS personal_id,
      CASE WHEN c.gmail_mode = 'default'
        THEN demo.connection_id ELSE NULL END AS demo_id
    FROM conversations c
    LEFT JOIN gmail_connections own ON own.owner_id = c.owner_id
    LEFT JOIN demo_mailbox demo ON demo.singleton = true
    WHERE c.id = ${scope.conversationId} AND c.owner_id = ${scope.ownerId}
  `;

  if (row?.personal_id)
    return { connectionId: row.personal_id, source: "personal" };

  if (row?.demo_id) return { connectionId: row.demo_id, source: "demo" };

  return null;
}

export async function canUseTaskMailbox(
  sql: Database | Transaction,
  scope: Scope,
  taskId: string,
): Promise<boolean> {
  const mailbox = await resolveMailbox(sql, scope);
  if (!mailbox) return false;

  const [task] = await sql`
    SELECT gmail_connection_id FROM tasks
    WHERE id = ${taskId} AND conversation_id = ${scope.conversationId}
  `;

  return task?.gmail_connection_id === mailbox.connectionId;
}
