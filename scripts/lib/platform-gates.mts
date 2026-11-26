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
 * - a `describe` skipped on a darwin or linux condition, or tests registered
 *   inside a platform `if`/`?:`/`&&` (or after a suite-level platform
 *   `return`): they are never registered on that host, so the run reports
 *   `skipped 0`.
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
  /** For a platform-selected alias (`const d = isMac ? describe : describe.skip`), where it registers live tests and where it registers nothing. */
  alias?: { runs: Set<HostPlatform>; unregistered: Set<HostPlatform> }
}

interface Callee {
  kind: 'test' | 'suite'
  /** False for `.skip`/`.todo`: the tests are registered but reported skipped. */
  live: boolean
}

/** `it`, `describe`, `it.only`, `describe.skip`, ... */
function directCallee(expression: ts.Expression): Callee | undefined {
  let callee = strip(expression)
  let live = true
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    live = callee.name.text !== 'skip' && callee.name.text !== 'todo'
    callee = callee.expression
  }
  if (!ts.isIdentifier(callee)) return undefined
  if (TEST_NAMES.has(callee.text)) return { kind: 'test', live }
  if (SUITE_NAMES.has(callee.text)) return { kind: 'suite', live }
  return undefined
}

function registrationKind(call: ts.CallExpression): 'test' | 'suite' | undefined {
  return directCallee(call.expression)?.kind
}

/** A local `const` that selects a registration function by host platform. */
function platformAlias(
  call: ts.CallExpression,
  ctx: Context,
): (Callee & { runs: Set<HostPlatform>; unregistered: Set<HostPlatform> }) | undefined {
  const callee = strip(call.expression)
  if (!ts.isIdentifier(callee)) return undefined
  const init = ctx.constants.get(callee.text)
  const selector = init ? strip(init) : undefined
  if (!selector || !ts.isConditionalExpression(selector)) return undefined
  if (!readsPlatform(selector.condition, ctx)) return undefined
  const whenTrue = directCallee(selector.whenTrue)
  const whenFalse = directCallee(selector.whenFalse)
  const kind = whenTrue?.kind ?? whenFalse?.kind
  if (!kind) return undefined
  const runs = new Set<HostPlatform>()
  const unregistered = new Set<HostPlatform>()
  for (const platform of HOST_PLATFORMS) {
    const decided = truthy(evaluate(selector.condition, platform, ctx))
    const chosen = decided === undefined ? undefined : decided ? whenTrue : whenFalse
    if (decided === undefined || chosen?.live) runs.add(platform)
    if (decided !== undefined && !chosen) unregistered.add(platform)
  }
  return { kind, live: true, runs, unregistered }
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
  const alias = registrationKind(node) ? undefined : platformAlias(node, ctx)
  const kind = registrationKind(node) ?? alias?.kind
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
    ...(alias ? { alias: { runs: alias.runs, unregistered: alias.unregistered } } : {}),
  }
}

/** Tests registered at or inside `suite`, counted once per call site. */
function countTests(suite: ts.Node, ctx: Context): number {
  let count = registration(suite, ctx)?.kind === 'test' ? 1 : 0
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

/** `return` or a block with a top-level `return`: exits whenever the branch runs. */
function returnsUnconditionally(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true
  return ts.isBlock(statement) && statement.statements.some((child) => ts.isReturnStatement(child))
}

function isSkipCall(expression: ts.Expression): boolean {
  const node = strip(expression)
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'skip'
  )
}

/**
 * The branch always reports a skip: a top-level `t.skip(...)` statement (or
 * `return t.skip(...)`) before any other `return` or `throw`. A skip behind a
 * further condition, or after the branch exits, does not count.
 */
function callsSkip(branch: ts.Statement): boolean {
  const statements = ts.isBlock(branch) ? branch.statements : [branch]
  for (const statement of statements) {
    if (ts.isExpressionStatement(statement) && isSkipCall(statement.expression)) return true
    if (ts.isReturnStatement(statement)) {
      return statement.expression !== undefined && isSkipCall(statement.expression)
    }
    // Anything after a throw is unreachable.
    if (ts.isThrowStatement(statement)) return false
  }
  return false
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
  /** Tests under `region` that a platform condition leaves unregistered on darwin or linux. */
  const conditional = (
    region: ts.Node,
    condition: ts.Expression,
    narrowed: ReadonlySet<HostPlatform>,
    allowed: ReadonlySet<HostPlatform>,
  ): void => {
    const hidden = HOST_PLATFORMS.filter(
      (platform) => platform !== 'win32' && allowed.has(platform) && !narrowed.has(platform),
    )
    if (hidden.length === 0) return
    const tests = countTests(region, ctx)
    if (tests === 0) return
    const snippet = condition.getText(file).replace(/\s+/g, ' ')
    const label = snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet
    sites.push({
      rule: 'unit-platform-suite-skip',
      node: condition,
      text: `registering under (${label}) hides ${String(tests)} test${tests === 1 ? '' : 's'} on ${hidden.join(' and ')} instead of reporting a skip`,
    })
  }
  /** Platforms where `condition` is not decided false (or, with `negate`, not decided true). */
  const whereTrue = (condition: ts.Expression, negate: boolean): Set<HostPlatform> =>
    new Set(
      HOST_PLATFORMS.filter(
        (platform) => truthy(evaluate(condition, platform, ctx)) !== (negate ? true : false),
      ),
    )
  const branch = (
    region: ts.Node | undefined,
    condition: ts.Expression,
    negate: boolean,
    allowed: ReadonlySet<HostPlatform>,
  ): void => {
    if (!region) return
    const narrowed = intersect(allowed, whereTrue(condition, negate))
    conditional(region, condition, narrowed, allowed)
    visit(region, narrowed)
  }
  const visit = (node: ts.Node, allowed: ReadonlySet<HostPlatform>): void => {
    const found = registration(node, ctx)
    if (!found) {
      // `if (<platform>) { it(...) }`, `<platform> ? it(...) : ...` and `<platform> && it(...)`.
      if (ts.isIfStatement(node) && readsPlatform(node.expression, ctx)) {
        visit(node.expression, allowed)
        branch(node.thenStatement, node.expression, false, allowed)
        branch(node.elseStatement, node.expression, true, allowed)
        return
      }
      if (ts.isConditionalExpression(node) && readsPlatform(node.condition, ctx)) {
        visit(node.condition, allowed)
        branch(node.whenTrue, node.condition, false, allowed)
        branch(node.whenFalse, node.condition, true, allowed)
        return
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        readsPlatform(node.left, ctx)
      ) {
        visit(node.left, allowed)
        branch(
          node.right,
          node.left,
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken,
          allowed,
        )
        return
      }
      // `if (<platform>) return` in a suite or module: later siblings register only where it is false.
      if (ts.isBlock(node) || ts.isSourceFile(node)) {
        let here = allowed
        for (const statement of node.statements) {
          visit(statement, here)
          if (
            ts.isIfStatement(statement) &&
            !statement.elseStatement &&
            readsPlatform(statement.expression, ctx) &&
            returnsUnconditionally(statement.thenStatement) &&
            countTests(statement.thenStatement, ctx) === 0
          ) {
            const rest = node.statements.slice(node.statements.indexOf(statement) + 1)
            const narrowed = intersect(here, whereTrue(statement.expression, true))
            const hidden = rest.reduce((sum, next) => sum + countTests(next, ctx), 0)
            if (hidden > 0) {
              const tests = HOST_PLATFORMS.filter(
                (platform) => platform !== 'win32' && here.has(platform) && !narrowed.has(platform),
              )
              if (tests.length > 0) {
                const snippet = statement.expression.getText(file).replace(/\s+/g, ' ')
                const label = snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet
                sites.push({
                  rule: 'unit-platform-suite-skip',
                  node: statement.expression,
                  text: `returning on (${label}) hides ${String(hidden)} later test${hidden === 1 ? '' : 's'} on ${tests.join(' and ')} instead of reporting a skip`,
                })
              }
            }
            here = narrowed
          }
        }
        return
      }
      ts.forEachChild(node, (child) => {
        visit(child, allowed)
      })
      return
    }
    let here: ReadonlySet<HostPlatform> = allowed
    if (found.alias) {
      here = intersect(here, found.alias.runs)
      const hidden = HOST_PLATFORMS.filter(
        (platform) =>
          platform !== 'win32' && allowed.has(platform) && found.alias?.unregistered.has(platform),
      )
      const tests = countTests(found.call, ctx)
      if (hidden.length > 0 && tests > 0) {
        const callee = found.call.expression.getText(file)
        sites.push({
          rule: 'unit-platform-suite-skip',
          node: found.call,
          text: `${callee}(...) registers nothing on ${hidden.join(' and ')}, hiding ${String(tests)} test${tests === 1 ? '' : 's'} instead of reporting a skip`,
        })
      }
    }
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
