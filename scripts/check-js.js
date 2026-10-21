import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
async function javascript(directory, recursive) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    else if (entry.isDirectory() && recursive)
      files.push(...(await javascript(path, true)));
  }
  return files;
}
const files = await javascript(root, false);
for (const directory of ["api", "lib", "scripts", "test"])
  files.push(...(await javascript(join(root, directory), true)));
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} first-party JavaScript files.`);
