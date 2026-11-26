// `test:demo` launcher. pnpm passes a leading `--` through to the script
// (`pnpm run test:demo -- --spec X`), and wdio then ignores every option after
// it and runs the whole suite. npm strips it, so CI's `npm run test:demo --
// --spec X` already worked. Drop it here the way run-e2e.mts does.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { exitLike } from './lib/root-container-userns.mts'

const args = process.argv.slice(2)
const forwardedArgs = args[0] === '--' ? args.slice(1) : args
const wdioBinary = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio',
)

const result = spawnSync(wdioBinary, ['run', 'wdio.demo.conf.ts', ...forwardedArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
exitLike(result)
