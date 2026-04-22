# Claude Code prompt — flowhub-api-docs-scraper

Paste this into Claude Code from inside this directory.

---

This is the Flowhub portal scraper. It needs to be set up as a git repo,
pushed to https://github.com/yerba-buena/flowhub-api-docs-scraper, and then
used to populate the sibling docs repo.

## Step 1: Initialize and push

```bash
git init
git branch -M main
git remote add origin https://github.com/yerba-buena/flowhub-api-docs-scraper.git
git add .
git commit -m "Initial: scraper + OpenAPI generator for Flowhub portal"
git push -u origin main
```

If the remote already has commits (e.g. an auto-generated README), do
`git pull --rebase origin main` first then push.

## Step 2: Install dependencies

```bash
npm install
npx playwright install chromium
```

## Step 3: Local test scrape (without spec generation)

```bash
node scrape.js
```

Takes 8–20 min. Watch for "FAILED" lines. Verify `output/INDEX.md` has
sensible sections and a low failure count.

## Step 4: Verify extraction quality

Spot-check `output/sections/`:

1. Auth section: explains how to authenticate, what headers, how to get creds
2. An endpoint-bearing section (Orders or Products): for one endpoint, confirm
   - HTTP method and path are present
   - Parameters have name, type, location, required/optional, description
   - Request body schema shows nested fields, NOT placeholders like "Object" or "→ MyType"
   - At least one request example present
   - Response schema present with all fields
   - Multiple status codes (200, 400, etc.) have their response bodies
   - Code samples in multiple languages

If anything's missing, edit `scrape.js`: bump `EXPANSION_PASSES` to 12 and
`EXPANSION_PASS_DELAY` to 600. Re-run.

## Step 5: Test spec generation locally

You'll need an Anthropic API key. Get one at https://console.anthropic.com.

```bash
ANTHROPIC_API_KEY=sk-ant-... DOCS_DIR=./output node generate-spec.js
```

Verify `output/spec/`:
- `openapi.yaml` exists and is valid YAML (try `npx @redocly/cli lint output/spec/openapi.yaml`)
- `postman-collection.json` exists
- `README.md` has the prominent disclaimer

## Step 6: Publish to docs repo

The sibling `flowhub-api-docs` repo should already exist (set up by the
prompt in that folder). Once it does:

```bash
ANTHROPIC_API_KEY=sk-ant-... ./publish.sh
```

This pulls the docs repo, scrapes + generates spec into it, commits with a
timestamp, tags as `snapshot-YYYY-MM-DD`, pushes.

## Step 7: Enable scheduled CI (optional but recommended)

1. Generate a deploy key:
   ```bash
   ssh-keygen -t ed25519 -f /tmp/flowhub-deploy-key -N ""
   ```
2. Add the PUBLIC key to `flowhub-api-docs` repo:
   Settings → Deploy keys → Add → CHECK "Allow write access"
3. Add the PRIVATE key to THIS repo's secrets:
   Settings → Secrets and variables → Actions → New
   - Name: `DOCS_REPO_DEPLOY_KEY`
4. Add Anthropic API key as `ANTHROPIC_API_KEY` secret in this repo
5. Delete the local key files
6. Trigger the workflow manually from the Actions tab to test

## Report back

Tell me when each step completes. Paste any errors immediately.
