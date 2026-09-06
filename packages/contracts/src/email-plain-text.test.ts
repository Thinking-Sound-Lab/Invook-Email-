import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailPlainText } from "./email-plain-text";

test("stored email HTML projects to readable text without active or hidden content", () => {
  const text = buildEmailPlainText(
    '<head><title>Hidden title</title><style>body {color:red}</style></head><p>Hello &amp; welcome</p><div>First<br>Second</div><script>unsafe()</script><img src="https://example.com/tracker">',
  );
  assert.match(text, /Hello & welcome\n\nFirst\nSecond$/);
  assert.doesNotMatch(text, /Hidden title|color:red|unsafe|tracker|<p>/);
});

test("block boundaries become line breaks rather than running together", () => {
  assert.equal(
    buildEmailPlainText("<p>First</p><p>Second</p><li>Third</li>"),
    "First\n\nSecond\n\nThird",
  );
});
