import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("credentialed cloud workflows run only by manual dispatch on main", () => {
  for (const name of ["cloud-activate.yml", "cloud-readiness.yml"]) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /^on:\n  workflow_dispatch:\npermissions:/m, name);
    assert.match(workflow, /github\.repository == 'mweta66\/oldgold' &&/, name);
    assert.match(
      workflow,
      /github\.event_name == 'workflow_dispatch' &&\s+github\.ref == 'refs\/heads\/main'/,
      name,
    );
    assert.doesNotMatch(
      workflow,
      /feature\/cloud-readiness|pull_request|\bpush:/,
      name,
    );
  }
});
