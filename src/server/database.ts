import postgres from "postgres";

export type Database = ReturnType<typeof postgres>;
export type Transaction = postgres.TransactionSql;

export function createDatabase(url: string): Database {
  return postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
}

let database: Database | undefined;
export function getDatabase(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return (database ??= createDatabase(url));
}
