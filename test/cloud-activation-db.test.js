import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationBatch, vaultSetupSql } from "../scripts/cloud-activate.js";

test("fresh cloud activation applies all five real migrations atomically and keeps migration metadata private", async (t) => {
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
      "004_multiple_targets.sql",
      "005_gold_market.sql",
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
    { version: "004", length: 64 },
    { version: "005", length: 64 },
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

test("Vault setup SQL executes, is repeatable, preserves existing keys and refuses a changed origin", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // PGlite lacks the Supabase Vault extension. Model its SQL interface, while
  // running the real setup transaction/DO guards on PostgreSQL.
  await db.exec(`create schema vault;
create table vault.decrypted_secrets(id uuid primary key default gen_random_uuid(),name text,decrypted_secret text);
create function vault.create_secret(secret text,secret_name text) returns uuid language plpgsql as $$
declare created uuid; begin insert into vault.decrypted_secrets(name,decrypted_secret) values(secret_name,secret) returning id into created; return created; end; $$;`);
  await db.exec(
    vaultSetupSql("https://wetagold.example", "c".repeat(64), "w".repeat(64)),
  );
  await db.exec(
    vaultSetupSql(
      "https://wetagold.example",
      "different-unused-cron",
      "different-unused-webhook",
    ),
  );
  const values = (
    await db.query(
      "select name,decrypted_secret from vault.decrypted_secrets order by name",
    )
  ).rows;
  assert.equal(values.length, 3);
  assert.equal(
    values.find((v) => v.name === "wetagold_cron_secret").decrypted_secret,
    "c".repeat(64),
  );
  assert.equal(
    values.find((v) => v.name === "wetagold_webhook_secret").decrypted_secret,
    "w".repeat(64),
  );
  await assert.rejects(
    db.exec(vaultSetupSql("https://different.example", "new", "new")),
    /WG_ORIGIN_MISMATCH/,
  );
  await db.exec("rollback");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from vault.decrypted_secrets",
      )
    ).rows[0].count,
    3,
  );
});
