# flowhub-api-docs-scraper

Playwright-based scraper that mirrors the [Flowhub Public Developer Portal](https://flowhub.stoplight.io/docs/public-developer-portal/) into agent-ready Markdown, plus an OpenAPI spec generator.

The scraped output lives at **[yerba-buena/flowhub-api-docs](https://github.com/yerba-buena/flowhub-api-docs)**.

> **Unofficial.** Not produced, endorsed, or supported by Flowhub, Inc. See [DISCLAIMER.md](DISCLAIMER.md).

## What it does

`scrape.js`:
1. Launches headless Chromium
2. Crawls the Stoplight portal, expanding all collapsible UI and rotating through all tabs
3. Converts each page to Markdown
4. Groups pages by topic into section files
5. Writes `INDEX.md`, `manifest.json`, `llms.txt`, and a single consolidated reference

`generate-spec.js`:
1. Reads the per-section Markdown
2. Asks Claude to draft OpenAPI 3.1 fragments for each endpoint section
3. Merges into a single spec, validates, converts to Postman
4. Writes to `spec/` in the docs repo with prominent disclaimers

## Local usage

```bash
git clone https://github.com/yerba-buena/flowhub-api-docs-scraper.git
cd flowhub-api-docs-scraper
npm install
npx playwright install chromium

# Just scrape
node scrape.js

# Scrape + generate spec
ANTHROPIC_API_KEY=sk-... node scrape.js && \
  DOCS_DIR=./output node generate-spec.js
```

Output lands in `./output/` (gitignored).

## Publishing to the docs repo

```bash
# One-time setup
cd ..
git clone https://github.com/yerba-buena/flowhub-api-docs.git
cd flowhub-api-docs-scraper

# Refresh
ANTHROPIC_API_KEY=sk-... ./publish.sh
```

This pulls the docs repo, runs scrape + generate-spec, commits with a timestamp, tags as `snapshot-YYYY-MM-DD`, pushes.

## Automated weekly re-scrape

`.github/workflows/scrape.yml` runs every Sunday. Setup:

1. Generate a deploy key, add the public key to `flowhub-api-docs` with **write access**
2. Add the private key to this repo's secrets as `DOCS_REPO_DEPLOY_KEY`
3. Add your Anthropic API key as `ANTHROPIC_API_KEY`

## How the scraper handles Stoplight

Stoplight Elements lazy-renders schemas and tabs. The scraper sweeps every page up to 8 times to click `[aria-expanded="false"]` triggers, force-opens `<details>`, rotates through every `[role="tab"]`, then sweeps again.

Tunable via constants at the top of `scrape.js`. See troubleshooting in [DISCLAIMER.md](DISCLAIMER.md) and the doc repo's README.

## License

MIT for the scraper code. The mirrored content in `flowhub-api-docs` belongs to Flowhub.
