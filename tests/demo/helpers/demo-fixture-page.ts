import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

/**
 * Bundle `tests/demo/helpers/<name>.ts` beside the demo build and serve it from
 * a copy of the demo page. The entry installs its own demo API (for example one
 * whose trace pauses at a checkpoint) before loading the real renderer, so a
 * spec can hold a state without adding a product option. Returns the page URL.
 */
export async function buildDemoFixturePage(name: string): Promise<string> {
  await build({
    entryPoints: [`tests/demo/helpers/${name}.ts`],
    outfile: `dist/demo/${name}.js`,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    tsconfig: 'tsconfig.web.json',
    loader: { '.css': 'empty', '.ttf': 'dataurl' },
    define: {
      __COPSE_TEST_SCENARIOS__: 'true',
      __COPSE_BUILD_COMMIT__: JSON.stringify(name),
      __COPSE_BUILD_DIRTY__: 'false',
    },
  })
  const html = await readFile('dist/demo/index.html', 'utf8')
  const oldScript = '<script type="module" src="./app.js"></script>'
  assert.equal(html.split(oldScript).length, 2, 'expected exactly one renderer entry')
  await writeFile(
    `dist/demo/${name}.html`,
    html.replace(oldScript, `<script type="module" src="./${name}.js"></script>`),
  )
  return `/${name}.html`
}
