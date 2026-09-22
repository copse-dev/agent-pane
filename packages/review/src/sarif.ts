// SARIF 2.1.0 export (docs/plans/copse-reviewer.md, binding decision B9). The
// findings JSON stays the canonical contract; SARIF is the interchange form
// that GitHub code scanning and reviewdog consume. The finding identity rides
// in `partialFingerprints`, and evidence, provenance and verdict in each
// result's `properties` bag, so nothing the finding knows is lost in transit.
import type { Finding, FindingSeverity } from './finding.ts'
import { FINDING_CLASSES } from './finding.ts'

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
export const SARIF_VERSION = '2.1.0'
export const SARIF_TOOL_NAME = 'Copse Reviewer'

const RULE_DESCRIPTIONS: Record<(typeof FINDING_CLASSES)[number], string> = {
  build: 'The change breaks the build.',
  type: 'The change introduces a type error.',
  test: 'The change makes a test fail, or a test no longer exercises what it claims.',
  contract: 'The change breaks a contract between a caller and a callee.',
  security: 'The change introduces a security weakness.',
  concurrency: 'The change introduces a race, deadlock or ordering hazard.',
  resource: 'The change leaks or mishandles a resource.',
  'api-compat': 'The change is incompatible with an API its consumers rely on.',
}

const LEVEL: Record<FindingSeverity, 'note' | 'warning' | 'error'> = {
  low: 'note',
  medium: 'warning',
  high: 'error',
  critical: 'error',
}

export interface SarifOptions {
  readonly toolVersion: string
  /** Absolute repository root, emitted as the `%SRCROOT%` URI base. */
  readonly repositoryRoot?: string
  readonly headCommit?: string | null
}

export interface SarifLog {
  readonly $schema: string
  readonly version: string
  readonly runs: readonly Record<string, unknown>[]
}

function region(finding: Finding): Record<string, unknown> | undefined {
  if (finding.anchor.startLine === undefined) return undefined
  return {
    startLine: finding.anchor.startLine,
    endLine: finding.anchor.endLine ?? finding.anchor.startLine,
  }
}

export function toSarif(findings: readonly Finding[], options: SarifOptions): SarifLog {
  const results = findings.map((finding) => {
    const physicalLocation: Record<string, unknown> = {
      artifactLocation: { uri: finding.anchor.path, uriBaseId: 'SRCROOT' },
    }
    const reg = region(finding)
    if (reg !== undefined) physicalLocation['region'] = reg
    return {
      ruleId: finding.class,
      level: LEVEL[finding.severity],
      message: { text: finding.claim },
      locations: [{ physicalLocation }],
      partialFingerprints: { 'copse/findingId': finding.id },
      properties: {
        severity: finding.severity,
        confidence: finding.confidence,
        verdict: finding.verdict,
        provenance: finding.provenance,
        evidence: finding.evidence,
        ...(finding.remedy !== undefined ? { remedy: finding.remedy } : {}),
      },
    }
  })
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            version: options.toolVersion,
            informationUri:
              'https://github.com/copse-dev/agent-pane/blob/main/docs/plans/copse-reviewer.md',
            rules: FINDING_CLASSES.map((klass) => ({
              id: klass,
              name: klass,
              shortDescription: { text: RULE_DESCRIPTIONS[klass] },
            })),
          },
        },
        ...(options.repositoryRoot === undefined
          ? {}
          : {
              originalUriBaseIds: {
                SRCROOT: { uri: `file://${options.repositoryRoot.replace(/\/?$/, '/')}` },
              },
            }),
        ...(options.headCommit === undefined || options.headCommit === null
          ? {}
          : {
              versionControlProvenance: [
                { repositoryUri: 'file://.', revisionId: options.headCommit },
              ],
            }),
        results,
      },
    ],
  }
}
