import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const destination = new URL("dist/", root);
await mkdir(destination, { recursive: true });
for (const name of [
  "index.html",
  "app.js",
  "styles.css",
  "icon.svg",
  "manifest.webmanifest",
]) {
  await copyFile(new URL(name, root), new URL(name, destination));
}
console.log(`Static frontend built in ${fileURLToPath(destination)}`);
