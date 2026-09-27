import { parseArgs } from "node:util";
import { createDatabase } from "../src/server/database";

async function main() {
  const { values } = parseArgs({
    options: { "connection-id": { type: "string" } },
  });
  const connectionId = values["connection-id"];

  if (!process.env.DATABASE_URL || !connectionId)
    throw new Error(
      "Set DATABASE_URL and provide --connection-id for a verified Gmail connection",
    );

  const db = createDatabase(process.env.DATABASE_URL);

  try {
    await db.begin(async (tx) => {
      const [connection] = await tx`
        SELECT connection_id FROM gmail_connections WHERE connection_id = ${connectionId}
      `;

      if (!connection)
        throw new Error(
          "Connect and verify this Gmail account on the website first",
        );

      await tx`
        INSERT INTO demo_mailbox (singleton, connection_id) VALUES (true, ${connectionId})
        ON CONFLICT (singleton) DO UPDATE SET connection_id = EXCLUDED.connection_id
      `;
    });

    console.log("Verified Gmail selected as the shared demo inbox.");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Demo setup failed");
  process.exitCode = 1;
});
