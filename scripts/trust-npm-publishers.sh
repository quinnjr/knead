#!/usr/bin/env bash
# Registers this repo's release workflow as the npm trusted publisher (OIDC)
# for every public workspace package, so CI can publish without an NPM_TOKEN.
#
# Run by a maintainer with npm 2FA (it logs in first if needed):
#   pnpm trust:npm --dry-run   # preview
#   pnpm trust:npm
#
# A package must already exist on the registry before a trusted publisher can
# be attached to it, so a brand-new package needs one manual first publish.
set -euo pipefail

REPO="quinnjr/high-performance-modular-web-server"
WORKFLOW="release.yml"

root="$(cd "$(dirname "$0")/.." && pwd)"
packages=$(cd "$root" && node -e '
  const fs = require("node:fs");
  for (const dir of fs.readdirSync("packages")) {
    const file = `packages/${dir}/package.json`;
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!pkg.private) console.log(pkg.name);
  }')

# Run npm outside pnpm's configuration: `pnpm run` exports its settings as
# npm_config_* variables (including a globalconfig pointing at pnpm's config),
# and the repo .npmrc holds pnpm-only keys. npm warns about every one of them.
# The npm login in ~/.npmrc is still read.
while IFS= read -r var; do unset "$var"; done < <(env | grep -io '^npm_config_[^=]*' || true)
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
npm11() { (cd "$workdir" && pnpm dlx npm@11 "$@"); }

if ! npm11 whoami >/dev/null 2>&1; then
  npm11 login
fi

for pkg in $packages; do
  echo "==> $pkg"
  npm11 trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes "$@"
  # The registry rate-limits trust changes; npm recommends spacing calls.
  sleep 2
done
