#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${GITLEAKS_VERSION:?GITLEAKS_VERSION must be set}"
: "${GITLEAKS_LINUX_X64_SHA256:?GITLEAKS_LINUX_X64_SHA256 must be set}"

archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
path="${RUNNER_TEMP}/${archive}"
download() {
  curl --disable --fail --location --retry 3 \
    --connect-timeout 10 --max-time 30 --retry-max-time 60 \
    --output "${path}" "$@"
}

if ! download "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"; then
  printf 'Direct Gitleaks download failed; fetching the official release asset API.\n' >&2
  # Immutable Linux x64 asset for 8.30.1; both routes use the same checksum below.
  download \
    -H 'Accept: application/octet-stream' \
    https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058
fi

printf '%s  %s\n' "${GITLEAKS_LINUX_X64_SHA256}" "${path}" | sha256sum --check --strict
tar -xzf "${path}" -C "${RUNNER_TEMP}" gitleaks
"${RUNNER_TEMP}/gitleaks" version
