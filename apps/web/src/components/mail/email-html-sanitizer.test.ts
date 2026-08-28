import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailHtmlContent, buildEmailPlainText } from "./email-html-sanitizer";

test("HTML-only forwarded mail retains readable paragraphs without active content", () => {
  const text = buildEmailPlainText('<head><title>Hidden title</title><style>body {color:red}</style></head><p>Hello &amp; welcome</p><div>First<br>Second</div><script>unsafe()</script><img src="https://example.com/tracker">');
  assert.equal(text, "Hello & welcome\n\nFirst\nSecond");
  assert.doesNotMatch(text, /unsafe|Hidden|color|tracker|<script/);
});

test("email HTML preserves sender presentation while removing active content", () => {
  const content = buildEmailHtmlContent(`
    <html>
      <head>
        <title>Duplicated subject</title>
        <style>.headline { color: red; background: #ffffff; }</style>
      </head>
      <body>
        <table><tr><td class="headline" style="font-weight: bold">Hello</td></tr></table>
        <a href="https://example.com/path">Read more</a>
        <script>alert("unsafe")</script>
        <form action="https://example.com/collect"><input name="secret"></form>
        <iframe src="https://example.com/embed"></iframe>
        <img src="https://example.com/banner.jpg" onerror="alert('unsafe')">
      </body>
    </html>
  `);

  assert.match(
    content,
    /<style>\.headline \{ color: red; background: #ffffff; \}<\/style>/,
  );
  assert.match(
    content,
    /<table><tr><td class="headline" style="font-weight:bold">Hello<\/td><\/tr><\/table>/,
  );
  assert.match(content, /href="https:\/\/example\.com\/path"/);
  assert.match(
    content,
    /src="https:\/\/example\.com\/banner\.jpg"/,
  );
  assert.doesNotMatch(content, /Duplicated subject/);
  assert.doesNotMatch(content, /<script|<form|<input|<iframe|onerror=/);
  assert.doesNotMatch(content, /alert\("unsafe"\)/);
});

test("email HTML loads remote images while blocking active capabilities", () => {
  const content = buildEmailHtmlContent(
    '<a href="javascript:alert(1)">Unsafe</a><img src="https://example.com/banner.jpg">',
  );

  assert.match(
    content,
    /src="https:\/\/example\.com\/banner\.jpg"/,
  );
  assert.match(content, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(content, /javascript:/);
});

test("email HTML preserves one-pixel and visible remote images", () => {
  const content = buildEmailHtmlContent(
    `
      <img src="https://example.com/tracker.gif" width="1" height="1">
      <img src="https://example.com/banner.jpg" width="600" height="240">
    `,
  );

  assert.match(content, /tracker\.gif/);
  assert.match(content, /banner\.jpg/);
});

test("email HTML preserves self-contained images", () => {
  const content = buildEmailHtmlContent(
    '<p>Hello</p><img src="data:image/png;base64,iVBORw0KGgo=">',
  );

  assert.match(content, /data:image\/png;base64,iVBORw0KGgo=/);
});

test("email HTML preserves remote CSS images without changing data images", () => {
  const content = buildEmailHtmlContent(
    `
      <style class="mail-theme">.hero { background-image: url("https://example.com/hero.png"); }</style>
      <div style="background: url(data:image/png;base64,iVBORw0KGgo=), url('//example.com/tile.png'); content: image-set('https://example.com/retina.png' 2x)"></div>
    `,
  );

  assert.match(content, /https:\/\/example\.com\/hero\.png/);
  assert.match(content, /https:\/\/example\.com\/tile\.png/);
  assert.match(content, /https:\/\/example\.com\/retina\.png/);
  assert.doesNotMatch(content, /url\(["']?\/\//);
  assert.match(content, /<style class="mail-theme">/);
  assert.match(content, /data:image\/png;base64,iVBORw0KGgo=/);
});

test("email HTML rejects credentialed and non-default-port image URLs", () => {
  const content = buildEmailHtmlContent(
    `
      <img src="https://user@example.com/private.png">
      <img src="http://example.com:8080/private.png">
    `,
  );

  assert.doesNotMatch(content, /src="https?:\/\//);
  assert.equal(content.match(/src="data:,"/g)?.length, 2);
});

test("email HTML loads remote images directly without an API capability", () => {
  const content = buildEmailHtmlContent(
    '<img src="https://example.com/banner.png"><div style="background:url(https://example.com/tile.png)"></div>',
  );

  assert.match(content, /src="https:\/\/example\.com\/banner\.png"/);
  assert.match(content, /https:\/\/example\.com\/tile\.png/);
});

test("email HTML preserves sender color rules and legacy color attributes", () => {
  const content = buildEmailHtmlContent(
    `
      <style>
        p { color: #222222; }
        @media (prefers-color-scheme: dark) { p { color: #eeeeee; } }
      </style>
      <table bgcolor="#ffffff"><tr><td><font color="#525151">Hello</font></td></tr></table>
    `,
  );

  assert.match(content, /p \{ color: #222222; \}/);
  assert.match(content, /@media \(prefers-color-scheme: dark\)/);
  assert.match(content, /bgcolor="#ffffff"/);
  assert.match(content, /color="#525151"/);
});

test("email HTML includes the isolated viewer root without a document wrapper", () => {
  const content = buildEmailHtmlContent("<p>Hello</p>");

  assert.match(content, /:host \{/);
  assert.match(content, /color-scheme: only light/);
  assert.match(content, /background-color: #ffffff/);
  assert.match(content, /color: #202124/);
  assert.match(content, /class="invook-email-body" role="document"/);
  assert.doesNotMatch(content, /<!doctype|<html|<body|postMessage|ResizeObserver/);
});
