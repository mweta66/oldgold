import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationBatch } from "../scripts/cloud-activate.js";

test("fresh cloud activation applies all three real migrations atomically and keeps migration metadata private", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;",
  );
  const files = await Promise.all(
    [
      "001_wetagold.sql",
      "002_trade_history.sql",
      "003_telegram_events.sql",
    ].map(async (file) => ({
      version: file.slice(0, 3),
      sql: await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    })),
  );
  await db.exec(migrationBatch(files));
  const rows = (
    await db.query(
      "select version,length(checksum) as length from wg_deployment_migrations order by version",
    )
  ).rows;
  assert.deepEqual(rows, [
    { version: "001", length: 64 },
    { version: "002", length: 64 },
    { version: "003", length: 64 },
  ]);
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select * from wg_deployment_migrations"),
    /permission denied/,
  );
  await db.exec("reset role");
  assert.equal(
    (await db.query("select count(*)::int as count from wg_signals")).rows[0]
      .count,
    0,
  );
});
