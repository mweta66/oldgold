import { backup, DatabaseSync } from "node:sqlite";
import { mkdir, access, chmod, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createBackups(db, directory, { now = Date.now } = {}) {
  let running;
  let timer;
  let stopped = false;
  const status = { lastBackupAt: null, error: null };
  const run = () => {
    if (running) return running;
    if (stopped) return Promise.resolve();
    running = (async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const destination = join(
          directory,
          `wetagold-${new Date(now()).toISOString().slice(0, 10)}.sqlite`,
        );
        let exists = false;
        try {
          await access(destination);
          exists = true;
        } catch {
          /* Create today's backup below. */
        }
        if (!exists) {
          const temporary = `${destination}.${randomUUID()}.tmp`;
          try {
            await backup(db, temporary);
            const snapshot = new DatabaseSync(temporary);
            try {
              snapshot.exec("PRAGMA journal_mode=DELETE");
            } finally {
              snapshot.close();
            }
            await chmod(temporary, 0o600);
            await rename(temporary, destination);
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        status.lastBackupAt = now();
        status.error = null;
      } catch {
        status.error =
          "تعذر حفظ النسخة الاحتياطية. تحقق من مساحة القرص وصلاحيات التخزين.";
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return {
    status,
    run,
    async start() {
      await run();
      timer = setInterval(run, 3600000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
