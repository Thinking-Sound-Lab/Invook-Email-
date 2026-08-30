import sanitizeHtml from "sanitize-html";
import valueParser from "postcss-value-parser";

const EMAIL_HTML_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
] as const;

function normalizeRemoteImageUrl(value: string): string | null {
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    if (url.port && url.port !== defaultPort) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function unquoteCssUrl(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function rewriteCssRemoteImages(css: string): string {
  const parsed = valueParser(css);
  parsed.walk((node) => {
    if (
      node.type === "function" &&
      ["image-set", "-webkit-image-set"].includes(node.value.toLowerCase())
    ) {
      for (const imageSetNode of node.nodes) {
        if (imageSetNode.type !== "string") continue;
        const source = normalizeRemoteImageUrl(imageSetNode.value);
        if (source) {
          imageSetNode.value = source;
        } else if (/^(?:https?:)?\/\//i.test(imageSetNode.value)) {
          imageSetNode.value = "data:,";
        }
      }
      return undefined;
    }
    if (node.type !== "function" || node.value.toLowerCase() !== "url") {
      return undefined;
    }
    const originalSource = unquoteCssUrl(valueParser.stringify(node.nodes));
    const source = normalizeRemoteImageUrl(originalSource);
    if (!source) {
      if (!/^data:/i.test(originalSource) && !originalSource.startsWith("#")) {
        node.nodes = valueParser('"data:,"').nodes;
      }
      return false;
    }
    node.nodes = valueParser(JSON.stringify(source)).nodes;
    return false;
  });
  return parsed.toString();
}

const QUOTED_CONTAINER_CLASS =
  /(?:^|\s)(?:gmail_quote|gmail_extra|yahoo_quoted|protonmail_quote|moz-cite-prefix|moz-forward-container)(?:\s|$)/i;
const QUOTED_CONTAINER_IDS = new Set([
  "divrplyfwdmsg",
  "replyforwardmessage",
]);

function prepareEmailAttributes(
  tagName: string,
  attributes: Record<string, string>,
): Record<string, string> {
  const sourceAttributes = { ...attributes };
  delete sourceAttributes["data-invook-quoted"];
  const preparedAttributes = sourceAttributes.style
    ? {
        ...sourceAttributes,
        style: rewriteCssRemoteImages(sourceAttributes.style),
      }
    : sourceAttributes;
  const isQuotedContainer =
    QUOTED_CONTAINER_CLASS.test(sourceAttributes.class ?? "") ||
    QUOTED_CONTAINER_IDS.has((sourceAttributes.id ?? "").toLowerCase()) ||
    (tagName === "blockquote" &&
      (sourceAttributes.type ?? "").toLowerCase() === "cite");

  return isQuotedContainer
    ? { ...preparedAttributes, "data-invook-quoted": "true" }
    : preparedAttributes;
}

function sanitizeEmailHtml(bodyHtml: string): string {
  const sanitizedBodyHtml = sanitizeHtml(bodyHtml, {
    allowedTags: [...EMAIL_HTML_TAGS],
    allowedAttributes: {
      "*": [
        "align",
        "aria-label",
        "bgcolor",
        "class",
        "color",
        "data-invook-quoted",
        "dir",
        "height",
        "id",
        "lang",
        "role",
        "style",
        "title",
        "valign",
        "width",
      ],
      a: ["href", "name", "rel", "target"],
      blockquote: ["type"],
      col: ["span"],
      img: ["alt", "referrerpolicy", "src"],
      ol: ["start", "type"],
      table: ["border", "cellpadding", "cellspacing", "summary"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      ul: ["type"],
    },
    allowedSchemes: ["data", "http", "https", "mailto", "tel"],
    // Email presentation depends on embedded CSS. The rendered content is
    // isolated from the application stylesheet by a Shadow DOM boundary.
    allowVulnerableTags: true,
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    nonTextTags: ["script", "style", "textarea", "option", "xmp", "title"],
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: prepareEmailAttributes("a", {
          ...attributes,
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        }),
      }),
      img: (_tagName, attributes) => {
        const originalSource = attributes.src ?? "";
        const source = normalizeRemoteImageUrl(originalSource);
        if (!source) {
          return {
            tagName: "img",
            attribs: prepareEmailAttributes(
              "img",
              /^(?:https?:)?\/\//i.test(originalSource.trim())
                ? { ...attributes, src: "data:," }
                : attributes,
            ),
          };
        }
        return {
          tagName: "img",
          attribs: prepareEmailAttributes("img", {
            ...attributes,
            referrerpolicy: "no-referrer",
            src: source,
          }),
        };
      },
      "*": (tagName, attributes) => ({
        tagName,
        attribs: prepareEmailAttributes(tagName, attributes),
      }),
    },
  });
  return sanitizedBodyHtml.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attributes: string, stylesheet: string) =>
      `<style${attributes}>${rewriteCssRemoteImages(stylesheet)}</style>`,
  );
}

const EMAIL_CONTENT_STYLES = `
  :host {
    color: inherit;
    color-scheme: inherit;
    display: block;
    font-family: inherit;
    min-width: 0;
    width: 100%;
  }
  .invook-email-body {
    all: initial;
    background-color: transparent;
    display: flow-root;
    min-width: 0;
    width: 100%;
    color: inherit;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    -webkit-text-size-adjust: 100%;
  }
  .invook-email-body img {
    border: 0;
    height: auto;
    max-width: 100%;
  }
  :where(.invook-email-body) a {
    color: color-mix(in oklch, var(--foreground) 58%, var(--chart-2) 42%);
    text-decoration-color: color-mix(in oklch, currentColor, transparent 42%);
    text-underline-offset: 0.14em;
  }
  .invook-email-body table {
    max-width: 100%;
  }
  .invook-email-body pre {
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  :host(:not([data-show-quoted="true"]))
    .invook-email-body [data-invook-quoted="true"] {
    display: none !important;
  }
`;

export interface EmailHtmlPresentation {
  sanitizedHtml: string;
  hasQuotedContent: boolean;
}

export function buildEmailHtmlPresentation(
  bodyHtml: string,
): EmailHtmlPresentation {
  const sanitizedBodyHtml = sanitizeEmailHtml(bodyHtml);
  return {
    sanitizedHtml: `<style>${EMAIL_CONTENT_STYLES}</style><div class="invook-email-body" role="document">${sanitizedBodyHtml}</div>`,
    hasQuotedContent:
      /<[a-z][^>]*\sdata-invook-quoted="true"(?:\s|>)/i.test(
        sanitizedBodyHtml,
      ),
  };
}

export function buildEmailHtmlContent(bodyHtml: string): string {
  return buildEmailHtmlPresentation(bodyHtml).sanitizedHtml;
}
