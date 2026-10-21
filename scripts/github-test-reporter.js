import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

const escaped = (value) =>
  stripVTControlCharacters(String(value))
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
const property = (value) =>
  escaped(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

export function failureAnnotation(data, workspace = process.cwd()) {
  const error = data.details?.error?.cause || data.details?.error;
  const file = data.file
    ? `file=${property(relative(workspace, data.file))},`
    : "";
  const line = Number.isInteger(data.line) ? `line=${data.line},` : "";
  return `::error ${file}${line}title=${property(data.name)}::${escaped(error?.stack || error?.message || "Browser test failed")}\n`;
}

export default async function* githubReporter(events) {
  for await (const event of events) {
    if (process.env.GITHUB_ACTIONS === "true" && event.type === "test:fail")
      yield failureAnnotation(
        event.data,
        process.env.GITHUB_WORKSPACE || process.cwd(),
      );
  }
}
