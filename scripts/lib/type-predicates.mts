/**
 * Find every hand-written type predicate in the tracked source.
 *
 * A type predicate is the one claim TypeScript never checks: nothing verifies
 * that `x is T` follows from the body, so `return true` compiles and every
 * caller is lied to (#1330, and the "Exported type predicates must be tested"
 * section of `docs/type-safety.md`). `no-unsafe-type-assertion` does not flag
 * them, and with the suppression baseline empty they are the widest unverified
 * assertions left in the codebase — which is why they get counted.
 *
 * Only the **asserted** form is reported. The distinction is syntactic, and it
 * is the whole point of the inventory:
 *
 * - **asserted** — the predicate annotates a function-like that has a body, so
 *   the body is taken on trust:
 *   `function isFoo(v: unknown): v is Foo { … }`
 *
 * - **checked** — the predicate sits in a type position, where the compiler
 *   verifies whatever satisfies it:
 *   `const isFoo: (v: unknown) => v is Foo = (v) => typeof v === 'string'`
 *   infers the arrow's own predicate and reports TS2677 if the body stops
 *   proving the claim. An interface or a `.d.ts` signature is the same case:
 *   there is no body there to lie, and an implementation that annotates gets
 *   counted at its own site.
 *
 * Inferred predicates — an arrow with no annotation at all — are not predicates
 * in the AST, so they never appear here. That is correct: the compiler derived
 * them, so there is nothing to audit.
 *
 * Consumed by `scripts/type-predicate-inventory.test.ts`.
 */

import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** Label used for a predicate with no name of its own (an inline `.filter(…)`). */
export const ANONYMOUS = '(anonymous)'

export interface AssertedPredicate {
  /** Repo-relative path. */
  readonly file: string
  /** The declaration's name, or {@link ANONYMOUS}. */
  readonly name: string
  /** 1-based line of the predicate, for the failure message. */
  readonly line: number
  /** `asserts x is T` rather than `x is T`. */
  readonly asserts: boolean
}

/**
 * Source the inventory covers: tracked TypeScript that ships or runs, minus the
 * tests. Test files are excluded because a predicate in a test lies only to the
 * test — the same reason `check-dead-code.mts` treats them as roots rather than
 * candidates. `tests/` (e2e), fixture repos and prototypes are not project code.
 */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.mts'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => !/\.test\.(ts|mts)$/.test(file))
    .filter((file) => !/^(tests|prototypes|vendor)\//.test(file))
    .filter((file) => !/^benchmarks\/(steer\/)?fixtures\//.test(file))
    .sort()
}

/**
 * The four function-likes that can both return a type predicate and carry a
 * body. Spelled out rather than reached through `ts.isFunctionLike`, whose
 * `SignatureDeclaration` result covers the bodiless call/construct signatures
 * too and so has no `body` to test.
 */
type PredicateOwner =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction

/** The owning declaration when it has a body, else null. */
function withBody(node: ts.Node): PredicateOwner | null {
  const owner =
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
      ? node
      : null
  return owner !== null && owner.body !== undefined ? owner : null
}

/** The name to record for the function-like a predicate annotates. */
function declarationName(node: PredicateOwner, sourceFile: ts.SourceFile): string {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText(sourceFile)
  }
  // An arrow (or unnamed function expression) bound straight to a name reads as
  // that name; anything else is genuinely anonymous.
  const { parent } = node
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sourceFile)
  }
  return ANONYMOUS
}

/** Every asserted predicate in one file, in source order. */
export function assertedPredicatesIn(file: string, text: string): AssertedPredicate[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: AssertedPredicate[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypePredicateNode(node)) {
      // A body is what separates the asserted form from the checked one: a
      // signature in a type position has none, so there is nothing at that site
      // to take on trust. `owner.type === node` keeps a predicate nested inside
      // a parameter's own type from being read as the outer function's return.
      const owner = withBody(node.parent)
      if (owner !== null && owner.type === node) {
        found.push({
          file,
          name: declarationName(owner, sourceFile),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          asserts: node.assertsModifier !== undefined,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** Every asserted predicate in the tracked source, grouped by file. */
export function assertedPredicateInventory(): Map<string, string[]> {
  const inventory = new Map<string, string[]>()
  for (const file of trackedSourceFiles()) {
    const predicates = assertedPredicatesIn(file, readFileSync(file, 'utf8'))
    if (predicates.length === 0) continue
    inventory.set(file, predicates.map((predicate) => predicate.name).sort())
  }
  return inventory
}
