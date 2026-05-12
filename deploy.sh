#!/usr/bin/env bash
# Inkclass one-shot deploy helper.
# Picks the first available CLI (vercel > netlify > wrangler > surge) and deploys.
set -e
cd "$(dirname "$0")"

if command -v vercel >/dev/null || npx --no-install vercel --version >/dev/null 2>&1 || true; then
  echo "→ Deploying to Vercel (first run will prompt login)…"
  npx --yes vercel@latest deploy --prod --yes
  exit 0
fi
if command -v netlify >/dev/null; then
  echo "→ Deploying to Netlify…"
  netlify deploy --prod --dir=.
  exit 0
fi
if command -v wrangler >/dev/null; then
  echo "→ Deploying to Cloudflare Pages…"
  wrangler pages deploy . --project-name inkclass
  exit 0
fi
echo "No deploy CLI found. Try: npx vercel@latest"
