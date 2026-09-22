import ts from 'typescript'

const EXECUTABLE_E2E_SOURCE = /^tests\/e2e\/.+\.(?:[cm]?ts|[cm]?js|json)$/
const EXECUTABLE_DEMO_SOURCE = /^tests\/demo\/.+\.(?:[cm]?ts|[cm]?js|json)$/
const EXECUTABLE_ACP_TEST_SOURCE = /^src\/main\/services\/acp\/.+\.test\.ts$/
const EXECUTABLE_BENCHMARK_PACK = /^benchmarks\/.+\.json$/
const TRANSCRIPT_MATCHER_SOURCE = 'tests/e2e/helpers/mock-content.ts'
const RETIRED_FIXTURE_APIS = new Set(['setMockScript', 'clearMockScript', 'MockScriptStep'])

/** Source files that may drive a model fixture and therefore cannot use the retired bridge. */
export function isExecutableMockFixturePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  if (normalized === TRANSCRIPT_MATCHER_SOURCE) return false
  return (
    EXECUTABLE_E2E_SOURCE.test(normalized) ||
    EXECUTABLE_DEMO_SOURCE.test(normalized) ||
    EXECUTABLE_ACP_TEST_SOURCE.test(normalized) ||
    EXECUTABLE_BENCHMARK_PACK.test(normalized)
  )
}

/** Legacy fixture-bridge APIs that are invalid in executable test source. */
export function mockFixtureSourceLeaks(source: string): string[] {
  const leaks = new Set<string>()
  const sourceFile = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, false)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && RETIRED_FIXTURE_APIS.has(node.text)) {
      leaks.add(node.text)
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      RETIRED_FIXTURE_APIS.has(node.argumentExpression.text)
    ) {
      leaks.add(node.argumentExpression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...leaks]
}
