// Flowhub Stoplight Portal -> Agent-Ready Markdown
//
// Set OUTPUT_DIR env var to write into a clone of flowhub-api-docs:
//   OUTPUT_DIR=../flowhub-api-docs node scrape.js

import { chromium } from "playwright";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://flowhub.stoplight.io";
const START_URL = `${BASE_URL}/docs/public-developer-portal/4b402d5ab3edd-welcome`;
const URL_PREFIX = "/docs/public-developer-portal/";
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "./output");
const PAGES_DIR = path.join(OUTPUT_DIR, "pages");
const SECTIONS_DIR = path.join(OUTPUT_DIR, "sections");

const DELAY_MS = 600;
const NAV_TIMEOUT_MS = 45_000;
const CONTENT_TIMEOUT_MS = 20_000;
const EXPANSION_PASSES = 8;
const EXPANSION_PASS_DELAY = 350;
const TAB_DWELL_MS = 250;
const EXTRA_URLS = [];

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

async function discoverUrls(page) {
  console.log(`[discover] loading ${START_URL}`);
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector("nav, aside, [role='navigation']", { timeout: CONTENT_TIMEOUT_MS }).catch(() => {});
  await sleep(2000);
  await expandEverything(page);
  await sleep(500);
  await expandEverything(page);
  const urls = await page.evaluate((prefix) => {
    const out = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || !href.includes(prefix)) return;
      try {
        const abs = new URL(href, window.location.origin).toString().split("#")[0];
        out.add(abs);
      } catch {}
    });
    return Array.from(out);
  }, URL_PREFIX);
  console.log(`[discover] found ${urls.length} sidebar links`);
  return urls;
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
    const discovered = await discoverUrls(page);
    const allUrls = Array.from(new Set([START_URL, ...discovered, ...EXTRA_URLS]));
    console.log(`[plan] ${allUrls.length} pages to scrape`);
    const records = [];

    for (let i = 0; i < allUrls.length; i++) {
      const url = allUrls[i];
      const slug = slugFromUrl(url);
      const tag = `[${i + 1}/${allUrls.length}]`;
      try {
        const { html, title, usedSelector, textLength } = await extractPage(page, url);
        const md = td.turndown(html).trim();
        const section = inferSection(title, url);
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
}

main().catch((err) => { console.error("fatal:", err); process.exit(1); });
