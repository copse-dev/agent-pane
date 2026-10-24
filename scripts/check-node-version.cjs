// The first release of each supported line with the 2026-10-21 security fixes,
// which include CVE-2026-111497 (code execution through crafted Brotli input).
// Odd lines got no fix; a major newer than every entry shipped after them.
const FIXED_RELEASES = [
  [24, 22, 1],
  [26, 12, 1],
]

function parseVersion(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10))
}

function isAtLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    const current = version[i] ?? 0
    const required = minimum[i] ?? 0
    if (current > required) return true
    if (current < required) return false
  }
  return true
}

const current = parseVersion(process.versions.node)
const fixedOnLine = FIXED_RELEASES.find(([major]) => major === current[0])
const newestLine = FIXED_RELEASES[FIXED_RELEASES.length - 1][0]
const supported = fixedOnLine ? isAtLeast(current, fixedOnLine) : current[0] > newestLine

if (!supported) {
  console.error(
    [
      `Node ${process.versions.node} is not supported: use 24.22.1+ on the 24 line, 26.12.1+ on the 26 line, or a newer major.`,
      '',
      'Earlier releases lack the fix for CVE-2026-111497 (Brotli decoder remote code execution).',
      'This project targets the Node 24 LTS line.',
      'Run `nvm install` / `nvm use` or `fnm install` / `fnm use` from the repo root, then rerun `pnpm install`.',
    ].join('\n'),
  )
  process.exit(1)
}
