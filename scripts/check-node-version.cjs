const MIN_NODE = [22, 18, 0]

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
      'This project runs TypeScript .mts scripts directly during install, which requires Node 22.18+.',
      'Run `nvm use` from the repo root, or install Node 22.18.0+, then rerun `npm install`.',
    ].join('\n'),
  )
  process.exit(1)
}
