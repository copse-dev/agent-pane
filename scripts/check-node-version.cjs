const MIN_NODE = [24, 0, 0]

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

if (!isAtLeast(current, MIN_NODE)) {
  console.error(
    [
      `Node ${MIN_NODE.join('.')} or newer is required; current Node is ${process.versions.node}.`,
      '',
      'This project targets the Node 24 LTS line.',
      'Run `nvm install` / `nvm use` or `fnm install` / `fnm use` from the repo root, then rerun `pnpm install`.',
    ].join('\n'),
  )
  process.exit(1)
}
