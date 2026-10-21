import test from "node:test";
import assert from "node:assert/strict";
import {
  EGYPT_ZONE,
  validTimeZone,
  zonedParts,
  localInput,
  localInputToIso,
  localDayStart,
} from "../time-zones.js";
import {
  timeZoneCountries,
  validPreferences,
  displayPreferences,
} from "../lib/country-time-zones.js";
import { historyQuery } from "../lib/history.js";
import { fixture } from "./helpers.js";

test("country-zone pairs are validated and the administrator is always on Egypt time", () => {
  assert(timeZoneCountries.length > 150);
  assert(validPreferences({ country: "US", timeZone: "America/New_York" }));
  assert(!validPreferences({ country: "US", timeZone: "Asia/Tokyo" }));
  for (const bad of ["", "not/a-zone", "+03:00", {}, null])
    assert.equal(validTimeZone(bad), false);
  assert.deepEqual(
    displayPreferences("admin", {
      country: "US",
      timeZone: "America/New_York",
    }),
    { country: "EG", timeZone: EGYPT_ZONE, fixed: true },
  );
});
test("Egypt display respects winter/summer offsets and date rollover without changing instants", () => {
  assert.deepEqual(zonedParts(Date.parse("2026-01-15T23:30:45Z"), EGYPT_ZONE), {
    date: "2026-01-16",
    time: "01:30:45",
  });
  assert.deepEqual(zonedParts(Date.parse("2026-07-15T23:30:45Z"), EGYPT_ZONE), {
    date: "2026-07-16",
    time: "02:30:45",
  });
  assert.equal(
    localInput(Date.parse("2026-01-15T23:30:00Z"), "Asia/Kathmandu"),
    "2026-01-16T05:15",
  );
});
test("admin wall-clock input converts to UTC and rejects DST gaps, folds and invalid dates", () => {
  assert.equal(
    localInputToIso("2026-07-16T02:30", EGYPT_ZONE),
    "2026-07-15T23:30:00.000Z",
  );
  assert.equal(
    localInputToIso("2026-01-16T01:30", EGYPT_ZONE),
    "2026-01-15T23:30:00.000Z",
  );
  assert.throws(
    () => localInputToIso("2026-03-08T02:30", "America/New_York"),
    /غير موجود/,
  );
  assert.throws(
    () => localInputToIso("2026-11-01T01:30", "America/New_York"),
    /يتكرر/,
  );
  assert.throws(() => localInputToIso("2026-02-30T12:00", EGYPT_ZONE));
});
test("local-day history boundaries handle midnight DST, 23/25-hour days and fractional-hour zones", () => {
  for (const [day, next, hours] of [
    ["2026-04-24", "2026-04-25", 23],
    ["2026-10-29", "2026-10-30", 25],
  ]) {
    const q = historyQuery(
      new URLSearchParams({ from: day, to: day, timeZone: EGYPT_ZONE }),
    );
    assert.equal(q.from, localDayStart(day, EGYPT_ZONE));
    assert.equal(q.toExclusive, localDayStart(next, EGYPT_ZONE));
    assert.equal((q.toExclusive - q.from) / 3600000, hours);
  }
  assert.equal(
    new Date(localDayStart("2026-01-16", "Asia/Kathmandu")).toISOString(),
    "2026-01-15T18:15:00.000Z",
  );
  assert.throws(
    () => historyQuery(new URLSearchParams("timeZone=not-a-zone")),
    (e) => e.status === 400,
  );
});
test("account display preferences persist between sessions, remain isolated and do not change authority or quota", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login(),
    input = f.account("timezone@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  assert.equal((await f.request("/api/preferences")).status, 401);
  assert((await f.request("/api/time-zones")).body.countries.length > 150);
  assert.equal(
    (await f.request("/api/preferences", { auth: admin })).body.timeZone,
    EGYPT_ZONE,
  );
  const save = await f.request("/api/preferences", {
    method: "PATCH",
    auth: member,
    data: { country: "US", timeZone: "America/New_York", role: "admin" },
  });
  assert.equal(save.status, 200);
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.role,
    "member",
  );
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.used,
    0,
  );
  const again = await f.login(input.email, input.password);
  assert.equal(
    (await f.request("/api/preferences", { auth: again })).body.timeZone,
    "America/New_York",
  );
  for (const auth of [member, admin])
    assert.equal(
      (
        await f.request("/api/preferences", {
          method: "PATCH",
          auth,
          data: { country: "US", timeZone: "Asia/Tokyo" },
        })
      ).status,
      auth === admin ? 403 : 400,
    );
  assert.equal(
    (
      await f.request("/api/preferences", {
        method: "PATCH",
        auth: member,
        headers: { "x-csrf-token": "wrong" },
        data: { country: "JP", timeZone: "Asia/Tokyo" },
      })
    ).status,
    403,
  );
});
