import { readdir, readFile } from "node:fs/promises";
import { createDatabase } from "../src/server/database";

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) throw new Error("Set DATABASE_URL before running migrations");

  const sql = createDatabase(url);

  try {
    const directory = new URL("../db/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();

    for (const file of files) {
      const migration = await readFile(new URL(file, directory), "utf8");

      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(719201)`;
        await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;

        const [applied] =
          await tx`SELECT name FROM schema_migrations WHERE name = ${file}`;

        if (applied) return;

        await tx.unsafe(migration);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
    }

    process.stdout.write("Database schema ready.\n");
  } finally {
    await sql.end();
  }
}

main().catch(() => {
  process.stderr.write(
    "Migration failed. Check the database connection and schema.\n",
  );
  process.exitCode = 1;
});
