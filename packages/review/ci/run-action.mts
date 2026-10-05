import { main } from '../src/cli.ts'
import { actionPublishingFetch, decodeActionRequest } from './action-policy.mts'

const request = decodeActionRequest(process.env['COPSE_REVIEW_REQUEST'] ?? '')
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    controller.abort()
  })
}
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
  signal: controller.signal,
  fetch: actionPublishingFetch(request, process.env['COPSE_REVIEW_READ_TOKEN'] ?? ''),
})
