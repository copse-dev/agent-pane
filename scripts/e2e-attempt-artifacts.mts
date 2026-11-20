import { startAttemptArtifacts, sealAttemptArtifacts } from './lib/e2e-attempt-diagnostics.mts'

const [command, value, status] = process.argv.slice(2)
if (command === 'start') {
  console.log(startAttemptArtifacts(value) ?? '')
} else if (command === 'finish' && value && status && /^\d{1,3}$/.test(status)) {
  await sealAttemptArtifacts(value, Number(status))
} else {
  throw new Error(
    'Usage: e2e-attempt-artifacts.mts start <attempt> | finish <directory> <exit-status>',
  )
}
