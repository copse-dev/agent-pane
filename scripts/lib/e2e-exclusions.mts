import ts from 'typescript'
import { z } from 'zod'

/** A quarantine is a short loan: at most this many days per record or renewal. */
export const MAX_QUARANTINE_DAYS = 14
/**
 * Non-quarantine exclusions never expire, but their last real pass goes stale.
 * Matches the 90-day retention of CI evidence artifacts, after which the linked
 * run usually no longer holds its outcomes.
 */
export const LAST_VERIFIED_WARN_DAYS = 90
const DAY_MS = 86_400_000
const issueUrl = z.url().regex(/^https:\/\/github\.com\/copse-dev\/agent-pane\/issues\/[1-9]\d*$/)
/** A GitHub login, never a role or an "assignment pending" placeholder. */
const githubLogin = z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i)

const common = {
  spec: z.string().regex(/^tests\/e2e\/.+\.e2e\.ts$/),
  reason: z.string().trim().min(1),
  tracker: issueUrl,
  ownerRole: z.string().min(1),
  recordedOn: z.iso.date(),
  coverage: z.string().min(1),
  markers: z.array(z.string().min(1)).min(1),
}

const quarantineEntrySchema = z.strictObject({
  ...common,
  category: z.literal('quarantine'),
  /** The accountable person; `null` records that nobody has accepted it yet. */
  owner: githubLogin.nullable(),
  reviewBy: z.iso.date(),
  /** At most one renewal. It needs a new reason and its own short deadline. */
  renewal: z
    .strictObject({
      renewedOn: z.iso.date(),
      reason: z.string().trim().min(1),
      reviewBy: z.iso.date(),
    })
    .optional(),
})

const standingEntrySchema = z.strictObject({
  ...common,
  category: z.enum(['external-service', 'platform', 'environment']),
  /** The last real on-device or real-service pass; `null` when none is recorded. */
  lastVerified: z
    .strictObject({
      on: z.iso.date(),
      evidence: z.url().regex(/^https:\/\/github\.com\/copse-dev\/agent-pane\//),
    })
    .nullable(),
})

export const exclusionRegistrySchema = z.strictObject({
  version: z.literal(2),
  entries: z.array(z.discriminatedUnion('category', [quarantineEntrySchema, standingEntrySchema])),
})

export type ExclusionRegistry = z.infer<typeof exclusionRegistrySchema>
export interface Exclusion {
  spec: string
  marker: string
}

/** Inventory conventional exclusions without importing WDIO or executing a spec. */
export function collectE2eExclusions(sources: ReadonlyMap<string, string>): Exclusion[] {
  const found: Exclusion[] = []
  for (const [path, text] of sources) {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    if (path.endsWith('.conf.ts')) {
      found.push(...configExclusions(file, sources))
    } else if (path.endsWith('.e2e.ts')) {
      found.push(...specExclusions(file))
    }
  }
  return found.sort((a, b) => a.spec.localeCompare(b.spec) || a.marker.localeCompare(b.marker))
}

function configExclusions(file: ts.SourceFile, sources: ReadonlyMap<string, string>): Exclusion[] {
  const variables = new Map<string, ts.Expression>()
  const inherited = new Set<string>()
  const exclusionBindings = new Set<string>()
  const staticReferences = new Set<ts.Node>()
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          variables.set(declaration.name.text, declaration.initializer)
          staticReferences.add(declaration.name)
        }
      }
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        sources.has(statement.moduleSpecifier.text.replace(/^\.\//, ''))
      ) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === 'config')
            inherited.add(binding.name.text)
        }
      }
    }
  }

  function resolve(expression: ts.Expression, seen = new Set<string>()): string[] {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return resolve(expression.expression, seen)
    }
    if (ts.isStringLiteral(expression)) {
      const spec = expression.text.replace(/^\.\//, '')
      if (!/^tests\/e2e\/[\w/.-]+\.e2e\.ts$/.test(spec)) {
        throw new Error(
          `${file.fileName}: exclude must name an exact e2e spec, found ${expression.text}`,
        )
      }
      return [spec]
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.flatMap((element) =>
        resolve(ts.isSpreadElement(element) ? element.expression : element, seen),
      )
    }
    if (ts.isIdentifier(expression)) {
      const value = variables.get(expression.text)
      if (value && !seen.has(expression.text)) {
        exclusionBindings.add(expression.text)
        staticReferences.add(expression)
        return resolve(value, new Set([...seen, expression.text]))
      }
    }
    // Inherited exclusions are inventoried in the imported config itself.
    // Only the explicit, existing `baseConfig.exclude ?? []` form is allowed.
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isPropertyAccessExpression(expression.left) &&
      expression.left.name.text === 'exclude' &&
      ts.isIdentifier(expression.left.expression) &&
      inherited.has(expression.left.expression.text) &&
      ts.isArrayLiteralExpression(expression.right) &&
      expression.right.elements.length === 0
    ) {
      staticReferences.add(expression.left)
      return []
    }
    throw new Error(`${file.fileName}: unsupported exclude expression: ${expression.getText(file)}`)
  }

  const found: Exclusion[] = []
  function visit(node: ts.Node): void {
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'exclude') {
      for (const spec of resolve(node.name))
        found.push({ spec, marker: `${file.fileName}: exclude` })
    }
    if (
      ts.isPropertyAssignment(node) &&
      (((ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === 'exclude') ||
        (ts.isComputedPropertyName(node.name) &&
          ts.isStringLiteralLike(node.name.expression) &&
          node.name.expression.text === 'exclude'))
    ) {
      for (const spec of resolve(node.initializer))
        found.push({ spec, marker: `${file.fileName}: exclude` })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  // Resolve the complete declaration graph first, then reject other uses of
  // those bindings. Following mutator names alone misses aliases and calls
  // that receive the array. Config property access is likewise only supported
  // in the inherited form resolved above; mutations must fail closed.
  function checkStaticReferences(node: ts.Node): void {
    const identifierUse =
      ts.isIdentifier(node) &&
      exclusionBindings.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    const propertyUse =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'exclude') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'exclude')
    const bindingName = ts.isBindingElement(node) ? (node.propertyName ?? node.name) : undefined
    const destructuredUse =
      bindingName &&
      (ts.isIdentifier(bindingName) || ts.isStringLiteralLike(bindingName)) &&
      bindingName.text === 'exclude'
    if ((identifierUse || propertyUse || destructuredUse) && !staticReferences.has(node))
      throw new Error(
        `${file.fileName}: exclude lists must be declared statically; unsupported use: ${node.getText(file)}`,
      )
    ts.forEachChild(node, checkStaticReferences)
  }
  checkStaticReferences(file)
  return found
}

function specExclusions(file: ts.SourceFile): Exclusion[] {
  const wrappers = new Map([
    ['describeSkipInCi', 'describeSkipInCi'],
    ['itSkipInCi', 'itSkipInCi'],
    ['xdescribe', 'xdescribe'],
    ['xit', 'xit'],
  ])
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      const original = (binding.propertyName ?? binding.name).text
      if (wrappers.has(original)) wrappers.set(binding.name.text, original)
    }
  }
  const found: Exclusion[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const wrapper = wrappers.get(node.expression.text)
      if (wrapper) {
        const title = node.arguments[0]
        if (!title || !ts.isStringLiteralLike(title))
          throw new Error(`${file.fileName}: ${wrapper} needs a literal title for exclusion review`)
        found.push({
          spec: file.fileName,
          marker: `${wrapper}: ${title.text}`,
        })
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'skip') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'skip')
    ) {
      const receiver = node.expression
      if (
        receiver.kind === ts.SyntaxKind.ThisKeyword ||
        (ts.isIdentifier(receiver) &&
          ['describe', 'it', 'context', 'specify', 'test'].includes(receiver.text))
      ) {
        found.push({
          spec: file.fileName,
          marker: `${receiver.getText(file)}.skip`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Only the CI config's exclude list keeps a quarantined spec runnable by the nightly job. */
export const QUARANTINE_MARKER = 'wdio.ci.conf.ts: exclude'

export interface ExclusionReport {
  /** Malformed or inconsistent records. Always fail. */
  errors: string[]
  /** Expired or unowned quarantines. Warn by default; fail in enforcing mode. */
  quarantine: string[]
  /** Stale or missing last-verified records. Always warnings. */
  stale: string[]
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS
}

export function validateExclusionRegistry(
  registry: ExclusionRegistry,
  actual: readonly Exclusion[],
  sourcePaths: ReadonlySet<string>,
  today: string,
): ExclusionReport {
  const errors: string[] = []
  const quarantine: string[] = []
  const stale: string[] = []
  const recorded = new Set<string>()
  for (const entry of registry.entries) {
    if (recorded.has(entry.spec)) errors.push(`Duplicate registry entry: ${entry.spec}`)
    recorded.add(entry.spec)
    if (!sourcePaths.has(entry.spec)) errors.push(`Missing spec: ${entry.spec}`)
    const markers = actual
      .filter((item) => item.spec === entry.spec)
      .map((item) => item.marker)
      .sort()
    if (JSON.stringify(markers) !== JSON.stringify([...entry.markers].sort()))
      errors.push(`Exclusions changed or removed: ${entry.spec}`)
    if (entry.recordedOn > today) errors.push(`Inventory date is in the future: ${entry.spec}`)
    if (entry.category === 'quarantine') {
      if (entry.markers.length !== 1 || entry.markers[0] !== QUARANTINE_MARKER)
        errors.push(
          `Quarantine must be exactly one ${QUARANTINE_MARKER} entry, not an in-spec skip: ${entry.spec}`,
        )
      const span = daysBetween(entry.recordedOn, entry.reviewBy)
      if (span < 0) errors.push(`Review date precedes inventory date: ${entry.spec}`)
      else if (span > MAX_QUARANTINE_DAYS)
        errors.push(
          `Quarantine review must be within ${String(MAX_QUARANTINE_DAYS)} days of recording: ${entry.spec}`,
        )
      const renewal = entry.renewal
      if (renewal) {
        if (renewal.renewedOn < entry.recordedOn)
          errors.push(`Renewal precedes inventory date: ${entry.spec}`)
        if (renewal.renewedOn > today) errors.push(`Renewal date is in the future: ${entry.spec}`)
        const renewedSpan = daysBetween(renewal.renewedOn, renewal.reviewBy)
        if (renewedSpan <= 0 || renewedSpan > MAX_QUARANTINE_DAYS)
          errors.push(
            `Renewed review must be 1-${String(MAX_QUARANTINE_DAYS)} days after renewal: ${entry.spec}`,
          )
        if (renewal.reason.trim() === entry.reason.trim())
          errors.push(`Renewal needs a new reason: ${entry.spec}`)
      }
      const deadline = renewal?.reviewBy ?? entry.reviewBy
      if (deadline <= today) quarantine.push(`Quarantine expired on ${deadline}: ${entry.spec}`)
      if (entry.owner === null) quarantine.push(`Quarantine has no named owner: ${entry.spec}`)
    } else if (entry.lastVerified === null) {
      stale.push(`No real pass recorded for ${entry.category} exclusion: ${entry.spec}`)
    } else if (entry.lastVerified.on > today) {
      errors.push(`Last-verified date is in the future: ${entry.spec}`)
    } else if (daysBetween(entry.lastVerified.on, today) > LAST_VERIFIED_WARN_DAYS) {
      stale.push(
        `Last real pass ${entry.lastVerified.on} is older than ${String(LAST_VERIFIED_WARN_DAYS)} days: ${entry.spec}`,
      )
    }
  }
  for (const spec of new Set(actual.map((item) => item.spec))) {
    if (!recorded.has(spec)) errors.push(`Unrecorded exclusion: ${spec}`)
  }
  return { errors, quarantine, stale }
}

export type ExclusionCheckMode = 'warn' | 'enforce'

/** PR prechecks warn on quarantine policy; the nightly run and release gate enforce it. */
export function exclusionCheckFails(report: ExclusionReport, mode: ExclusionCheckMode): boolean {
  return report.errors.length > 0 || (mode === 'enforce' && report.quarantine.length > 0)
}
