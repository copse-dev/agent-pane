// Convert the frozen shell-scope inputs into `pnpm run eval:classifier`
// fixtures, so any classifier connection the eval runner speaks to (TypeSafe
// Jev, Kev, Winnow, reflex, decider, metask, SemIf …) answers the same 200
// commands without a per-model worker. State, question and options are copied
// verbatim from the frozen inputs; only the envelope changes, and the corpus
// label becomes the fixture's `expected` answer.
//
//   node benchmarks/shell-scope/scripts/classifier-fixtures.mjs          # write
//   node benchmarks/shell-scope/scripts/classifier-fixtures.mjs --check  # verify
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { corpus, inputSchema, safeJsonParse, decodeWithSchema, z } from './run.mjs'

export const QUESTION_ID = 'scope'
export const SPLITS = { dev: 'dev-inputs/dev.jsonl', holdout: 'holdout-inputs/dev.jsonl' }
export const PROMPTS = ['original', 'explicit']
export const output = resolve(corpus, 'classifier')

const caseSchema = z.looseObject({
  id: z.string(),
  label: z.enum(['sandbox', 'external']),
})
const datasetSchema = z.looseObject({ cases: z.array(caseSchema) })

/** One classifier fixture per frozen input row, grouped by prompt variant. */
export function toClassifierFixtures(inputRows, cases) {
  const labels = new Map(cases.map((entry) => [entry.id, entry.label]))
  const byPrompt = Object.fromEntries(PROMPTS.map((prompt) => [prompt, []]))
  for (const row of inputRows) {
    const input = inputSchema.parse(row)
    const [caseId = '', prompt = ''] = input.id.split('__')
    const label = labels.get(caseId)
    if (!label || !Object.hasOwn(byPrompt, prompt)) throw new Error(`Unlabelled input ${input.id}`)
    byPrompt[prompt].push({
      id: input.id,
      state: input.state,
      questions: {
        [QUESTION_ID]: {
          type: 'choice',
          instructions: input.question,
          options: Object.fromEntries(
            input.options.map((option) => [option.id, option.description]),
          ),
        },
      },
      expected: { [QUESTION_ID]: label },
    })
  }
  return byPrompt
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

/** Every fixture file's path and exact contents, derived from the committed inputs. */
export async function fixtureFiles() {
  const dataset = safeJsonParse(
    await readFile(resolve(corpus, 'corpus.jsonl'), 'utf8'),
    decodeWithSchema(datasetSchema),
  )
  const files = []
  for (const [split, file] of Object.entries(SPLITS)) {
    const fixtures = toClassifierFixtures(await readJsonl(resolve(corpus, file)), dataset.cases)
    for (const prompt of PROMPTS) {
      files.push({
        path: resolve(output, `${split}-${prompt}.jsonl`),
        text: fixtures[prompt].map((fixture) => JSON.stringify(fixture)).join('\n') + '\n',
      })
    }
  }
  return files
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check')
  const stale = []
  if (!check) await mkdir(output, { recursive: true })
  for (const file of await fixtureFiles()) {
    if (check) {
      const current = await readFile(file.path, 'utf8').catch(() => null)
      if (current !== file.text) stale.push(file.path)
    } else {
      await writeFile(file.path, file.text)
    }
  }
  if (stale.length) {
    console.error(`Stale classifier fixtures; regenerate them:\n${stale.join('\n')}`)
    return 1
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
