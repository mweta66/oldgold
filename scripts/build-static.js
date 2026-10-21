import { mkdir, copyFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const destination = new URL("dist/", root);
await mkdir(destination, { recursive: true });
for (const name of [
  "index.html",
  "app.js",
  "time-zones.js",
  "trade-export.js",
  "styles.css",
  "icon.svg",
  "manifest.webmanifest",
]) {
  await copyFile(new URL(name, root), new URL(name, destination));
}
await cp(new URL("assets/", root), new URL("assets/", destination), {
  recursive: true,
});
console.log(`Static frontend built in ${fileURLToPath(destination)}`);
