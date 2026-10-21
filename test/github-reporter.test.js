import test from "node:test";
import assert from "node:assert/strict";
import { failureAnnotation } from "../scripts/github-test-reporter.js";

test("CI failure annotations include the original error while escaping workflow-command delimiters", () => {
  const line = failureAnnotation(
    {
      name: "history, dates",
      file: "/workspace/oldgold/test/browser.e2e.js",
      line: 400,
      details: {
        error: {
          cause: {
            stack: "Timeout: history\n::add-mask::not-a-command\n100%\r",
          },
        },
      },
    },
    "/workspace/oldgold",
  );
  assert.match(
    line,
    /file=test\/browser.e2e.js,line=400,title=history%2C dates/,
  );
  assert.match(
    line,
    /Timeout: history%0A::add-mask::not-a-command%0A100%25%0D/,
  );
  assert.equal(line.split("\n").length, 2);
});
