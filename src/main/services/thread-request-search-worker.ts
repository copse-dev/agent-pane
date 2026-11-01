import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { PromptSearchIndex } from '@copse/thread-store/prompt-search.ts'
import {
  requestSearchCommandSchema,
  type RequestSearchReply,
} from '@shared/thread-request-search.ts'

const { root } = z.object({ root: z.string() }).parse(workerData)
const index = new PromptSearchIndex(root)
const port = parentPort
if (port === null) throw new Error('Request search requires a worker port')
let latestSearch = 0
let chain = Promise.resolve()

port.on('message', (raw: unknown) => {
  const command = requestSearchCommandSchema.parse(raw)
  if (command.kind !== 'refresh') latestSearch = command.id
  if (command.kind === 'cancel') return
  const generation = latestSearch
  chain = chain.then(async () => {
    const current = (): boolean => latestSearch === generation
    let reply: RequestSearchReply
    try {
      const result = current()
        ? await index.search(
            command.projectId,
            command.kind === 'search' ? command.query : '',
            current,
          )
        : { matches: [], incomplete: false }
      reply = { id: command.id, ...result }
    } catch (error) {
      reply = {
        id: command.id,
        matches: [],
        incomplete: true,
        error: error instanceof Error ? error.message : 'Request search failed',
      }
    }
    port.postMessage(reply)
  })
})
