#!/usr/bin/env bash
# Re-scrape the Flowhub portal AND regenerate spec exports, then publish to
# the flowhub-api-docs repo.
#
# Requires: ANTHROPIC_API_KEY env var (for spec generation)
# Optional: DOCS_REPO env var (defaults to ../flowhub-api-docs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_REPO="${DOCS_REPO:-$SCRIPT_DIR/../flowhub-api-docs}"

if [[ ! -d "$DOCS_REPO/.git" ]]; then
  echo "ERROR: $DOCS_REPO is not a git repo." >&2
  echo "Clone it first:" >&2
  echo "  git clone https://github.com/yerba-buena/flowhub-api-docs.git $DOCS_REPO" >&2
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "WARNING: ANTHROPIC_API_KEY not set. Will scrape but skip spec generation." >&2
fi

echo "==> Pulling latest from docs repo"
(cd "$DOCS_REPO" && git pull --ff-only)

echo "==> Scraping into $DOCS_REPO"
cd "$SCRIPT_DIR"
OUTPUT_DIR="$DOCS_REPO" node scrape.js

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "==> Generating OpenAPI / Postman exports"
  DOCS_DIR="$DOCS_REPO" node generate-spec.js
else
  echo "==> Skipping spec generation (ANTHROPIC_API_KEY not set)"
fi

echo "==> Committing"
cd "$DOCS_REPO"
if [[ -z "$(git status --porcelain)" ]]; then
  echo "No changes to commit. Done."
  exit 0
fi

TIMESTAMP="$(date -u +'%Y-%m-%d %H:%M UTC')"
git add -A
git commit -m "Re-scrape: $TIMESTAMP"
git tag "snapshot-$(date -u +'%Y-%m-%d')" || true

echo "==> Pushing"
git push
git push --tags || true

echo "==> Done."
