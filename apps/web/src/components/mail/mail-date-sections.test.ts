import assert from "node:assert/strict";
import test from "node:test";

import { createMailDateSections } from "./mail-date-sections";
import type { MailThreadSummary } from "./types";

function thread(
  id: string,
  latestMessageAt: Date | string | null,
): MailThreadSummary {
  return {
    id,
    accountId: "00000000-0000-4000-8000-000000000001",
    accountEmail: "first@example.test",
    subject: id,
    snippet: "",
    participants: [],
    isUnread: false,
    isStarred: false,
    isDraft: false,
    invookLabel: null,
    latestMessageAt:
      latestMessageAt instanceof Date
        ? latestMessageAt.toISOString()
        : latestMessageAt,
    messageCount: 1,
  };
}

test("mail sections are chronological and omit the Today heading", () => {
  const now = new Date(2026, 7, 15, 12);
  const sections = createMailDateSections(
    [
      thread("older", new Date(2026, 7, 7, 23, 59)),
      thread("today-morning", new Date(2026, 7, 15, 8)),
      thread("last-week", new Date(2026, 7, 10, 16)),
      thread("yesterday", new Date(2026, 7, 14, 18)),
      thread("today-latest", new Date(2026, 7, 15, 11)),
      thread("seven-day-boundary", new Date(2026, 7, 8, 0)),
    ],
    now,
  );

  assert.deepEqual(
    sections.map(({ id, label, threads }) => ({
      id,
      label,
      threadIds: threads.map((entry) => entry.id),
    })),
    [
      {
        id: "today",
        label: null,
        threadIds: ["today-latest", "today-morning"],
      },
      { id: "yesterday", label: "Yesterday", threadIds: ["yesterday"] },
      {
        id: "last-seven-days",
        label: "Last 7 days",
        threadIds: ["last-week", "seven-day-boundary"],
      },
      { id: "older", label: "Older", threadIds: ["older"] },
    ],
  );
});

test("mail without a usable stored date remains honestly grouped as older", () => {
  const sections = createMailDateSections(
    [thread("missing", null), thread("invalid", "not-a-date")],
    new Date(2026, 7, 15, 12),
  );

  assert.deepEqual(
    sections.map(({ id, label, threads }) => ({
      id,
      label,
      threadIds: threads.map((entry) => entry.id),
    })),
    [
      {
        id: "older",
        label: "Older",
        threadIds: ["missing", "invalid"],
      },
    ],
  );
});
