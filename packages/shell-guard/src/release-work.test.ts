import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessShellHarm, type ShellHarmContext, type ShellHarmDecision } from './shell-harm.ts'

const workspace = '/work/project'

function decide(command: string, files: Record<string, string> = {}): ShellHarmDecision {
  const context: ShellHarmContext = {
    workspaceRoot: workspace,
    homeDir: '/Users/tester',
    readScript: (path) => files[path] ?? null,
  }
  return assessShellHarm(command, context)
}

function asks(command: string, files: Record<string, string> = {}): void {
  const decision = decide(command, files)
  assert.notEqual(decision.action, 'allow', command)
}

function allows(command: string, files: Record<string, string> = {}): void {
  const decision = decide(command, files)
  assert.equal(decision.action, 'allow', `${command}: ${decision.reasons.join('; ')}`)
}

describe('harm gate: release and secret work it used to miss', () => {
  it('asks about registry logins fed a credential, and allows a bare status check', () => {
    asks('echo "$REGISTRY_PAT" | docker login registry.example.com -u bot --password-stdin')
    asks('helm registry login registry.example.com -u bot -p "$TOKEN"')
    allows('docker info')
  })

  it('asks about raw kubeconfig prints and private-key exports', () => {
    asks('KUBECONFIG=./kubeconfig kubectl config view --raw --minify')
    allows('kubectl config view --minify')
    asks('gpg --batch --armor --export-secret-subkeys "$KEY" | base64 > key.b64')
    allows('gpg --armor --export "$KEY"')
  })

  it('asks about release tools unless they rehearse', () => {
    asks('goreleaser release --clean')
    allows('goreleaser release --snapshot --clean')
    asks('changeset publish')
    allows('changeset version')
  })

  it('reads a git alias given with -c as the command it runs', () => {
    asks("git -c alias.sync='push origin +HEAD:refs/tags/v0.9.4' sync")
    allows("git -c alias.wip='status --short --branch' wip")
  })

  it('asks when git traces print headers with redaction turned off', () => {
    asks('GIT_TRACE_REDACT=0 GIT_TRACE_CURL=1 git ls-remote origin')
    allows('GIT_TRACE=1 git status')
  })

  it('looks through caffeinate, mise exec and project runners', () => {
    asks('caffeinate -i docker buildx build -t registry.example.com/app:1 --push .')
    asks('mise exec minisign@0.11 -- minisign -S -s release.key -m dist/app.tar.gz')
    asks(
      'uv run python - <<\'PY\'\nimport subprocess\nsubprocess.run(["gpg", "--detach-sign", "dist/a.whl"])\nPY',
    )
    allows('caffeinate -i pnpm test')
  })

  it('does not add uncertainty prompts through those wrappers', () => {
    allows('uv run python scripts/missing.py')
  })

  it('reads environment dumps, secret-file reads and argv arrays in code', () => {
    asks('ruby -e \'ENV.sort.each { |k, v| puts "#{k}=#{v}" }\' > tmp/env.txt')
    asks(
      "node -e \"const fs=require('fs'),os=require('os');process.stdout.write(fs.readFileSync(os.homedir()+'/.npmrc','utf8'))\"",
    )
    asks('node -e \'require("child_process").execFileSync("gh",["rel"+"ease","create","v1"])\'')
    allows("node -e 'console.log(process.env.HOME)'")
  })
})

describe('harm gate: task recipes', () => {
  it('reads a just recipe and its dotenv setting', () => {
    const files = {
      [`${workspace}/justfile`]:
        'set dotenv-load\nset dotenv-filename := ".env.release"\n\npreflight:\n    cargo build --release\n',
    }
    asks('just preflight', files)
    allows('just --list', files)
  })

  it('reads a Taskfile task and asks about its release step', () => {
    const files = {
      [`${workspace}/Taskfile.yml`]:
        "version: '3'\ntasks:\n  bump:\n    cmds:\n      - svu patch > .version\n      - goreleaser release --clean\n  test:\n    cmds:\n      - go test ./...\n",
    }
    asks('task bump', files)
    allows('task test', files)
    allows('task --dry bump', files)
  })

  it('reads a package script in the directory a cd moved to', () => {
    const files = {
      [`${workspace}/packages/ui/package.json`]: JSON.stringify({
        scripts: {
          build: 'tsup src/index.ts',
          'prepare:dist': 'pnpm run build && changeset publish',
        },
      }),
    }
    asks('cd packages/ui && pnpm run prepare:dist', files)
    allows('cd packages/ui && pnpm run build', files)
  })

  it('keeps a recipe uncertainty out of the verdict', () => {
    const files = {
      [`${workspace}/package.json`]: JSON.stringify({
        scripts: { lint: './tools/missing.sh', 'build:demo': 'rm -rf demo/dist && vite build' },
      }),
    }
    allows('pnpm run lint', files)
    // A recipe's own clean-up is a local effect; typing the release step is what asks.
    allows('pnpm run build:demo', files)
  })
})
