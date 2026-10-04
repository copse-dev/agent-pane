'use strict'

// Inject GitHub's CLI response at the executable boundary. The native tools,
// real local commit, thread store and IPC all run unchanged; no network writes.
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('gh version 2.80.0 (local provenance fixture)')
} else if (args[0] === 'auth' && args[1] === 'status') {
  console.log('Logged in to github.com as provenance-fixture')
} else if (args[0] === 'pr' && args[1] === 'view') {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  console.log(
    JSON.stringify({
      number: 1001,
      title: 'Native provenance fixture',
      url: 'https://github.com/acme/widgets/pull/1001',
      state: 'OPEN',
      headRefName: 'work',
      baseRefName: 'main',
      commits: [{ oid: sha }, { oid: 'f'.repeat(40) }],
    }),
  )
} else {
  console.error(`Unexpected fixture gh command: ${args.join(' ')}`)
  process.exitCode = 1
}
