// Generate NEW pairing material locally. Never reads Telegram/broker credentials.
import { access, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { resolve, join } from "node:path";
const directory = resolve(process.argv[2] || "mt5/private");
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const name of ["xtele.set", "XgoldExecutor.set", "server-config.json"]) {
  try {
    await access(join(directory, name));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(
    "Pairing files already exist. Use a new directory; existing keys were not changed.",
  );
}
const executionToken = randomBytes(32).toString("hex");
const settings =
  [
    "Enabled=false",
    "AllowRealAccount=false",
    "ExpectedAccountLogin=0",
    "BrokerSymbol=xauusd.s",
    `ExecutionToken=${executionToken}`,
    "VolumePerLeg=0.01",
    "MaxEntryDeviationUSD=1.0",
    "MaxSpreadUSD=0.60",
    "MaxSlippageUSD=0.20",
    "MaxOpenPairs=1",
    "Magic=67018001",
    "ResetUncertainExecutionHalt=false",
  ].join("\r\n") + "\r\n";
await writeFile(
  join(directory, "xtele.set"),
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(settings, "utf16le")]),
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  join(directory, "server-config.json"),
  JSON.stringify(
    {
      MT5_EXECUTION_FEED_ENABLED: "true",
      MT5_EXECUTION_TOKEN_HASH: createHash("sha256")
        .update(executionToken)
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "New private MT5 preset and server hash created. Token values were not printed.",
);
