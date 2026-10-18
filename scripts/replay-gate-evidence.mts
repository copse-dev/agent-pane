/** Offline comparison of a durable run record with explicitly cited classifications. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from './lib/safe-json.mts'
import {
  planSchema,
  outcomeSchema,
  classificationSchema,
  compareOutcomes,
} from './lib/gate-evidence.mts'
const recordSchema = z.object({
  plan: planSchema,
  outcomes: z.array(outcomeSchema),
  sourceAttempt: z.string().regex(/^\d+$/).optional(),
})
const path = process.argv[2]
if (!path)
  throw new Error(
    'Usage: node scripts/replay-gate-evidence.mts <record.json> [classifications.json]',
  )
const record = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(recordSchema))
if (!record) throw new Error('Invalid durable evidence')
if (record.plan.shadowAvailable === false)
  throw new Error('No shadow selection was recorded; cannot replay misses')
const classificationPath = process.argv[3]
const classifications = classificationPath
  ? safeJsonParse(readFileSync(classificationPath, 'utf8'), decodeWithSchema(classificationSchema))
  : []
if (!classifications)
  throw new Error('Invalid classifications; each real/not-real decision needs an evidence URL')
for (const row of record.outcomes) {
  if (row.runId !== record.plan.runId || row.commit !== record.plan.commit)
    throw new Error('Outcome provenance mismatch')
}
console.log(
  JSON.stringify(
    {
      runId: record.plan.runId,
      runAttempt: record.sourceAttempt ?? record.plan.runAttempt,
      selectedSpecs: record.plan.proposed.specs,
      estimate: record.plan.estimate,
      ...compareOutcomes(
        record.plan,
        record.outcomes,
        classifications,
        Number(record.sourceAttempt ?? record.plan.runAttempt),
      ),
    },
    null,
    2,
  ),
)
