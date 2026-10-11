import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Stand-ins for `git` and `python3`, so "Download and run" can be exercised end
 * to end without a network, a 12 GB download or a model. They are small Node
 * scripts placed on a PATH that holds nothing else; the product runs them
 * exactly as it would the real tools, and has no idea they are fakes.
 *
 * Behaviour is chosen through the environment the app is started with:
 *
 * - `FAKE_LOG`: file every call is appended to.
 * - `FAKE_GIT_MODE`: `offline` (clone cannot resolve github.com) or `bad-rev`
 *   (the pinned commit cannot be fetched).
 * - `FAKE_PY_MODE`: `enospc` (setup runs out of disk).
 * - `FAKE_PY_SETUP_DELAY_MS`: how long setup takes, to show progress.
 *
 * The "server" `serve.py` starts is a real HTTP listener on Winnow's port that
 * answers the classifier test question.
 */

export const FAKE_WINNOW_PIN = '77d14580c6732ca2f3745750c1dc1fd446d8bcee'
export const FAKE_WINNOW_PORT = 8091

const FAKE_GIT = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, 'git ' + args.join(' ') + '\\n')
const mode = process.env.FAKE_GIT_MODE || ''
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(128) }
const [command, ...rest] = args
if (command === '--version') { console.log('git version 2.50.0 (fake)'); process.exit(0) }
if (command === 'clone') {
  if (mode === 'offline') fail("fatal: unable to access 'https://github.com/EldanRing/winnow-inference.git/': Could not resolve host: github.com")
  const [repo, dest] = rest.filter((a) => !a.startsWith('--'))
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dest, '.git', 'origin'), repo)
  process.exit(0)
}
const state = (name) => path.join(process.cwd(), '.git', name)
if (command === 'remote') { process.stdout.write(fs.readFileSync(state('origin'), 'utf8') + '\\n'); process.exit(0) }
if (command === 'status') process.exit(0)
if (command === 'cat-file') process.exit(mode === 'bad-rev' ? 1 : 0)
if (command === 'fetch') fail("fatal: couldn't find remote ref " + rest[rest.length - 1])
if (command === 'checkout') { fs.writeFileSync(state('head'), rest[rest.length - 1]); process.exit(0) }
if (command === 'rev-parse') { process.stdout.write(fs.readFileSync(state('head'), 'utf8') + '\\n'); process.exit(0) }
fail('fake git: unsupported ' + args.join(' '))
`

const FAKE_PYTHON = `
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, 'python3 ' + args.join(' ') + '\\n')
if (args[0] === '--version') { console.log('Python 3.12.0 (fake)'); process.exit(0) }
if (args[0] === 'scripts/setup.py') {
  const finish = () => {
    if (process.env.FAKE_PY_MODE === 'enospc') {
      process.stderr.write('OSError: [Errno 28] No space left on device: model.safetensors\\n')
      process.exit(1)
    }
    const dir = args[args.indexOf('--model-dir') + 1]
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dir + '/model.safetensors', 'weights')
    process.exit(0)
  }
  console.log('Downloading model-00001-of-00003.safetensors')
  setTimeout(finish, Number(process.env.FAKE_PY_SETUP_DELAY_MS || 0))
} else if (args[0] === 'scripts/serve.py') {
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.method !== 'POST' || request.url !== '/v1/systemone') { response.statusCode = 404; response.end('{}'); return }
      response.end(JSON.stringify({
        model: 'winnow-fake',
        answers: { color: { type: 'choice', choice: 'red', probabilities: { red: 0.9, blue: 0.1 } } },
        usage: { input_tokens: 14, output_tokens: 1 },
      }))
    })
  })
  server.listen(${String(FAKE_WINNOW_PORT)}, '127.0.0.1', () => console.log('serving on ${String(FAKE_WINNOW_PORT)}'))
  process.on('SIGINT', () => server.close(() => process.exit(0)))
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
} else process.exit(2)
`

/** Write the fakes into `binDir`. Leave a program out of `programs` to make it genuinely missing. */
export function writeFakeClassifierTools(
  binDir: string,
  programs: readonly ('git' | 'python3')[] = ['git', 'python3'],
): void {
  mkdirSync(binDir, { recursive: true })
  const sources = { git: FAKE_GIT, python3: FAKE_PYTHON }
  for (const name of programs) {
    const file = join(binDir, name)
    writeFileSync(file, `#!${process.execPath}\n${sources[name]}`)
    chmodSync(file, 0o755)
  }
}
