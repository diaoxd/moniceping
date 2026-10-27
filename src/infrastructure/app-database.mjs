import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationsDirectory = join(root, "migrations", "app");

export function openAppDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  for (const version of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    if (applied.has(version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(join(migrationsDirectory, version), "utf8"));
      database.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return database;
}
