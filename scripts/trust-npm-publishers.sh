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
#
# Packages that already have a trusted publisher are skipped, so the script can
# be re-run after adding a package. To change an existing trust, revoke it first
# (`npm trust list <pkg>`, then `npm trust revoke <pkg> --id=<id>`).
#
# The script logs out of npm when it exits (also on failure or Ctrl-C), so the
# long-lived npm session token does not stay in ~/.npmrc. That also ends a
# session you had before running it; run `npm login` again if you need one.
set -euo pipefail

REPO="quinnjr/knead"
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
package_list=$(cd "$root" && node -e '
  const fs = require("node:fs");
  for (const dir of fs.readdirSync("packages")) {
    const file = `packages/${dir}/package.json`;
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!pkg.private) console.log(pkg.name);
  }')
packages=()
if [ -n "$package_list" ]; then mapfile -t packages <<<"$package_list"; fi
if [ "${#packages[@]}" -eq 0 ]; then
  echo "error: no public workspace packages found" >&2
  exit 1
fi

# Run npm outside pnpm's configuration: `pnpm run` exports its settings as
# npm_config_* variables (including a globalconfig pointing at pnpm's config),
# and npm warns about every key it does not know. npm also runs from an empty
# temporary directory, so no project-level config is picked up. The npm login
# in ~/.npmrc is still read.
while IFS= read -r var; do unset "$var"; done < <(env | grep -io '^npm_config_[^=]*' || true)
workdir="$(mktemp -d)"
npm11() { (cd "$workdir" && pnpm dlx "npm@$NPM_VERSION" "$@"); }
cleanup() {
  # Revoke the npm session token rather than leave it in ~/.npmrc.
  if npm11 logout >/dev/null 2>&1; then echo "logged out of npm" >&2; fi
  rm -rf "$workdir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! npm11 whoami >/dev/null 2>&1; then
  npm11 login
fi

for pkg in "${packages[@]}"; do
  echo "==> $pkg"
  # Re-running is safe: a package that already has a trusted publisher (any one) is skipped
  # instead of failing the run. `trust list --json` prints one object per configuration; a
  # failed lookup falls through to the create call, which reports the real error.
  if npm11 trust list "$pkg" --json 2>/dev/null | grep -q '"type"'; then
    echo "$pkg already has a trusted publisher, skipping"
    continue
  fi
  npm11 trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes \
    ${env_args[@]+"${env_args[@]}"} ${passthrough[@]+"${passthrough[@]}"}
  # The registry rate-limits trust changes; npm recommends spacing calls.
  sleep 2
done
