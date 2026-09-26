#!/usr/bin/env bash
# Stage 0 for CI grounding, with pull-request code running as a dedicated
# unprivileged user rather than as the runner user.
#
# The runner user owns everything a later step executes with the job's Actions
# runtime token: the downloaded actions under _work/_actions (upload-artifact,
# checkout's post step), the GITHUB_ENV/GITHUB_PATH command files, and the node
# toolcache. It also has passwordless sudo. Pull-request code running as that
# user could rewrite any of them, or read the token from a later step, and so
# write the Actions cache in the default branch's scope. `permissions: {}` does
# not remove that token. A separate user with no sudo, no docker group and no
# access to the runner's home cannot reach any of them.
#
# Run as the runner user, after every trusted setup step, from the trusted
# default-branch checkout. Inputs come from the environment:
#   PR_NUMBER, HEAD_SHA, BASE_REF  resolved by the trusted trigger
#   OUT_DIR                        where report.json lands, owned by the runner
set -euo pipefail

[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
git check-ref-format --branch "$BASE_REF" >/dev/null

cell_user=copse-cell
cell_home="/home/${cell_user}"
trusted=/opt/copse-review
store=/opt/copse-review-store
runner_user="$(id -un)"
setup_node_bin="$(dirname "$(command -v node)")"
cell_path="${setup_node_bin}:/usr/bin:/bin"

# Everything the runner later executes or reads back must sit under its home,
# which the cell user will not be able to traverse.
for path in "$GITHUB_WORKSPACE" "$RUNNER_TEMP" "$OUT_DIR"; do
  case "$(realpath -m "$path")" in
    "$HOME"/*) ;;
    *)
      echo "::error::${path} is outside ${HOME}; the review cell could reach it"
      exit 1
      ;;
  esac
done
case "$setup_node_bin" in
  "$HOME"/*)
    echo "::error::node at ${setup_node_bin} would be unreachable by the review cell"
    exit 1
    ;;
esac

sudo useradd --create-home --home-dir "$cell_home" --shell /bin/bash --user-group "$cell_user"
sudo chmod 0700 "$HOME"
if sudo -u "$cell_user" test -r "$GITHUB_WORKSPACE"; then
  echo "::error::the review cell can still read the runner's workspace"
  exit 1
fi
if sudo -l -U "$cell_user" 2>/dev/null | grep -q 'may run'; then
  echo "::error::the review cell user has sudo rights"
  exit 1
fi

# The reviewer the cell runs: a root-owned, read-only copy of the trusted
# checkout, including its --ignore-scripts install.
sudo mkdir -p "$trusted"
sudo rsync -a --delete --exclude=/.git "$GITHUB_WORKSPACE/" "$trusted/"
sudo chown -R root:root "$trusted"
sudo chmod -R a+rX,go-w "$trusted"

# The dependency store Stage 0 installs from offline: primed by the runner from
# data-only lockfile inputs at the exact head, readable but not writable by the
# cell. `pnpm fetch` ignores manifests and never runs lifecycle scripts.
dependency_seed="$RUNNER_TEMP/copse-review-dependencies"
mkdir -p "$dependency_seed"
git -C "$GITHUB_WORKSPACE" fetch --no-tags --quiet origin \
  "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/${PR_NUMBER}"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse "refs/remotes/pr/${PR_NUMBER}")" = "$HEAD_SHA"
git -C "$GITHUB_WORKSPACE" show "${HEAD_SHA}:pnpm-lock.yaml" > "$dependency_seed/pnpm-lock.yaml"
if git -C "$GITHUB_WORKSPACE" cat-file -e "${HEAD_SHA}:patches" 2>/dev/null; then
  git -C "$GITHUB_WORKSPACE" archive --format=tar "$HEAD_SHA" patches |
    tar -xf - -C "$dependency_seed"
fi
sudo install -d -o "$runner_user" -m 0755 "$store"
pnpm fetch --frozen-lockfile --dir "$dependency_seed" --store-dir "$store"
chmod -R a+rX,go-w "$store"

as_cell() {
  sudo -u "$cell_user" -- env -i \
    HOME="$cell_home" \
    PATH="$cell_path" \
    LANG=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "$@"
}

# The cell's own clone and corepack cache; nothing of the runner's is shared.
as_cell bash -c 'cd "$1" && corepack prepare --activate >/dev/null' _ "$trusted"
as_cell git clone --quiet --filter=blob:none --no-checkout \
  "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git" "$cell_home/repo"
as_cell git -C "$cell_home/repo" fetch --no-tags --quiet origin \
  "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/${PR_NUMBER}" \
  "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"
test "$(as_cell git -C "$cell_home/repo" rev-parse "refs/remotes/pr/${PR_NUMBER}")" = "$HEAD_SHA"
as_cell mkdir -p "$cell_home/scratch" "$cell_home/out"

# Findings never affect the exit code; a refused execution (3) or an
# undetectable project (2) does, and then there is no ground to upload.
status=0
as_cell bash -c 'cd "$1" && shift && exec node "$@"' _ "$cell_home/repo" \
  "$trusted/packages/review/bin/copse-review.mjs" \
  --foreign \
  --head "refs/remotes/pr/${PR_NUMBER}" \
  --base "origin/${BASE_REF}" \
  --backend ephemeral-runner \
  --scratch-parent "$cell_home/scratch" \
  --store "$store" \
  --trusted-prepare "$trusted/scripts/prepare-review-stage0.mts" \
  --no-model \
  --json "$cell_home/out/report.json" || status=$?

# Nothing of the cell may outlive this step: lock the account so cron and at
# cannot start it again, then kill every process it still owns.
sudo usermod --lock --expiredate 1 "$cell_user"
sudo pkill -KILL -u "$cell_user" || true
for _ in $(seq 1 50); do
  pgrep -u "$cell_user" >/dev/null || break
  sleep 0.1
done
if pgrep -u "$cell_user" >/dev/null; then
  echo "::error::processes of ${cell_user} survived SIGKILL"
  exit 1
fi

if [[ "$status" -ne 0 ]]; then exit "$status"; fi

# Read the report back only as a regular file at its exact path, now that
# nothing can swap it for a link to a file of the runner's.
report="$cell_home/out/report.json"
if [[ "$(sudo realpath -e "$report")" != "$report" ]] || ! sudo test -f "$report"; then
  echo "::error::the review report is not a regular file"
  exit 1
fi
mkdir -p "$OUT_DIR"
sudo cat "$report" > "$OUT_DIR/report.json"
