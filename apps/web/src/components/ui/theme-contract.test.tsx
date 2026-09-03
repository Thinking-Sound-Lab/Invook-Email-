import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const globalStyles = readFileSync(
  new URL("../../app/globals.css", import.meta.url),
  "utf8",
);
const rootTheme = globalStyles.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
const darkTheme = globalStyles.match(/\.dark \{([\s\S]*?)\n\}/)?.[1] ?? "";

function themeValue(theme: string, token: string): string | undefined {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return theme.match(new RegExp(`^\\s*${escapedToken}:\\s*([^;]+);`, "m"))?.[1];
}

test("global theme keeps Plus Jakarta Sans and explicit light and dark color schemes", () => {
  assert.match(
    globalStyles,
    /--font-sans: "Plus Jakarta Sans", "Plus Jakarta Sans Fallback"/,
  );
  assert.match(globalStyles, /:root \{[\s\S]*?color-scheme: light;/);
  assert.match(globalStyles, /\.dark \{[\s\S]*?color-scheme: dark;/);
  assert.doesNotMatch(globalStyles, /--font-sans:\s*var\(--font-sans\)/);
});

test("light and dark themes both define the shared shadcn surface tokens", () => {
  const requiredTokens = [
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--popover-foreground",
    "--primary",
    "--primary-foreground",
    "--border",
    "--input",
    "--ring",
  ];

  for (const token of requiredTokens) {
    assert.match(rootTheme, new RegExp(`${token}:`));
    assert.match(darkTheme, new RegExp(`${token}:`));
  }
});

test("the complete supplied light palette is represented by global tokens", () => {
  const expectedPalette = {
    "--landing-surface": "#fafaf9",
    "--landing-surface-warm": "#f6f5f4",
    "--lp-bg": "#f5f5f5",
    "--lp-surface": "#ffffff",
    "--landing-ink": "#1d1b17",
    "--landing-ink-soft": "#37352f",
    "--foreground": "#2c2c2b",
    "--lp-ink": "#2d2b36",
    "--landing-muted": "#686662",
    "--lp-muted": "#625f6b",
    "--settings-subtitle": "#5f5e5b",
    "--landing-cta-bg": "#191918",
    "--landing-border": "#e8e6e1",
    "--landing-border-soft": "#efede8",
    "--landing-cta-border": "#dfdcd9",
    "--lp-footer-bg": "#e6e6e6",
    "--landing-dash": "#d4d0ca",
    "--brand": "#4457c4",
    "--brand-hover": "#3949ab",
    "--brand-light": "#e7e9f9",
    "--graph-level-1": "#d9dcf3",
    "--graph-level-2": "#aeb6e5",
    "--graph-level-3": "#7886d5",
    "--primary-blue": "#3392dd",
    "--pricing-badge": "#0b6bcb",
    "--pricing-highlight": "#e6f0fb",
    "--tier-highlight": "#f2f9ff",
    "--bg-primary": "#ffffff",
    "--surface": "#f7f7f5",
    "--sidebar-calendar": "#f8f8f7",
    "--border": "#e5e5e5",
    "--border-strong": "#d1d5db",
    "--email-preview-border": "#e3e2e0",
    "--email-hover": "#ebebe9",
    "--email-focused": "#f5f5f5",
    "--pill-brown-bg": "#e9ddd8",
    "--pill-brown-text": "#6b5d54",
    "--pill-purple-bg": "#e8deee",
    "--pill-purple-text": "#6b5678",
    "--pill-blue-bg": "#d3e5ef",
    "--pill-blue-text": "#315f82",
    "--pill-red-bg": "#ffd5d2",
    "--pill-red-text": "#8c3a36",
    "--pill-pink-bg": "#fae1ee",
    "--pill-pink-text": "#8c3a6b",
    "--pill-yellow-bg": "#ffeab6",
    "--pill-yellow-text": "#7b6830",
    "--pill-green-bg": "#d4e7d7",
    "--pill-green-text": "#3a6b45",
    "--pill-orange-bg": "#ffddb0",
    "--pill-orange-text": "#7b5a2f",
    "--destructive": "#ef4444",
    "--destructive-action": "#b42318",
    "--destructive-light": "#fee2e2",
    "--success": "#10b981",
    "--success-light": "#d1fae5",
    "--warning": "#f59e0b",
    "--warning-light": "#fef3c7",
    "--reminder-dot": "#8b5cf6",
  } satisfies Record<string, string>;

  for (const [token, value] of Object.entries(expectedPalette)) {
    assert.equal(themeValue(rootTheme, token), value, token);
  }
});

test("semantic roles resolve through the supplied palette tokens", () => {
  const expectedAliases = {
    "--background": "var(--bg-primary)",
    "--card": "var(--bg-primary)",
    "--popover": "var(--dropdown)",
    "--primary": "var(--brand)",
    "--primary-hover": "var(--brand-hover)",
    "--secondary": "var(--surface)",
    "--muted": "var(--surface)",
    "--accent": "var(--email-hover)",
    "--input": "var(--border-strong)",
    "--ring": "var(--brand)",
    "--sidebar": "var(--surface)",
    "--compose-accent": "var(--brand)",
    "--compose-accent-hover": "var(--brand-hover)",
  } satisfies Record<string, string>;

  for (const [token, value] of Object.entries(expectedAliases)) {
    assert.equal(themeValue(rootTheme, token), value, token);
    assert.match(globalStyles, new RegExp(`--color-${token.slice(2)}:`), token);
  }
});

test("dark semantic tokens use the supplied dark palette", () => {
  const expectedPalette = {
    "--bg-primary": "#191919",
    "--surface": "#202020",
    "--dropdown": "#252525",
    "--email-view": "#252525",
    "--border": "#313131",
    "--foreground": "#d3d3d3",
    "--foreground-secondary": "#a8a8a8",
    "--brand": "#7c8af0",
    "--brand-hover": "#929cf2",
    "--destructive": "#de5550",
    "--success": "#34d399",
    "--warning": "#fbbf24",
    "--inverse": "#ffffff",
  } satisfies Record<string, string>;

  for (const [token, value] of Object.entries(expectedPalette)) {
    assert.equal(themeValue(darkTheme, token), value, token);
  }
});

test("product source uses global tokens instead of raw color values", () => {
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sourceFiles: string[] = [];
  const pendingDirectories = [sourceRoot];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) break;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.includes(".test.")
      ) {
        sourceFiles.push(entryPath);
      }
    }
  }

  const rawColorPattern =
    /#[\da-f]{3,8}\b|(?:rgb|hsl|oklch)a?\(|\b(?:bg|text|border|outline|ring|fill|stroke|shadow)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d{1,3})?\b/gi;

  for (const sourceFile of sourceFiles) {
    const source = readFileSync(sourceFile, "utf8");
    assert.doesNotMatch(
      source,
      rawColorPattern,
      `${sourceFile.slice(sourceRoot.length + 1)} bypasses the global theme`,
    );
  }
});
