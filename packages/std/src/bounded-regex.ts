import { createContext, Script } from 'node:vm'
import { isRecord } from './unknown-value.ts'

/**
 * Match an untrusted regular expression against subjects under a wall-clock
 * budget. JavaScript's backtracking engine has no step limit, so a pattern such
 * as `(a+)+$` against a short non-matching line runs for minutes on the calling
 * thread. Running the loop through `node:vm` with a `timeout` lets V8 interrupt
 * the match when the budget is spent.
 *
 * Returns the indexes of matching subjects (stopping after `limit` matches), or
 * `'timeout'` when the budget ran out first. Pass a regex without the `g` or `y`
 * flag: `test` on those is stateful across subjects.
 */
export function matchingIndexesWithin(
  regex: RegExp,
  subjects: readonly string[],
  opts: { timeoutMs: number; limit?: number },
): number[] | 'timeout' {
  boundedContext['regex'] = regex
  boundedContext['subjects'] = subjects
  boundedContext['limit'] = opts.limit ?? subjects.length
  try {
    const result: unknown = matchScript.runInContext(boundedContext, {
      timeout: Math.max(1, Math.ceil(opts.timeoutMs)),
    })
    // Copy into this realm: the vm array carries the context's own Array.prototype.
    return Array.isArray(result)
      ? Array.from(result).filter((index) => typeof index === 'number')
      : []
  } catch (error) {
    if (isScriptTimeout(error)) return 'timeout'
    throw error
  } finally {
    boundedContext['regex'] = null
    boundedContext['subjects'] = null
  }
}

/** Whether `regex` matches `subject`, or `'timeout'` when the budget ran out first. */
export function regexTestWithin(
  regex: RegExp,
  subject: string,
  timeoutMs: number,
): boolean | 'timeout' {
  const result = matchingIndexesWithin(regex, [subject], { timeoutMs, limit: 1 })
  return result === 'timeout' ? 'timeout' : result.length > 0
}

const boundedContext = createContext({ regex: null, subjects: null, limit: 0 })

const matchScript = new Script(`
  (() => {
    const hits = []
    for (let i = 0; i < subjects.length && hits.length < limit; i++) {
      if (regex.test(subjects[i])) hits.push(i)
    }
    return hits
  })()
`)

function isScriptTimeout(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}
