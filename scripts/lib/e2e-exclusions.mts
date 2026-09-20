import ts from 'typescript'
import { z } from 'zod'

export const exclusionRegistrySchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(
    z.strictObject({
      spec: z.string().regex(/^tests\/e2e\/.+\.e2e\.ts$/),
      category: z.enum(['quarantine', 'external-service', 'platform', 'environment']),
      reason: z.string().min(1),
      tracker: z.url().regex(/^https:\/\/github\.com\/copse-dev\/agent-pane\/issues\/[1-9]\d*$/),
      ownerRole: z.string().min(1),
      recordedOn: z.iso.date(),
      reviewBy: z.iso.date(),
      coverage: z.string().min(1),
      markers: z.array(z.string().min(1)).min(1),
    }),
  ),
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
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          variables.set(declaration.name.text, declaration.initializer)
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
      if (value && !seen.has(expression.text))
        return resolve(value, new Set([...seen, expression.text]))
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
    )
      return []
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
        found.push({ spec: file.fileName, marker: `${wrapper}: ${title.text}` })
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
        found.push({ spec: file.fileName, marker: `${receiver.getText(file)}.skip` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

export function validateExclusionRegistry(
  registry: ExclusionRegistry,
  actual: readonly Exclusion[],
  sourcePaths: ReadonlySet<string>,
  today: string,
): { errors: string[]; due: string[] } {
  const errors: string[] = []
  const due: string[] = []
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
    if (entry.reviewBy < entry.recordedOn)
      errors.push(`Review date precedes inventory date: ${entry.spec}`)
    if (entry.reviewBy <= today) due.push(entry.spec)
  }
  for (const spec of new Set(actual.map((item) => item.spec))) {
    if (!recorded.has(spec)) errors.push(`Unrecorded exclusion: ${spec}`)
  }
  return { errors, due }
}
