import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    provider: { type: 'string' },
    'agent-command': { type: 'string' },
    'electron-app': { type: 'string' },
  },
})
if (values.help) {
  console.log(
    'Prepare a fresh macOS Copse journey; no app launch or inference.\n' +
      'node .agents/skills/copse-dogfood/scripts/prepare-acp.mts --provider codex|claude --agent-command /absolute/path/to/acp-adapter [--electron-app /path/to/Copse.app]',
  )
  process.exit(0)
}
if (process.platform !== 'darwin')
  throw new Error(
    'This helper prepares a macOS app. Use the WebdriverIO or isolated_copse route on other hosts.',
  )
if (values.provider !== 'codex' && values.provider !== 'claude')
  throw new Error('Choose --provider codex or claude explicitly.')
const agentCommand = values['agent-command']
if (!agentCommand || !isAbsolute(agentCommand))
  throw new Error('--agent-command must be an absolute ACP adapter path, not the ordinary CLI.')
accessSync(agentCommand, constants.X_OK)

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const entry = join(repo, 'dist/main/index.js')
accessSync(entry)
const sourceApp = realpathSync(
  values['electron-app'] ?? join(repo, 'node_modules/electron/dist/Copse.app'),
)
accessSync(join(sourceApp, 'Contents/MacOS/Electron'), constants.X_OK)
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
const scratch = join(repo, '.tmp')
mkdirSync(scratch, { recursive: true })
const run = mkdtempSync(join(scratch, 'copse-dogfood-'))
const profile = join(run, 'profile')
const project = join(run, 'project')
mkdirSync(project)
mkdirSync(join(run, 'evidence'))
execFileSync('git', ['init', '--initial-branch=main', project], { stdio: 'pipe' })
const id = values.provider === 'codex' ? 'codex-acp' : 'claude-acp'
const mode = values.provider === 'codex' ? 'agent' : 'default'
const env = {
  ...process.env,
  COPSE_DIR: profile,
  COPSE_PANEL_USER_DATA: join(profile, 'user-data'),
  COPSE_WORKSPACE_DIR: join(profile, 'workspace'),
}
const seed = join(run, 'seed.cjs')
await build({
  absWorkingDir: repo,
  stdin: {
    contents: `import { seedEmptyProject } from './tests/e2e/helpers/seed-config.ts'
const [project, id, command, permissionMode] = process.argv.slice(2)
if (!project || !id || !command || !permissionMode) throw new Error('Missing seed arguments')
seedEmptyProject(project, 'dogfood-reading-list', {
  model: 'acp:' + id, subagentsEnabled: false,
  registeredAcpAgents: [{ id, title: id, command, args: [], enabled: true, permissionMode }],
})`,
    resolveDir: repo,
  },
  outfile: seed,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  tsconfig: join(repo, 'tsconfig.node.json'),
  logLevel: 'warning',
})
execFileSync(process.execPath, [seed, project, id, agentCommand, mode], {
  cwd: repo,
  env,
  stdio: 'inherit',
})

// Clone only the runtime; give computer-use tools an unambiguous application target.
const identity = randomUUID()
const displayName = 'Copse Dogfood ' + identity.slice(0, 8)
const app = join(run, displayName + '.app')
execFileSync('/bin/cp', ['-cR', sourceApp, app])
const plist = join(app, 'Contents/Info.plist')
for (const [key, value] of [
  ['CFBundleIdentifier', 'dev.copse.dogfood.' + identity],
  ['CFBundleName', displayName],
  ['CFBundleDisplayName', displayName],
])
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })

const brief = {
  source: sha,
  dirtyCheckout: dirty.length > 0,
  preparedAt: new Date().toISOString(),
  outer: 'Record the actual host and control tool before launching',
  inner: 'acp:' + id,
  permissionMode: mode,
  mock: false,
  run,
  project,
  profile,
  app,
  bundleId: 'dev.copse.dogfood.' + identity,
  boundary:
    'Two prompts, at most 20 minutes; no installs, commits, publishing or new purchases. Stop on unresolved approval/authentication.',
  acceptance: [
    'Copse creates index.html, styles.css, app.js',
    'Add Alder/Birch; clear input; ignore whitespace',
    'Follow up for Remove',
    'Remove Alder preserves Birch; Add Cedar still works',
    'Export evidence and quit only the owned app',
  ],
  status: 'Prepared only; build freshness, authentication and live behavior require verification',
}
writeFileSync(join(run, 'evidence/brief.json'), JSON.stringify(brief, null, 2) + '\n')
writeFileSync(join(run, 'evidence/checkout-status.txt'), dirty)
const prompts = [
  'Build a small reading-list page using only index.html, styles.css and app.js. Include a labelled book-title input, Add button, and list. Adding a nonempty title should create a row and clear the input; ignore whitespace-only titles. Keep all resources local and use no package installs or external services. Explain how to open it locally. Do not commit or publish anything.',
  'Add a Remove button to each book row. Removing one book should preserve the other books. Keep the existing Add behavior and styling. Keep the work local; do not install packages, commit, or publish.',
]
prompts.forEach((prompt, index) =>
  writeFileSync(join(run, `prompt-${index + 1}.txt`), prompt + '\n'),
)
const quote = (text: string): string => "'" + text.replaceAll("'", "'\"'\"'") + "'"
const launch = [
  'env',
  '-u',
  'ELECTRON_RUN_AS_NODE',
  '-u',
  'COPSE_PANEL_MOCK_LLM',
  '/usr/bin/open',
  '-n',
  '-a',
  app,
  '--env',
  'COPSE_DIR=' + profile,
  '--env',
  'COPSE_PANEL_USER_DATA=' + env.COPSE_PANEL_USER_DATA,
  '--env',
  'COPSE_WORKSPACE_DIR=' + env.COPSE_WORKSPACE_DIR,
  '--env',
  'COPSE_AGENT_EVAL=1',
  '--args',
  entry,
]
writeFileSync(join(run, 'launch-command.txt'), launch.map(quote).join(' ') + '\n')
console.log(
  JSON.stringify(
    {
      run,
      app,
      profile,
      project,
      launchCommand: join(run, 'launch-command.txt'),
      note: 'Prepared only. Use an authorized host launcher; inspect the skill before driving the app.',
    },
    null,
    2,
  ),
)
