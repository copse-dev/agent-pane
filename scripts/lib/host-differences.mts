// Known host differences: unit-test failures that come from the machine, not the diff.
//
// docs/host-environment-test-noise.md is the triage procedure; this is the
// subset precise enough to recognise automatically. An entry matches only on
// its platform, in its file, in its test (when named) and with its error shape,
// so the same test failing any other way still needs triage. Matching never
// changes the run's result: these tests still fail and still count.

export interface HostDifference {
  /** What differs on the host, as the triage page words it. */
  readonly reason: string
  readonly platform: NodeJS.Platform
  /** Source path of the test file, relative to the repo root. */
  readonly file: string
  /**
   * The full `suite > test` name. Omitted when the error shape alone is
   * diagnostic for every test in the file.
   */
  readonly test?: string
  /** Matched against the failure's message and its cause's message. */
  readonly error: RegExp
}

export const HOST_DIFFERENCES: readonly HostDifference[] = [
  {
    reason: 'macOS /bin/bash 3.2 treats an empty "${array[@]}" as unset under set -u',
    platform: 'darwin',
    file: 'scripts/ci-workflow-invariants.test.ts',
    test: 'ci.yml workflow invariants > compares the synthetic checked-out protocol against the supplied queue base',
    error: /\w+\[@\]: unbound variable/,
  },
  {
    reason: 'macOS /var is a symlink, and the review CLI refuses a symlinked output ancestor',
    platform: 'darwin',
    file: 'scripts/screenshot-review.test.ts',
    error: /Unsafe review directory: \/var\b/,
  },
  {
    reason: 'macOS /usr/bin/openssl is LibreSSL, whose verify error is worded differently',
    platform: 'darwin',
    file: 'src/main/services/mobile/mobile-certificate.test.ts',
    test: 'mobile certificate profile > issues an IP-only P-256 server leaf under a name-constrained root',
    error:
      /regular expression \/permitted subtree violation\/[\s\S]*Command failed: openssl verify/,
  },
  {
    reason: "macOS system Python 3.9's bundled pip predates pip install --dry-run",
    platform: 'darwin',
    file: 'src/main/project-sandbox/worktree-preparation-python.test.ts',
    test: 'installs a real hash-locked wheel through pip without running source builds',
    error: /Hash-locked Python dependencies: \S*\.venv\/bin\/python failed \(2\): Usage:/,
  },
]

export interface FailedTest {
  readonly path: string
  readonly name: string
  /** The failure's message and its cause's message, as reported. */
  readonly messages: readonly string[]
}

export function matchHostDifference(
  failure: FailedTest,
  platform: NodeJS.Platform,
  catalogue: readonly HostDifference[] = HOST_DIFFERENCES,
): HostDifference | undefined {
  return catalogue.find(
    (entry) =>
      entry.platform === platform &&
      entry.file === failure.path &&
      (entry.test === undefined || entry.test === failure.name) &&
      failure.messages.some((message) => entry.error.test(message)),
  )
}

export const HOST_NOISE_DOC = 'docs/host-environment-test-noise.md'

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
}

/**
 * The end-of-run failure summary, split into known host differences and the
 * rest. Empty when nothing failed.
 */
export function formatHostNoiseSummary(
  failures: readonly FailedTest[],
  platform: NodeJS.Platform,
  catalogue: readonly HostDifference[] = HOST_DIFFERENCES,
): string {
  if (failures.length === 0) return ''
  const known: string[] = []
  const triage: string[] = []
  for (const failure of failures) {
    const match = matchHostDifference(failure, platform, catalogue)
    const label = `${failure.path} > ${failure.name}`
    if (match) known.push(`  ${label}\n    ${match.reason}`)
    else triage.push(`  ${label}`)
  }
  const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`
  const host = PLATFORM_NAMES[platform] ?? platform
  const lines = [
    '',
    `[run-tests] ${count(failures.length, 'test')} failed. ${String(known.length)} match a known ${host} host difference; ${String(triage.length)} need triage.`,
  ]
  if (triage.length > 0) lines.push('[run-tests] Need triage:', ...triage)
  if (known.length > 0)
    lines.push(
      `[run-tests] Known host differences (still failures; see ${HOST_NOISE_DOC}):`,
      ...known,
    )
  if (triage.length > 0)
    lines.push(
      `[run-tests] Triage the rest with the procedure in ${HOST_NOISE_DOC} before calling them noise or yours.`,
    )
  return `${lines.join('\n')}\n`
}
