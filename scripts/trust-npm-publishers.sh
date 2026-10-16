#!/usr/bin/env bash
# Registers this repo's release workflow as the npm trusted publisher (OIDC)
# for every public workspace package, so CI can publish without an NPM_TOKEN.
#
# Run by a maintainer with npm 2FA (it logs in first if needed):
#   pnpm trust:npm --dry-run              # preview
#   pnpm trust:npm
#   pnpm trust:npm --env npm-publish      # trust only jobs in that GitHub environment
#
# Other arguments (e.g. --dry-run) are passed through to `npm trust github`.
#
# A package must already exist on the registry before a trusted publisher can
# be attached to it, so a brand-new package needs one manual first publish.
set -euo pipefail

REPO="quinnjr/high-performance-modular-web-server"
WORKFLOW="release.yml"
# Exact npm version, so the trust call is reproducible.
NPM_VERSION="11.21.0"

env_args=()
passthrough=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env | --environment)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == -* ]]; then
        echo "error: $1 needs an environment name" >&2
        exit 2
      fi
      env_args=(--env "$2")
      shift 2
      ;;
    --env=* | --environment=*)
      name="${1#*=}"
      if [ -z "$name" ]; then
        echo "error: ${1%%=*} needs an environment name" >&2
        exit 2
      fi
      env_args=(--env "$name")
      shift
      ;;
    *)
      passthrough+=("$1")
      shift
      ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC2016 # JavaScript template literal, not a shell expansion
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
npm11() { (cd "$workdir" && pnpm dlx "npm@$NPM_VERSION" "$@"); }

if ! npm11 whoami >/dev/null 2>&1; then
  npm11 login
fi

for pkg in $packages; do
  echo "==> $pkg"
  npm11 trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes \
    ${env_args[@]+"${env_args[@]}"} ${passthrough[@]+"${passthrough[@]}"}
  # The registry rate-limits trust changes; npm recommends spacing calls.
  sleep 2
done
