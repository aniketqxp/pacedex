import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, itemFor, pct, timeLeft, windowAt, lastWindowBefore } from "../src/notify.js";

const H = 36e5, D = 24 * H;
const fmt = { tz: "UTC", hour12: true };
// Thursday 19:00 UTC, inside the evening window.
const NOW = Date.UTC(2026, 10, 5, 19);
const svc = (used, resetIn, extra = {}) => ({
  linked: true, fetched_at: NOW - 5 * 6e4,
  weekly: { used_percent: used, resets_at: new Date(NOW + resetIn).toISOString() }, ...extra,
});

test("percentages round down, and nonsense reads as nothing", () => {
  assert.equal(pct(99.6), "99%");
  assert.equal(pct(0.4), "under 1%");
  assert.equal(pct(0), "0%");
  for (const bad of [-1, 101, NaN, "50", null]) assert.equal(pct(bad), null);
});

test("time left never overstates", () => {
  assert.equal(timeLeft(47.9 * H), "47 hours");
  assert.equal(timeLeft(2.9 * D), "2 days");
  assert.equal(timeLeft(10 * 6e4), "1 hour");
});

test("sends only in the morning and evening windows", () => {
  assert.equal(windowAt(Date.UTC(2026, 10, 5, 8, 30), "UTC"), "2026-11-05 am");
  assert.equal(windowAt(Date.UTC(2026, 10, 5, 12), "UTC"), null);
  assert.equal(windowAt(NOW, "UTC"), "2026-11-05 pm");
  // 19:00 UTC is 14:00 in Toronto: no window there.
  assert.equal(windowAt(NOW, "America/Toronto"), null);
});

test("running ahead: 80% used two days into the week", () => {
  const item = itemFor("claude", svc(80, 5 * D), NOW);
  assert.equal(item.type, "ahead");
  assert.ok(item.runOut < item.reset - D);
});

test("falling behind: 10% used with two days left", () => {
  assert.equal(itemFor("codex", svc(10, 2 * D), NOW).type, "behind");
});

test("on pace: nothing to say", () => {
  assert.equal(itemFor("claude", svc(50, 3.5 * D), NOW), null);
});

test("stale or expired sign-ins are problems, not pace", () => {
  assert.deepEqual(itemFor("claude", svc(80, 5 * D, { needs_relink: true }), NOW).kind, "relink");
  assert.equal(itemFor("claude", svc(80, 5 * D, { fetched_at: NOW - 7 * H }), NOW).kind, "stale");
});

test("an alert goes out once per week, then stays quiet", () => {
  const snapshot = { claude: svc(80, 5 * D), codex: { linked: false } };
  const first = decide({ snapshot, prefs: {}, state: {}, now: NOW, fmt });
  assert.equal(first.length, 1);
  assert.equal(first[0].payload.title, "Claude Code");
  assert.match(first[0].payload.body, /^80% used, on pace to run out/);
  const state = { claude: first[0].state };
  // Next evening, same week: nothing new.
  assert.deepEqual(decide({ snapshot: { ...snapshot, claude: svc(85, 5 * D, { fetched_at: NOW + D - 6e4 }) }, prefs: {}, state, now: NOW + D, fmt }), []);
});

test("switching a service off silences it", () => {
  const snapshot = { claude: svc(80, 5 * D) };
  assert.deepEqual(decide({ snapshot, prefs: { services: { claude: false } }, now: NOW, fmt }), []);
});

test("the weekly summary waits for the last window before the reset", () => {
  // Reset Friday 09:00 UTC: Thursday evening is the last window an hour before it.
  assert.equal(lastWindowBefore(Date.UTC(2026, 10, 6, 9), NOW, "UTC"), true);
  // Reset Saturday 09:00: Friday evening comes later, so not yet.
  assert.equal(lastWindowBefore(Date.UTC(2026, 10, 7, 9), NOW, "UTC"), false);
});
