import { readdir, readFile } from "node:fs/promises";
import type postgres from "postgres";

export async function migrateTestDatabase(db: postgres.Sql) {
  const directory = new URL("../../db/", import.meta.url);
  const files = (await readdir(directory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  for (const file of files) {
    await db.unsafe(await readFile(new URL(file, directory), "utf8"));
  }
}
