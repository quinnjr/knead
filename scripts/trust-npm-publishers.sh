#!/usr/bin/env bash
# Registers this repo's release workflow as the npm trusted publisher (OIDC)
# for every public workspace package, so CI can publish without an NPM_TOKEN.
#
# Run once per package, by a maintainer logged in to npm with 2FA:
#   npm login            # or: pnpm dlx npm@11 login
#   pnpm trust:npm       # add --dry-run to preview
#
# A package must already exist on the registry before a trusted publisher can
# be attached to it, so a brand-new package needs one manual first publish.
set -euo pipefail

REPO="quinnjr/high-performance-modular-web-server"
WORKFLOW="release.yml"

cd "$(dirname "$0")/.."
packages=$(node -e '
  const fs = require("node:fs");
  for (const dir of fs.readdirSync("packages")) {
    const file = `packages/${dir}/package.json`;
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!pkg.private) console.log(pkg.name);
  }')

for pkg in $packages; do
  echo "==> $pkg"
  pnpm dlx npm@11 trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes "$@"
  # The registry rate-limits trust changes; npm recommends spacing calls.
  sleep 2
done
