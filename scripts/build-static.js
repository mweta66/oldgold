import { mkdir, copyFile, cp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const destination = new URL("dist/", root);
await mkdir(destination, { recursive: true });
for (const name of [
  "index.html",
  "app.js",
  "time-zones.js",
  "trade-export.js",
  "mt5-data.js",
  "mt5-chart.js",
  "styles.css",
  "icon.svg",
  "manifest.webmanifest",
]) {
  await copyFile(new URL(name, root), new URL(name, destination));
}
await cp(new URL("assets/", root), new URL("assets/", destination), {
  recursive: true,
});
await mkdir(new URL("vendor/", destination), { recursive: true });
await copyFile(
  new URL(
    "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs",
    root,
  ),
  new URL("vendor/lightweight-charts.mjs", destination),
);
await copyFile(
  new URL("node_modules/lightweight-charts/LICENSE", root),
  new URL("vendor/lightweight-charts-LICENSE.txt", destination),
);
await writeFile(
  new URL("vendor/lightweight-charts-NOTICE.txt", destination),
  "Lightweight Charts™ — Copyright TradingView, Inc.\nhttps://www.tradingview.com/\nLicensed under Apache License 2.0; see lightweight-charts-LICENSE.txt.\n",
);
console.log(`Static frontend built in ${fileURLToPath(destination)}`);
