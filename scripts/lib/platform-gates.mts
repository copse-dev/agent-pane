import ts from 'typescript'

/**
 * Host-platform gates in unit tests (docs/testing-strategy.md#unit-tier-platform-inventory).
 *
 * Every required unit job runs on Linux, so a test gated to another platform
 * is verified only where that platform's lane runs. Two shapes hide that from
 * a Linux run and are ratcheted by check:flake-risks:
 *
 * - an early `return` behind a host-platform `if` in a test body, which
 *   passes instead of reporting a skip;
 * - a `describe` skipped on a darwin or linux condition, whose tests are
 *   never registered on that host, so the run reports `skipped 0`.
 *
 * The preferred per-test `{ skip: cond && 'reason' }` is not ratcheted: it is
 * reported as a skip and counted in the printed inventory instead.
 *
 * The scan reads the AST only. A gate behind an imported predicate or a
 * runtime capability probe is invisible to it.
 */

export const HOST_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type HostPlatform = (typeof HOST_PLATFORMS)[number]

export interface PlatformGateSite {
  rule: 'unit-platform-early-return' | 'unit-platform-suite-skip'
  node: ts.Node
  /** Replaces the node snippet in the report. */
  text?: string
}

/** Tests registered in one file that run on exactly one host platform. */
export type PlatformInventory = Partial<Record<HostPlatform, number>>

const TEST_NAMES = new Set(['it', 'test'])
const SUITE_NAMES = new Set(['describe', 'suite'])
const OS_MODULES = new Set(['node:os', 'os'])

interface Context {
  file: ts.SourceFile
  /** Local names bound to `platform` from node:os. */
  platformFns: Set<string>
  /** Namespace/default imports of node:os. */
  osNamespaces: Set<string>
  /** `const` initializers by name, so `const isMac = process.platform === 'darwin'` resolves. */
  constants: Map<string, ts.Expression>
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

function context(file: ts.SourceFile): Context {
  const ctx: Context = {
    file,
    platformFns: new Set(),
    osNamespaces: new Set(),
    constants: new Map(),
  }
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    if (!OS_MODULES.has(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) ctx.osNamespaces.add(clause.name.text)
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) ctx.osNamespaces.add(named.name.text)
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if ((element.propertyName ?? element.name).text === 'platform')
          ctx.platformFns.add(element.name.text)
      }
    }
  }
  forEachDescendant(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
    )
      ctx.constants.set(node.name.text, node.initializer)
  })
  return ctx
}

/** `process.platform`, `os.platform()` or an imported `platform()`. */
function isPlatformRead(expression: ts.Expression, ctx: Context): boolean {
  const node = strip(expression)
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'platform'
  )
    return true
  if (!ts.isCallExpression(node) || node.arguments.length > 0) return false
  const callee = strip(node.expression)
  if (ts.isIdentifier(callee)) return ctx.platformFns.has(callee.text)
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    ctx.osNamespaces.has(callee.expression.text) &&
    callee.name.text === 'platform'
  )
}

/** True when `expression` reads the host platform, through local `const` aliases. */
function readsPlatform(expression: ts.Node, ctx: Context, seen = new Set<string>()): boolean {
  if (ts.isFunctionLike(expression)) return false
  if (ts.isExpression(expression) && isPlatformRead(expression, ctx)) return true
  if (ts.isIdentifier(expression)) {
    const init = ctx.constants.get(expression.text)
    if (init && !seen.has(expression.text)) {
      seen.add(expression.text)
      return readsPlatform(init, ctx, seen)
    }
    return false
  }
  return (
    ts.forEachChild(expression, (child) => readsPlatform(child, ctx, seen) || undefined) ?? false
  )
}

type Tri = boolean | undefined

/**
 * Evaluate `expression` as if the host were `platform`: true or false when
 * it is decided by the platform and literals, undefined when anything else
 * (an environment probe, a variable) decides it.
 */
function evaluate(
  expression: ts.Expression,
  platform: HostPlatform,
  ctx: Context,
  seen = new Set<string>(),
): Tri | string {
  const node = strip(expression)
  if (isPlatformRead(node, ctx)) return platform
  if (ts.isStringLiteralLike(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return false
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return false
    const init = ctx.constants.get(node.text)
    if (!init || seen.has(node.text)) return undefined
    seen.add(node.text)
    return evaluate(init, platform, ctx, seen)
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = truthy(evaluate(node.operand, platform, ctx, seen))
    return value === undefined ? undefined : !value
  }
  if (ts.isConditionalExpression(node)) {
    const condition = truthy(evaluate(node.condition, platform, ctx, seen))
    if (condition === undefined) return undefined
    return evaluate(condition ? node.whenTrue : node.whenFalse, platform, ctx, seen)
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    ) {
      const left = evaluate(node.left, platform, ctx, seen)
      const leftTruthy = truthy(left)
      const and = operator === ts.SyntaxKind.AmpersandAmpersandToken
      // `false && x` and `true || x` are decided by the left side alone.
      if (leftTruthy === !and) return left
      const right = evaluate(node.right, platform, ctx, seen)
      if (leftTruthy === undefined) {
        const rightTruthy = truthy(right)
        if (and && rightTruthy === false) return false
        if (!and && rightTruthy === true) return right
        return undefined
      }
      return right
    }
    const equal =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken
    const notEqual =
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    if (equal || notEqual) {
      const left = evaluate(node.left, platform, ctx, seen)
      const right = evaluate(node.right, platform, ctx, seen)
      if (typeof left !== 'string' || typeof right !== 'string') return undefined
      return equal ? left === right : left !== right
    }
    return undefined
  }
  // `['darwin', 'linux'].includes(process.platform)`
  if (ts.isCallExpression(node) && node.arguments.length === 1) {
    const callee = strip(node.expression)
    const argument = node.arguments[0]
    const list = ts.isPropertyAccessExpression(callee) ? strip(callee.expression) : undefined
    if (
      argument &&
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'includes' &&
      list &&
      ts.isArrayLiteralExpression(list) &&
      isPlatformRead(argument, ctx)
    ) {
      if (!list.elements.every((element) => ts.isStringLiteralLike(element))) return undefined
      return list.elements.some(
        (element) => ts.isStringLiteralLike(element) && element.text === platform,
      )
    }
  }
  return undefined
}

function truthy(value: Tri | string): Tri {
  if (typeof value === 'string') return value !== ''
  return value
}

/** The platforms a `skip` value (or skip-guard condition) lets the test run on; a probe-dependent value may run anywhere. */
function runsOn(skip: ts.Expression, ctx: Context): Set<HostPlatform> {
  const platforms = new Set<HostPlatform>()
  for (const platform of HOST_PLATFORMS) {
    if (truthy(evaluate(skip, platform, ctx)) !== true) platforms.add(platform)
  }
  return platforms
}

interface Registration {
  kind: 'test' | 'suite'
  call: ts.CallExpression
  /** The `skip` option, when it reads the host platform. */
  gate?: ts.Expression
  body?: ts.FunctionLikeDeclaration
}

function registrationKind(call: ts.CallExpression): 'test' | 'suite' | undefined {
  let callee = strip(call.expression)
  // `it.only`, `describe.skip`, ...
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression))
    callee = callee.expression
  if (!ts.isIdentifier(callee)) return undefined
  if (TEST_NAMES.has(callee.text)) return 'test'
  if (SUITE_NAMES.has(callee.text)) return 'suite'
  return undefined
}

function optionsObject(
  argument: ts.Expression,
  ctx: Context,
): ts.ObjectLiteralExpression | undefined {
  const node = strip(argument)
  if (ts.isObjectLiteralExpression(node)) return node
  if (ts.isIdentifier(node)) {
    const init = ctx.constants.get(node.text)
    const value = init ? strip(init) : undefined
    if (value && ts.isObjectLiteralExpression(value)) return value
  }
  return undefined
}

function skipOption(call: ts.CallExpression, ctx: Context): ts.Expression | undefined {
  for (const argument of call.arguments) {
    const options = optionsObject(argument, ctx)
    if (!options) continue
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === 'skip'
      )
        return property.initializer
    }
  }
  return undefined
}

function registration(node: ts.Node, ctx: Context): Registration | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const kind = registrationKind(node)
  if (!kind) return undefined
  const skip = skipOption(node, ctx)
  let body: ts.ArrowFunction | ts.FunctionExpression | undefined
  for (const argument of node.arguments.map(strip)) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      body = argument
      break
    }
  }
  return {
    kind,
    call: node,
    ...(skip && readsPlatform(skip, ctx) ? { gate: skip } : {}),
    ...(body ? { body } : {}),
  }
}

/** Tests registered inside `suite`, counted once per call site. */
function countTests(suite: ts.Node, ctx: Context): number {
  let count = 0
  forEachDescendant(suite, (node) => {
    if (registration(node, ctx)?.kind === 'test') count++
  })
  return count
}

function containsReturn(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true
  if (ts.isFunctionLike(node)) return false
  return ts.forEachChild(node, (child) => containsReturn(child) || undefined) ?? false
}

/** A `.skip(...)` call (t.skip, context.skip), outside nested functions. */
function callsSkip(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'skip'
  )
    return true
  return ts.forEachChild(node, (child) => callsSkip(child) || undefined) ?? false
}

/** `if (<host platform>) { … return }` in a test body without a `t.skip()`. */
function earlyReturns(body: ts.FunctionLikeDeclaration, ctx: Context): ts.IfStatement[] {
  const found: ts.IfStatement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isIfStatement(node) && readsPlatform(node.expression, ctx)) {
      const branches = node.elseStatement
        ? [node.thenStatement, node.elseStatement]
        : [node.thenStatement]
      if (branches.some((branch) => containsReturn(branch) && !callsSkip(branch))) found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  if (body.body) ts.forEachChild(body.body, visit)
  return found
}

/**
 * Conditions of `if (<host platform>) { t.skip(...); return }` guards at the
 * top level of a test body: a reported skip, so not ratcheted, but counted.
 */
function skipGuards(body: ts.FunctionLikeDeclaration, ctx: Context): ts.Expression[] {
  if (!body.body || !ts.isBlock(body.body)) return []
  return body.body.statements.flatMap((statement) =>
    ts.isIfStatement(statement) &&
    readsPlatform(statement.expression, ctx) &&
    callsSkip(statement.thenStatement) &&
    containsReturn(statement.thenStatement)
      ? [statement.expression]
      : [],
  )
}

function intersect(
  allowed: ReadonlySet<HostPlatform>,
  own: ReadonlySet<HostPlatform>,
): Set<HostPlatform> {
  return new Set([...allowed].filter((platform) => own.has(platform)))
}

export interface PlatformGateScan {
  sites: PlatformGateSite[]
  inventory: PlatformInventory
}

/** Ratcheted platform-gate sites and the single-platform test inventory of one unit test file. */
export function scanPlatformGates(file: ts.SourceFile): PlatformGateScan {
  const ctx = context(file)
  const sites: PlatformGateSite[] = []
  const inventory: PlatformInventory = {}
  const visit = (node: ts.Node, allowed: ReadonlySet<HostPlatform>): void => {
    const found = registration(node, ctx)
    if (!found) {
      ts.forEachChild(node, (child) => {
        visit(child, allowed)
      })
      return
    }
    let here: ReadonlySet<HostPlatform> = allowed
    if (found.gate) {
      const own = runsOn(found.gate, ctx)
      here = intersect(allowed, own)
      if (found.kind === 'suite' && (!own.has('darwin') || !own.has('linux'))) {
        const hidden = HOST_PLATFORMS.filter(
          (platform) => !own.has(platform) && platform !== 'win32',
        )
        const name = found.call.arguments[0]
        const label = name && ts.isStringLiteralLike(name) ? `'${name.text}'` : 'suite'
        const tests = countTests(found.call, ctx)
        sites.push({
          rule: 'unit-platform-suite-skip',
          node: found.call,
          text: `describe(${label}) hides ${String(tests)} test${tests === 1 ? '' : 's'} on ${hidden.join(' and ')} instead of reporting a skip`,
        })
      }
    }
    if (found.kind === 'test') {
      if (found.body) {
        for (const guard of skipGuards(found.body, ctx)) here = intersect(here, runsOn(guard, ctx))
      }
      const [only] = here
      if (here.size === 1 && only) inventory[only] = (inventory[only] ?? 0) + 1
      if (found.body) {
        for (const statement of earlyReturns(found.body, ctx))
          sites.push({
            rule: 'unit-platform-early-return',
            node: statement.expression,
          })
      }
    }
    ts.forEachChild(found.call, (child) => {
      visit(child, here)
    })
  }
  visit(file, new Set(HOST_PLATFORMS))
  return { sites, inventory }
}

/** `darwin-only: 34 tests in 15 files (a.test.ts 15, ...)`, one line per platform. */
export function formatPlatformInventory(
  inventories: ReadonlyMap<string, PlatformInventory>,
): string[] {
  const labels: Record<HostPlatform, string> = {
    darwin: 'darwin-only',
    linux: 'Linux-only',
    win32: 'Windows-only',
  }
  return HOST_PLATFORMS.map((platform) => {
    const files = [...inventories]
      .map(([file, counts]) => [file, counts[platform] ?? 0] as const)
      .filter(([, count]) => count > 0)
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    const total = files.reduce((sum, [, count]) => sum + count, 0)
    const detail = files.map(([file, count]) => `${file} ${String(count)}`).join(', ')
    return `${labels[platform]}: ${String(total)} test${total === 1 ? '' : 's'} in ${String(files.length)} file${files.length === 1 ? '' : 's'}${detail ? ` (${detail})` : ''}`
  })
}
