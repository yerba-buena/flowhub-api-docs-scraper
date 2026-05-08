// Flowhub Stoplight Portal -> Agent-Ready Markdown
//
// Set OUTPUT_DIR env var to write into a clone of flowhub-api-docs:
//   OUTPUT_DIR=../flowhub-api-docs node scrape.js

import { chromium } from "playwright";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

const BASE_URL = "https://flowhub.stoplight.io";
const START_URL = `${BASE_URL}/docs/public-developer-portal/4b402d5ab3edd-welcome`;
const URL_PREFIX = "/docs/public-developer-portal/";
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "./output");
const PAGES_DIR = path.join(OUTPUT_DIR, "pages");
const SECTIONS_DIR = path.join(OUTPUT_DIR, "sections");
const SPECS_DIR = path.join(OUTPUT_DIR, "specs");

const DELAY_MS = 600;
const NAV_TIMEOUT_MS = 45_000;
const CONTENT_TIMEOUT_MS = 20_000;
const EXPANSION_PASSES = 8;
const EXPANSION_PASS_DELAY = 350;
const TAB_DWELL_MS = 250;
const EXTRA_URLS = [];
const TOC_URL = "https://flowhub.stoplight.io/api/v1/projects/cHJqOjkwNTcz/table-of-contents";

const CONTENT_SELECTORS = [
  '[data-testid="two-column-left"]',
  ".sl-elements",
  ".sl-elements-api",
  "main",
  '[role="main"]',
  "article",
];

const EXPAND_SELECTORS = [
  '[aria-expanded="false"]',
  '[role="button"][aria-expanded="false"]',
  'button[aria-expanded="false"]',
];

const SECTION_RULES = [
  { match: /welcome|introduction|getting.?started|overview/i, section: "00-overview" },
  { match: /auth|api.?key|oauth|token|security/i, section: "01-authentication" },
  { match: /rate.?limit|pagination|error|status.?code|webhook|conventions|versioning/i, section: "02-conventions" },
  { match: /location/i, section: "03-locations" },
  { match: /order/i, section: "04-orders" },
  { match: /product/i, section: "05-products" },
  { match: /inventory|package|batch/i, section: "06-inventory" },
  { match: /customer|patient|loyalty/i, section: "07-customers" },
  { match: /transaction|payment|sale/i, section: "08-transactions" },
  { match: /employee|user|staff|role/i, section: "09-employees" },
  { match: /vendor|supplier|manifest/i, section: "10-vendors" },
  { match: /report|analytic/i, section: "11-reports" },
  { match: /metrc|compliance|trace/i, section: "12-compliance" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugFromUrl(url) {
  const u = new URL(url);
  const last = u.pathname.split("/").filter(Boolean).pop() || "index";
  return last.replace(/[^a-z0-9-_]/gi, "_");
}

function inferSection(title, url) {
  const haystack = `${title} ${url}`;
  for (const rule of SECTION_RULES) {
    if (rule.match.test(haystack)) return rule.section;
  }
  return "99-misc";
}

function setupTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  td.addRule("stripButtons", { filter: (n) => n.nodeName === "BUTTON", replacement: () => "" });
  td.addRule("stripSvg", {
    filter: (n) => n.nodeName === "SVG" || n.nodeName === "svg" || n.nodeName === "PATH",
    replacement: () => "",
  });
  td.addRule("stripFeedback", {
    filter: (n) => n.nodeName === "DIV" && /was this (helpful|page)/i.test(n.textContent || ""),
    replacement: () => "",
  });
  return td;
}

async function expandEverything(page) {
  for (let pass = 0; pass < EXPANSION_PASSES; pass++) {
    const result = await page.evaluate((selectors) => {
      let clicked = 0;
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          try { el.click(); clicked++; } catch {}
        });
      }
      document.querySelectorAll("details:not([open])").forEach((d) => { d.open = true; clicked++; });
      return clicked;
    }, EXPAND_SELECTORS);
    if (result === 0) break;
    await sleep(EXPANSION_PASS_DELAY);
  }
}

async function rotateTabs(page) {
  const tabLists = await page.$$('[role="tablist"]');
  for (const tablist of tabLists) {
    const tabs = await tablist.$$('[role="tab"]');
    for (const tab of tabs) {
      try {
        const isSelected = await tab.getAttribute("aria-selected");
        if (isSelected === "true") continue;
        await tab.click({ timeout: 2000 });
        await sleep(TAB_DWELL_MS);
      } catch {}
    }
  }
  await expandEverything(page);
}

async function discoverUrlsFromToc() {
  console.log("[discover] fetching table of contents from Stoplight API...");
  const resp = await fetch(TOC_URL);
  if (!resp.ok) throw new Error(`ToC fetch failed: HTTP ${resp.status}`);
  const toc = await resp.json();

  // Map top-level Stoplight service titles to our section filenames
  const SERVICE_SECTIONS = {
    "Welcome": "00-overview",
    "Inventory": "06-inventory",
    "Orders": "04-orders",
    "Order Ahead": "04-orders",
    "Order-Ahead Bearer Token": "01-authentication",
  };

  const results = [];

  function processItems(items, section, groupName) {
    for (const item of items) {
      if (item.slug) {
        let itemSection = section;
        // The "Locations" group under Inventory gets its own section
        if (/^locations$/i.test(groupName)) itemSection = "03-locations";
        results.push({
          url: `${BASE_URL}/docs/public-developer-portal/${item.slug}`,
          slug: item.slug,
          section: itemSection,
          type: item.type || "unknown",
          title: item.title || item.slug,
        });
      }
      if (item.items) {
        processItems(item.items, section, item.title || groupName);
      }
    }
  }

  for (const topItem of toc.items || []) {
    const section = SERVICE_SECTIONS[topItem.title] ?? inferSection(topItem.title || "", topItem.slug || "");
    if (topItem.slug) {
      results.push({
        url: `${BASE_URL}/docs/public-developer-portal/${topItem.slug}`,
        slug: topItem.slug,
        section,
        type: topItem.type || "http_service",
        title: topItem.title || topItem.slug,
      });
    }
    if (topItem.items) {
      processItems(topItem.items, section, null);
    }
  }

  console.log(`[discover] found ${results.length} pages from table of contents`);
  return results;
}

async function extractPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  for (const sel of CONTENT_SELECTORS) {
    try { await page.waitForSelector(sel, { timeout: 4000 }); break; } catch {}
  }
  await sleep(1500);
  await expandEverything(page);
  await rotateTabs(page);
  await expandEverything(page);
  return page.evaluate((selectors) => {
    const title = document.querySelector("h1")?.innerText?.trim() ||
      document.title.replace(/\s*\|.*$/, "").trim() || "Untitled";
    let best = null, bestLen = 0, bestSel = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const len = (el.innerText || "").length;
      if (len > bestLen) { best = el; bestLen = len; bestSel = sel; }
    }
    return {
      html: best ? best.innerHTML : document.body.innerHTML,
      title, usedSelector: bestSel, textLength: bestLen,
    };
  }, CONTENT_SELECTORS);
}

function generateDescription(title, markdown) {
  const lines = markdown.split("\n").map((l) => l.trim());
  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("|") ||
        line.startsWith("-") || line.startsWith("*") || line.startsWith("```")) continue;
    if (line.length < 30) continue;
    return line.length > 240 ? line.slice(0, 237) + "..." : line;
  }
  return `Reference for ${title}.`;
}

// ---------------------------------------------------------------------------
// Phase: Fetch OpenAPI specs directly from Stoplight's API
// ---------------------------------------------------------------------------

const OPENAPI_SOURCES = [
  {
    url: "https://stoplight.io/api/v1/projects/flowhub/public-developer-portal/nodes/reference/Flowhub%20APIs.oas2.yml?fromExportButton=true&snapshotType=http_service&deref=optimizedBundle",
    filename: "inventory-api.yaml",
    summaryFilename: "inventory-api-summary.md",
    format: "yaml",
  },
  {
    url: "https://stoplight.io/api/v1/projects/flowhub/public-developer-portal/nodes/reference/Order-Ahead.oas2.yml?fromExportButton=true&snapshotType=http_service&deref=optimizedBundle",
    filename: "order-ahead.yaml",
    summaryFilename: "order-ahead-summary.md",
    format: "yaml",
  },
  {
    url: "https://stoplight.io/api/v1/projects/flowhub/public-developer-portal/nodes/reference/update%20access%20token.oas2.yml?fromExportButton=true&snapshotType=http_service&deref=optimizedBundle",
    filename: "access-token.yaml",
    summaryFilename: "access-token-summary.md",
    format: "yaml",
  },
  {
    url: "https://stoplight.io/api/v1/projects/flowhub/public-developer-portal/nodes/reference/orders.oas2.yml?fromExportButton=true&snapshotType=http_service&deref=optimizedBundle",
    filename: "orders-api.yaml",
    summaryFilename: "orders-api-summary.md",
    format: "yaml",
  },
  {
    url: "https://flowhub.stoplight.io/api/v1/projects/cHJqOjkwNTcz/table-of-contents",
    filename: "table-of-contents.json",
    format: "json",
  },
];

function generateSpecSummary(spec, sourceUrl) {
  const lines = [];

  // Title and version
  const title = spec.info?.title ?? "Untitled API";
  const version = spec.info?.version ?? "unknown";
  lines.push(`# ${title}`, "");
  lines.push(`**Version:** ${version}`, "");
  if (spec.info?.description) {
    lines.push(`**Description:** ${spec.info.description}`, "");
  }
  lines.push(`**Source:** ${sourceUrl}`, "");

  // Base URL
  if (spec.host || spec.basePath) {
    const scheme = spec.schemes?.[0] ?? "https";
    const host = spec.host ?? "unknown";
    const basePath = spec.basePath ?? "/";
    lines.push(`**Base URL:** \`${scheme}://${host}${basePath}\``, "");
  }
  if (spec.servers && spec.servers.length > 0) {
    lines.push("**Servers:**", "");
    for (const server of spec.servers) {
      lines.push(`- \`${server.url}\`${server.description ? ` — ${server.description}` : ""}`);
    }
    lines.push("");
  }

  // Authentication
  const securityDefs = spec.securityDefinitions ?? spec.components?.securitySchemes ?? null;
  if (securityDefs) {
    lines.push("## Authentication", "");
    for (const [name, def] of Object.entries(securityDefs)) {
      const type = def.type ?? "unknown";
      const inLocation = def.in ? ` (in ${def.in})` : "";
      const paramName = def.name ? `, parameter: \`${def.name}\`` : "";
      lines.push(`- **${name}**: type=\`${type}\`${inLocation}${paramName}`);
      if (def.description) lines.push(`  - ${def.description}`);
    }
    lines.push("");
  }

  // Endpoints
  const paths = spec.paths ?? {};
  const pathKeys = Object.keys(paths).sort();
  if (pathKeys.length > 0) {
    lines.push("## Endpoints", "");
    lines.push("| Method | Path | Operation ID | Summary |");
    lines.push("|--------|------|-------------|---------|");

    const endpointDetails = [];

    for (const pathStr of pathKeys) {
      const methods = paths[pathStr];
      for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
        const op = methods[method];
        if (!op) continue;
        const opId = op.operationId ?? "—";
        const summary = op.summary ?? "—";
        lines.push(`| \`${method.toUpperCase()}\` | \`${pathStr}\` | \`${opId}\` | ${summary} |`);

        // Collect request body info for POST/PATCH/PUT
        if (["post", "patch", "put"].includes(method)) {
          const bodyInfo = extractRequestBody(op, spec);
          if (bodyInfo) {
            endpointDetails.push({ method: method.toUpperCase(), path: pathStr, opId, bodyInfo });
          }
        }
      }
    }
    lines.push("");

    // Request body details for POST/PATCH/PUT
    if (endpointDetails.length > 0) {
      lines.push("## Request Bodies", "");
      for (const detail of endpointDetails) {
        lines.push(`### \`${detail.method} ${detail.path}\` (\`${detail.opId}\`)`, "");
        lines.push(detail.bodyInfo, "");
      }
    }
  }

  // Definitions / Schemas
  const definitions = spec.definitions ?? spec.components?.schemas ?? {};
  const defKeys = Object.keys(definitions).sort();
  if (defKeys.length > 0) {
    lines.push("## Definitions / Schemas", "");
    for (const defName of defKeys) {
      const schema = definitions[defName];
      lines.push(`### \`${defName}\``, "");
      if (schema.description) lines.push(`${schema.description}`, "");
      if (schema.type) lines.push(`**Type:** \`${schema.type}\``, "");

      const props = schema.properties ?? {};
      const propKeys = Object.keys(props);
      const required = new Set(schema.required ?? []);
      if (propKeys.length > 0) {
        lines.push("| Property | Type | Required | Description |");
        lines.push("|----------|------|----------|-------------|");
        for (const prop of propKeys) {
          const p = props[prop];
          const type = formatSchemaType(p);
          const req = required.has(prop) ? "Yes" : "No";
          const desc = (p.description ?? "—").replace(/\n/g, " ");
          lines.push(`| \`${prop}\` | \`${type}\` | ${req} | ${desc} |`);
        }
        lines.push("");
      }

      // Handle enum values
      if (schema.enum) {
        lines.push(`**Enum values:** ${schema.enum.map((v) => `\`${v}\``).join(", ")}`, "");
      }
    }
  }

  return lines.join("\n");
}

function formatSchemaType(schema) {
  if (!schema) return "unknown";
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (schema.type === "array") {
    if (schema.items?.$ref) return `array<${schema.items.$ref.split("/").pop()}>`;
    if (schema.items?.type) return `array<${schema.items.type}>`;
    return "array";
  }
  if (schema.type) {
    let t = schema.type;
    if (schema.format) t += `(${schema.format})`;
    return t;
  }
  if (schema.allOf) return "allOf(...)";
  if (schema.oneOf) return "oneOf(...)";
  if (schema.anyOf) return "anyOf(...)";
  return "object";
}

function extractRequestBody(operation, spec) {
  const lines = [];

  // Swagger 2.x style: body parameter
  const bodyParams = (operation.parameters ?? []).filter((p) => p.in === "body");
  if (bodyParams.length > 0) {
    for (const bp of bodyParams) {
      if (bp.schema) {
        if (bp.schema.$ref) {
          const refName = bp.schema.$ref.split("/").pop();
          lines.push(`**Body schema:** [\`${refName}\`](#${refName.toLowerCase()})`);
        } else {
          lines.push(`**Body schema:** inline \`${bp.schema.type ?? "object"}\``);
          const props = bp.schema.properties ?? {};
          const propKeys = Object.keys(props);
          const required = new Set(bp.schema.required ?? []);
          if (propKeys.length > 0) {
            lines.push("");
            lines.push("| Property | Type | Required | Description |");
            lines.push("|----------|------|----------|-------------|");
            for (const prop of propKeys) {
              const p = props[prop];
              const type = formatSchemaType(p);
              const req = required.has(prop) ? "Yes" : "No";
              const desc = (p.description ?? "—").replace(/\n/g, " ");
              lines.push(`| \`${prop}\` | \`${type}\` | ${req} | ${desc} |`);
            }
          }
        }
      }
    }
  }

  // OpenAPI 3.x style: requestBody
  if (operation.requestBody) {
    const content = operation.requestBody.content ?? {};
    for (const [mediaType, mediaObj] of Object.entries(content)) {
      lines.push(`**Content-Type:** \`${mediaType}\``);
      if (mediaObj.schema?.$ref) {
        const refName = mediaObj.schema.$ref.split("/").pop();
        lines.push(`**Body schema:** [\`${refName}\`](#${refName.toLowerCase()})`);
      } else if (mediaObj.schema) {
        lines.push(`**Body schema:** inline \`${mediaObj.schema.type ?? "object"}\``);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

async function fetchOpenAPISpecs() {
  console.log("\n[openapi] Fetching OpenAPI specs from Stoplight API...");
  await fs.mkdir(SPECS_DIR, { recursive: true });

  for (const source of OPENAPI_SOURCES) {
    const label = source.filename;
    try {
      console.log(`[openapi] downloading ${label}...`);
      const resp = await fetch(source.url);
      if (!resp.ok) {
        console.error(`[openapi] FAILED ${label}: HTTP ${resp.status} ${resp.statusText}`);
        continue;
      }
      const text = await resp.text();
      await fs.writeFile(path.join(SPECS_DIR, source.filename), text, "utf8");
      console.log(`[openapi] saved ${label} (${text.length.toLocaleString()} chars)`);

      // Generate summary for YAML specs
      if (source.format === "yaml" && source.summaryFilename) {
        try {
          const spec = yaml.parse(text);
          const summary = generateSpecSummary(spec, source.url);
          await fs.writeFile(path.join(SPECS_DIR, source.summaryFilename), summary, "utf8");
          console.log(`[openapi] generated summary: ${source.summaryFilename}`);
        } catch (parseErr) {
          console.error(`[openapi] failed to parse/summarize ${label}: ${parseErr.message}`);
        }
      }
    } catch (err) {
      console.error(`[openapi] FAILED ${label}: ${err.message}`);
    }
  }

  console.log("[openapi] OpenAPI spec fetch complete.");
}

async function main() {
  console.log(`[config] OUTPUT_DIR = ${OUTPUT_DIR}`);
  await fs.mkdir(PAGES_DIR, { recursive: true });
  await fs.mkdir(SECTIONS_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1800 },
    userAgent: "Mozilla/5.0 (compatible; FlowhubDocsArchiver/2.0; +https://github.com/yerba-buena/flowhub-api-docs-scraper)",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const td = setupTurndown();

  try {
    const tocPages = await discoverUrlsFromToc();
    const slugMeta = new Map(tocPages.map((p) => [p.slug, p]));
    const allUrls = tocPages.map((p) => p.url);
    console.log(`[plan] ${allUrls.length} pages to scrape`);
    const records = [];

    for (let i = 0; i < allUrls.length; i++) {
      const url = allUrls[i];
      const slug = slugFromUrl(url);
      const tag = `[${i + 1}/${allUrls.length}]`;
      try {
        const { html, title, usedSelector, textLength } = await extractPage(page, url);
        const md = td.turndown(html).trim();
        const section = slugMeta.get(slug)?.section ?? inferSection(title, url);
        const description = generateDescription(title, md);
        const frontmatter = `---
title: ${JSON.stringify(title)}
source: ${url}
slug: ${slug}
section: ${section}
scraped_at: ${new Date().toISOString()}
extracted_via: ${usedSelector ?? "fallback"}
text_length: ${textLength}
---

# ${title}

${md}
`;
        await fs.writeFile(path.join(PAGES_DIR, `${slug}.md`), frontmatter, "utf8");
        records.push({ slug, url, title, section, markdown: md, description, usedSelector, textLength });
        console.log(`${tag} ${section}/${slug} (${textLength} chars)`);
      } catch (err) {
        console.error(`${tag} FAILED ${url}: ${err.message}`);
        records.push({ slug, url, title: null, section: "99-misc", error: err.message });
      }
      await sleep(DELAY_MS);
    }

    const sectionMap = new Map();
    for (const r of records) {
      if (r.error) continue;
      if (!sectionMap.has(r.section)) sectionMap.set(r.section, []);
      sectionMap.get(r.section).push(r);
    }
    const sectionFiles = [];
    const sectionNames = Array.from(sectionMap.keys()).sort();

    for (const section of sectionNames) {
      const pages = sectionMap.get(section);
      const filename = `${section}.md`;
      const body = [`# ${section}`, "", `> Section file containing ${pages.length} page(s) from the Flowhub developer portal.`, "", "## Pages in this section", ""];
      for (const p of pages) body.push(`- [${p.title}](#${p.slug}) — ${p.description}`);
      body.push("", "---", "");
      for (const p of pages) {
        body.push("", `<a id="${p.slug}"></a>`, "", `## ${p.title}`, "", `**Source:** ${p.url}`, "", p.markdown, "", "---", "");
      }
      const content = body.join("\n");
      await fs.writeFile(path.join(SECTIONS_DIR, filename), content, "utf8");
      sectionFiles.push({
        filename, section, page_count: pages.length, char_count: content.length,
        pages: pages.map((p) => ({ slug: p.slug, title: p.title, description: p.description, source: p.url })),
      });
    }

    const consolidated = [
      `# Flowhub Public Developer Portal — Complete Reference`, "",
      `Scraped from \`${BASE_URL}\` on ${new Date().toISOString()}.`, "",
      `This file consolidates ${records.filter((r) => !r.error).length} pages from the Flowhub Stoplight developer portal into a single Markdown reference for agent retrieval. For token-efficient retrieval, prefer the per-section files in \`sections/\` plus the \`INDEX.md\`.`, "",
      "## Table of contents", "",
    ];
    for (const section of sectionNames) {
      consolidated.push(`### ${section}`, "");
      for (const p of sectionMap.get(section)) consolidated.push(`- [${p.title}](#${p.slug})`);
      consolidated.push("");
    }
    consolidated.push("---", "");
    for (const section of sectionNames) {
      consolidated.push("", `# ${section}`, "");
      for (const p of sectionMap.get(section)) {
        consolidated.push("", `<a id="${p.slug}"></a>`, "", `## ${p.title}`, "", `**Source:** ${p.url}`, "", p.markdown, "", "---");
      }
    }
    await fs.writeFile(path.join(OUTPUT_DIR, "flowhub-api-reference.md"), consolidated.join("\n"), "utf8");

    const index = [
      "# Flowhub API Reference — Index", "",
      `Machine-readable index of the Flowhub Public Developer Portal, scraped on ${new Date().toISOString().split("T")[0]}.`, "",
      `Source: ${BASE_URL}`,
      `Scraper: https://github.com/yerba-buena/flowhub-api-docs-scraper`, "",
      "## How to use this index (for agents)", "",
      "1. Read this file to understand what content is in which file.",
      "2. Load only the section file(s) you need from `sections/`.",
      "3. If you need the entire spec in one shot, load `flowhub-api-reference.md`.",
      "4. For programmatic access, parse `manifest.json`.",
      "5. For OpenAPI/Postman exports (AI-generated approximations), see `spec/`.", "",
      "## Files in this package", "",
      "| File | Pages | Size (chars) | Description |",
      "|------|-------|--------------|-------------|",
    ];
    for (const s of sectionFiles) {
      const desc = s.pages.length === 1
        ? s.pages[0].description
        : `Covers ${s.pages.length} pages: ${s.pages.slice(0, 3).map((p) => p.title).join(", ")}${s.pages.length > 3 ? ", ..." : ""}.`;
      index.push(`| \`sections/${s.filename}\` | ${s.page_count} | ${s.char_count.toLocaleString()} | ${desc} |`);
    }
    index.push(
      `| \`flowhub-api-reference.md\` | ${records.filter((r) => !r.error).length} | (full) | Single-file consolidated reference. |`,
      `| \`pages/<slug>.md\` | 1 each | varies | Raw per-page extracts with YAML frontmatter. |`,
      `| \`manifest.json\` | — | — | Machine-readable index. |`,
      `| \`spec/openapi.yaml\` | — | — | AI-generated OpenAPI 3.1 spec (approximation, not authoritative). |`,
      `| \`spec/postman-collection.json\` | — | — | Postman collection generated from openapi.yaml. |`,
      "",
      "## Section detail", ""
    );
    for (const s of sectionFiles) {
      index.push(`### \`sections/${s.filename}\``, "");
      for (const p of s.pages) {
        index.push(`- **${p.title}** — ${p.description}`, `  - Source: ${p.source}`, `  - Anchor: \`#${p.slug}\``);
      }
      index.push("");
    }
    const failed = records.filter((r) => r.error);
    if (failed.length > 0) {
      index.push("## Pages that failed to scrape", "");
      for (const f of failed) index.push(`- ${f.url} — ${f.error}`);
      index.push("");
    }
    await fs.writeFile(path.join(OUTPUT_DIR, "INDEX.md"), index.join("\n"), "utf8");

    const manifest = {
      scraped_at: new Date().toISOString(),
      source: BASE_URL,
      scraper: "https://github.com/yerba-buena/flowhub-api-docs-scraper",
      total_pages: records.length,
      successful: records.filter((r) => !r.error).length,
      failed: failed.length,
      sections: sectionFiles,
      pages: records.map((r) => ({
        slug: r.slug, url: r.url, title: r.title, section: r.section,
        description: r.description ?? null, char_count: r.markdown?.length ?? 0, error: r.error ?? null,
      })),
    };
    await fs.writeFile(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const llmsTxt = [
      "# Flowhub API Reference", "",
      `> Mirror of the Flowhub Public Developer Portal, scraped from ${BASE_URL} and converted to Markdown for agent consumption. Generated by https://github.com/yerba-buena/flowhub-api-docs-scraper`, "",
      "## Files", "",
      "- [INDEX.md](INDEX.md): Human + agent index of all files with descriptions",
      "- [flowhub-api-reference.md](flowhub-api-reference.md): Complete single-file reference",
      "- [manifest.json](manifest.json): Machine-readable manifest",
      "- [spec/openapi.yaml](spec/openapi.yaml): AI-generated OpenAPI spec (approximation)", "",
      "## Sections", "",
      ...sectionFiles.map((s) => `- [sections/${s.filename}](sections/${s.filename}): ${s.page_count} pages, ${s.char_count.toLocaleString()} chars`),
    ].join("\n");
    await fs.writeFile(path.join(OUTPUT_DIR, "llms.txt"), llmsTxt, "utf8");

    const ok = records.filter((r) => !r.error).length;
    console.log(`\nDone. ${ok} ok, ${failed.length} failed.`);
    console.log(`Output: ${OUTPUT_DIR}`);
  } finally {
    await browser.close();
  }

  // Fetch OpenAPI specs after browser is closed — runs independently so
  // Playwright scraping results are preserved even if this phase fails.
  try {
    await fetchOpenAPISpecs();
  } catch (err) {
    console.error("[openapi] OpenAPI spec fetch failed (non-fatal):", err.message);
  }
}

main().catch((err) => { console.error("fatal:", err); process.exit(1); });
