import assert from "node:assert/strict";
import test from "node:test";

import { toPostgresTextProjection } from "@invook/database";

test("PostgreSQL text projections preserve visible content around NUL bytes", () => {
  assert.equal(
    toPostgresTextProjection("before\u0000after"),
    "before\uFFFDafter",
  );
  assert.equal(toPostgresTextProjection("unchanged"), "unchanged");
});
