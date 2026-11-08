import ts from 'typescript'
import { z } from 'zod'

/**
 * Static flake-risk ratchet (docs/testing-strategy.md#flake-risk-ratchet).
 *
 * Each rule counts known flake risks per file. The committed baseline records
 * today's counts; a file may only go down, a new file must be at zero, and a
 * decrease must lower the baseline in the same PR. The scanner reads the
 * TypeScript AST; it never executes a test.
 */
export const FLAKE_RISK_BASELINE_PATH = 'scripts/flake-risk-baseline.json'

export const FLAKE_RULES = [
  'e2e-fixed-pause',
  'unit-wall-clock-sleep',
  'e2e-checkout-seed',
  'e2e-fixed-port',
] as const
export type FlakeRule = (typeof FLAKE_RULES)[number]

/** The preferred alternative each finding prints. */
export const FLAKE_RULE_ADVICE: Readonly<Record<FlakeRule, string>> = {
  'e2e-fixed-pause':
    'wait on the condition instead (browser.waitUntil, element waitFor*, or a pause inside a loop bounded by a Date.now() deadline)',
  'unit-wall-clock-sleep':
    'use node:test mock.timers (mock.timers.enable / mock.timers.tick) or await the event itself; a 0 ms yield is not counted',
  'e2e-checkout-seed':
    'seed seedStableWorkspace() or a temp repo instead of the shared checkout (process.cwd())',
  'e2e-fixed-port': 'listen on port 0 and read server.address().port',
}

export interface FlakeFinding {
  rule: FlakeRule
  file: string
  line: number
  text: string
}

const countsSchema = z.record(z.string().min(1), z.int().positive())
export const flakeRiskBaselineSchema = z.strictObject({
  version: z.literal(1),
  rules: z.strictObject({
    'e2e-fixed-pause': countsSchema,
    'unit-wall-clock-sleep': countsSchema,
    'e2e-checkout-seed': countsSchema,
    'e2e-fixed-port': countsSchema,
  }),
})
export type FlakeRiskBaseline = z.infer<typeof flakeRiskBaselineSchema>

export function isUnitTestPath(path: string): boolean {
  return path.endsWith('.test.ts') && !path.startsWith('tests/e2e/')
}

export function isE2ePath(path: string): boolean {
  return path.startsWith('tests/e2e/') && path.endsWith('.ts')
}

/** Every flake-risk finding in one file; files outside both scopes yield none. */
export function scanFlakeRisks(path: string, text: string): FlakeFinding[] {
  const unit = isUnitTestPath(path)
  const e2e = isE2ePath(path)
  if (!unit && !e2e) return []
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: FlakeFinding[] = []
  const report = (rule: FlakeRule, node: ts.Node): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    const snippet = node.getText(file).replace(/\s+/g, ' ')
    found.push({
      rule,
      file: path,
      line: line + 1,
      text: snippet.length > 80 ? `${snippet.slice(0, 77)}...` : snippet,
    })
  }
  const bindings = collectBindings(file)
  if (e2e) {
    scanPauses(file, bindings, report)
    scanCheckoutSeeds(file, bindings, report)
    scanFixedPorts(file, report)
  }
  if (unit) scanSleeps(file, bindings, report)
  return found.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

interface Bindings {
  /** Local names bound to `browser` from `@wdio/globals` (or the WDIO global). */
  browser: Set<string>
  /** Local names bound to `browser.pause` by destructuring. */
  pause: Set<string>
  /** Local names bound to `setTimeout` from `node:timers/promises`. */
  timerSleep: Set<string>
  /** Namespace/default imports of `node:timers/promises`. */
  timerNamespaces: Set<string>
  /** Local names imported from the e2e seed helpers whose original name starts with `seed`. */
  seeders: Set<string>
  /** Namespace imports of the e2e seed helpers. */
  seedNamespaces: Set<string>
  /** `const x = process.cwd()` names. */
  checkoutAliases: Set<string>
  /** Local functions whose result is a wall-clock sleep promise. */
  sleepHelpers: Map<string, ts.SignatureDeclaration>
}

const TIMER_MODULES = new Set(['node:timers/promises', 'timers/promises'])

function isSeedModule(specifier: string): boolean {
  return /(^|\/)seed-config(\.ts)?$/.test(specifier)
}

function strip(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function forEachDescendant(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child)
    forEachDescendant(child, visit)
  })
}

function collectBindings(file: ts.SourceFile): Bindings {
  const bindings: Bindings = {
    browser: new Set(),
    pause: new Set(),
    timerSleep: new Set(),
    timerNamespaces: new Set(),
    seeders: new Set(),
    seedNamespaces: new Set(),
    checkoutAliases: new Set(),
    sleepHelpers: new Map(),
  }
  let importsBrowserName = false
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (!clause) continue
    const named = clause.namedBindings
    if (
      clause.name?.text === 'browser' ||
      (named && ts.isNamespaceImport(named) && named.name.text === 'browser')
    )
      importsBrowserName = true
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const original = (element.propertyName ?? element.name).text
        const local = element.name.text
        if (local === 'browser') importsBrowserName = true
        if (specifier === '@wdio/globals' && original === 'browser') bindings.browser.add(local)
        if (TIMER_MODULES.has(specifier) && original === 'setTimeout')
          bindings.timerSleep.add(local)
        if (isSeedModule(specifier) && original.startsWith('seed')) bindings.seeders.add(local)
      }
    }
    const namespace = named && ts.isNamespaceImport(named) ? named.name.text : clause.name?.text
    if (namespace && TIMER_MODULES.has(specifier)) bindings.timerNamespaces.add(namespace)
    if (namespace && isSeedModule(specifier)) bindings.seedNamespaces.add(namespace)
  }
  // Without a shadowing import, `browser` is the WDIO global.
  if (!importsBrowserName) bindings.browser.add('browser')
  // seed-config.ts declares its own seeders.
  if (/(^|\/)seed-config\.ts$/.test(file.fileName)) {
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text.startsWith('seed'))
        bindings.seeders.add(statement.name.text)
    }
  }

  forEachDescendant(file, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = strip(node.initializer)
      if (ts.isIdentifier(node.name)) {
        const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
        if (ts.isIdentifier(init) && bindings.browser.has(init.text))
          bindings.browser.add(node.name.text)
        if (isConst && isProcessCwd(init)) bindings.checkoutAliases.add(node.name.text)
        if (
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          returnedSleep(init, bindings)
        )
          bindings.sleepHelpers.set(node.name.text, init)
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isIdentifier(init) &&
        bindings.browser.has(init.text)
      ) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name
          if (
            ts.isIdentifier(property) &&
            property.text === 'pause' &&
            ts.isIdentifier(element.name)
          )
            bindings.pause.add(element.name.text)
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && returnedSleep(node, bindings))
      bindings.sleepHelpers.set(node.name.text, node)
  })
  return bindings
}

function isProcessCwd(expression: ts.Expression): boolean {
  const node = strip(expression)
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'cwd'
  )
}

function memberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return expression.argumentExpression.text
  return undefined
}

function memberObject(expression: ts.Expression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    return strip(expression.expression)
  return undefined
}

// --- e2e-fixed-pause -------------------------------------------------------

function isPauseCall(call: ts.CallExpression, bindings: Bindings): boolean {
  const callee = strip(call.expression)
  if (ts.isIdentifier(callee)) return bindings.pause.has(callee.text)
  const object = memberObject(callee)
  return (
    memberName(callee) === 'pause' &&
    object !== undefined &&
    ts.isIdentifier(object) &&
    bindings.browser.has(object.text)
  )
}

function isTimeRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = strip(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false
  const owner = callee.expression.text
  return (owner === 'Date' || owner === 'performance') && callee.name.text === 'now'
}

const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])

/** True when `node` reads the clock outside nested functions. */
function readsClock(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false
  return (
    isTimeRead(node) || (ts.forEachChild(node, (child) => readsClock(child) || undefined) ?? false)
  )
}

/** True when `root` (outside nested functions) compares a clock read: a deadline. */
function comparesClock(root: ts.Node): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      if (readsClock(node)) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(root, visit)
  return found
}

/**
 * A pause is a poll interval when an enclosing loop in the same function is
 * bounded by a deadline: its condition or body compares `Date.now()` (or
 * `performance.now()`). A loop bounded only by an attempt count is not.
 */
function insideDeadlineLoop(node: ts.Node): boolean {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current)) return false
    if (ts.isIterationStatement(current, false) && comparesClock(current)) return true
  }
  return false
}

function scanPauses(
  file: ts.SourceFile,
  bindings: Bindings,
  report: (rule: FlakeRule, node: ts.Node) => void,
): void {
  forEachDescendant(file, (node) => {
    if (ts.isCallExpression(node) && isPauseCall(node, bindings) && !insideDeadlineLoop(node))
      report('e2e-fixed-pause', node)
  })
}

// --- e2e-checkout-seed -----------------------------------------------------

function isSeedCall(call: ts.CallExpression, bindings: Bindings): boolean {
  const callee = strip(call.expression)
  if (ts.isIdentifier(callee)) return bindings.seeders.has(callee.text)
  const object = memberObject(callee)
  const name = memberName(callee)
  return (
    name !== undefined &&
    name.startsWith('seed') &&
    object !== undefined &&
    ts.isIdentifier(object) &&
    bindings.seedNamespaces.has(object.text)
  )
}

function scanCheckoutSeeds(
  file: ts.SourceFile,
  bindings: Bindings,
  report: (rule: FlakeRule, node: ts.Node) => void,
): void {
  forEachDescendant(file, (node) => {
    if (!ts.isCallExpression(node) || !isSeedCall(node, bindings)) return
    const first = node.arguments[0]
    if (!first) return
    const target = strip(first)
    if (
      isProcessCwd(target) ||
      (ts.isIdentifier(target) && bindings.checkoutAliases.has(target.text))
    )
      report('e2e-checkout-seed', node)
  })
}

// --- e2e-fixed-port --------------------------------------------------------

function fixedPort(expression: ts.Expression | undefined): boolean {
  if (!expression) return false
  const node = strip(expression)
  if (!ts.isNumericLiteral(node)) return false
  const value = Number(node.text.replaceAll('_', ''))
  return Number.isInteger(value) && value > 0 && value <= 65_535
}

function portProperty(argument: ts.Expression): ts.Expression | undefined {
  const node = strip(argument)
  if (!ts.isObjectLiteralExpression(node)) return undefined
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'port'
    )
      return property.initializer
  }
  return undefined
}

const SERVER_CALLEE = /^(listen|serve|start|create)/i

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = strip(call.expression)
  return ts.isIdentifier(callee) ? callee.text : memberName(callee)
}

function scanFixedPorts(
  file: ts.SourceFile,
  report: (rule: FlakeRule, node: ts.Node) => void,
): void {
  forEachDescendant(file, (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name === undefined) return
      const [first] = node.arguments
      if (name === 'listen' && fixedPort(first)) {
        report('e2e-fixed-port', node)
        return
      }
      if (SERVER_CALLEE.test(name) && node.arguments.some((arg) => fixedPort(portProperty(arg))))
        report('e2e-fixed-port', node)
      return
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /(^|_)PORT$|Port$|^port$/.test(node.name.text) &&
      fixedPort(node.initializer)
    )
      report('e2e-fixed-port', node)
  })
}

// --- unit-wall-clock-sleep -------------------------------------------------

/** The delay a sleep waits for; `null` when the delay argument is missing. */
interface SleepDelay {
  delay: ts.Expression | null
}

function isGlobalSetTimeout(expression: ts.Expression): boolean {
  const callee = strip(expression)
  if (ts.isIdentifier(callee)) return callee.text === 'setTimeout'
  const object = memberObject(callee)
  return (
    memberName(callee) === 'setTimeout' &&
    object !== undefined &&
    ts.isIdentifier(object) &&
    ['globalThis', 'window', 'global'].includes(object.text)
  )
}

function callsIdentifier(root: ts.Node, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found = true
    else ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** `new Promise((resolve) => setTimeout(resolve, delay))` and equivalents. */
function promiseTimeout(node: ts.NewExpression): SleepDelay | null {
  const callee = strip(node.expression)
  if (!ts.isIdentifier(callee) || callee.text !== 'Promise') return null
  const executor = node.arguments?.[0] ? strip(node.arguments[0]) : undefined
  if (!executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return null
  const param = executor.parameters[0]
  if (!param || !ts.isIdentifier(param.name)) return null
  const resolve = param.name.text
  let result: SleepDelay | null = null
  const visit = (child: ts.Node): void => {
    if (result) return
    if (ts.isCallExpression(child) && isGlobalSetTimeout(child.expression)) {
      const handler = child.arguments[0] ? strip(child.arguments[0]) : undefined
      const resolves =
        handler !== undefined &&
        ((ts.isIdentifier(handler) && handler.text === resolve) ||
          ((ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
            callsIdentifier(handler.body, resolve)))
      if (resolves) {
        result = { delay: child.arguments[1] ?? null }
        return
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(executor.body)
  return result
}

function sleepOf(expression: ts.Expression, bindings: Bindings): SleepDelay | null {
  const node = strip(expression)
  if (ts.isNewExpression(node)) return promiseTimeout(node)
  if (!ts.isCallExpression(node)) return null
  const callee = strip(node.expression)
  if (ts.isIdentifier(callee)) {
    if (bindings.timerSleep.has(callee.text)) return { delay: node.arguments[0] ?? null }
    const helper = bindings.sleepHelpers.get(callee.text)
    if (helper) return helperDelay(helper, node, bindings)
    return null
  }
  const object = memberObject(callee)
  if (
    memberName(callee) === 'setTimeout' &&
    object !== undefined &&
    ts.isIdentifier(object) &&
    bindings.timerNamespaces.has(object.text)
  )
    return { delay: node.arguments[0] ?? null }
  return null
}

/** The sleep a helper returns (expression body, or a `return`), without awaiting it. */
function returnedSleep(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  bindings: Bindings,
): SleepDelay | null {
  if (!fn.body) return null
  if (!ts.isBlock(fn.body)) return sleepOf(fn.body, bindings)
  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression)
      return sleepOf(statement.expression, bindings)
  }
  return null
}

/** Map a helper's delay parameter to the call's argument (or the parameter default). */
function helperDelay(
  helper: ts.SignatureDeclaration,
  call: ts.CallExpression,
  bindings: Bindings,
): SleepDelay | null {
  if (
    !(
      ts.isFunctionDeclaration(helper) ||
      ts.isArrowFunction(helper) ||
      ts.isFunctionExpression(helper)
    )
  )
    return null
  const inner = returnedSleep(helper, bindings)
  if (!inner) return null
  const delay = inner.delay ? strip(inner.delay) : null
  if (delay && ts.isIdentifier(delay)) {
    const index = helper.parameters.findIndex(
      (param) => ts.isIdentifier(param.name) && param.name.text === delay.text,
    )
    if (index >= 0) {
      return { delay: call.arguments[index] ?? helper.parameters[index]?.initializer ?? null }
    }
  }
  return { delay }
}

/** A missing or literal-zero delay is an event-loop yield, not a wall-clock wait. */
function isYield(delay: ts.Expression | null): boolean {
  if (delay === null) return true
  const node = strip(delay)
  return ts.isNumericLiteral(node) && Number(node.text) === 0
}

function scanSleeps(
  file: ts.SourceFile,
  bindings: Bindings,
  report: (rule: FlakeRule, node: ts.Node) => void,
): void {
  forEachDescendant(file, (node) => {
    if (!ts.isAwaitExpression(node)) return
    const sleep = sleepOf(node.expression, bindings)
    if (sleep && !isYield(sleep.delay)) report('unit-wall-clock-sleep', node)
  })
}

// --- baseline --------------------------------------------------------------

export type FlakeCounts = Record<FlakeRule, Map<string, number>>

export function countFindings(findings: readonly FlakeFinding[]): FlakeCounts {
  const counts = emptyCounts()
  for (const finding of findings) {
    const rule = counts[finding.rule]
    rule.set(finding.file, (rule.get(finding.file) ?? 0) + 1)
  }
  return counts
}

function emptyCounts(): FlakeCounts {
  return {
    'e2e-fixed-pause': new Map(),
    'unit-wall-clock-sleep': new Map(),
    'e2e-checkout-seed': new Map(),
    'e2e-fixed-port': new Map(),
  }
}

function baselineCounts(baseline: FlakeRiskBaseline, rule: FlakeRule): Map<string, number> {
  return new Map(Object.entries(baseline.rules[rule]))
}

export interface CountChange {
  rule: FlakeRule
  file: string
  observed: number
  allowed: number
}

export interface BaselineComparison {
  /** Files with more findings than the baseline allows (new files allow zero). */
  added: CountChange[]
  /** Files with fewer findings than recorded: lower the baseline in this PR. */
  stale: CountChange[]
}

/** Compare the tree's findings with the committed baseline. */
export function compareWithBaseline(
  baseline: FlakeRiskBaseline,
  findings: readonly FlakeFinding[],
): BaselineComparison {
  const observed = countFindings(findings)
  const added: CountChange[] = []
  const stale: CountChange[] = []
  for (const rule of FLAKE_RULES) {
    const allowed = baselineCounts(baseline, rule)
    const seen = observed[rule]
    for (const file of [...new Set([...allowed.keys(), ...seen.keys()])].sort()) {
      const change = { rule, file, observed: seen.get(file) ?? 0, allowed: allowed.get(file) ?? 0 }
      if (change.observed > change.allowed) added.push(change)
      else if (change.observed < change.allowed) stale.push(change)
    }
  }
  return { added, stale }
}

/**
 * Where the head baseline tolerates more than the base did. A key the base
 * lacks is growth unless git reports it as the rename of a base key the head
 * baseline dropped, carrying no more than that key allowed.
 */
export function flakeBaselineGrowth(
  base: FlakeRiskBaseline,
  head: FlakeRiskBaseline,
  renames: ReadonlyMap<string, string> = new Map(),
): string[] {
  const problems: string[] = []
  for (const rule of FLAKE_RULES) {
    const before = baselineCounts(base, rule)
    const after = baselineCounts(head, rule)
    for (const [file, count] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
      const previous = before.get(file)
      if (previous !== undefined) {
        if (count > previous)
          problems.push(`${rule}: ${file} grew from ${String(previous)} to ${String(count)}`)
        continue
      }
      const origin = renames.get(file)
      const originCount = origin === undefined ? undefined : before.get(origin)
      if (
        origin !== undefined &&
        originCount !== undefined &&
        !after.has(origin) &&
        count <= originCount
      )
        continue
      problems.push(
        `${rule}: ${file} is new to the baseline with ${String(count)}; new files start at zero`,
      )
    }
  }
  return problems
}

export function baselineFromFindings(findings: readonly FlakeFinding[]): FlakeRiskBaseline {
  const counts = countFindings(findings)
  const rule = (name: FlakeRule): Record<string, number> =>
    Object.fromEntries([...counts[name]].sort(([a], [b]) => a.localeCompare(b)))
  return {
    version: 1,
    rules: {
      'e2e-fixed-pause': rule('e2e-fixed-pause'),
      'unit-wall-clock-sleep': rule('unit-wall-clock-sleep'),
      'e2e-checkout-seed': rule('e2e-checkout-seed'),
      'e2e-fixed-port': rule('e2e-fixed-port'),
    },
  }
}

export function formatFlakeRiskBaseline(baseline: FlakeRiskBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`
}
