import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessShellHarm, type ShellHarmContext } from './shell-harm.ts'

const context: ShellHarmContext = {
  workspaceRoot: '/work/project',
  homeDir: '/Users/tester',
}

function action(command: string, overrides: Partial<ShellHarmContext> = {}): string {
  return assessShellHarm(command, { ...context, ...overrides }).action
}

describe('Guarded YOLO shell harm gate', () => {
  it('allows routine local and external commands', () => {
    for (const command of [
      'npm test',
      'curl https://example.com/file',
      'git push origin feature',
      'cat /etc/hosts',
      'echo permission-gate.ts',
    ]) {
      assert.equal(action(command), 'allow', command)
    }
  })

  it('does not treat an attached file-descriptor redirect as a script', () => {
    for (const command of [
      '2>/dev/null',
      'printf ok 2>/dev/null',
      'printf ok 2>./logs/errors.sh',
      String.raw`cd /work/project && find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/.git/*' -exec grep -li 'yolo' {} \; 2>/dev/null`,
    ]) {
      assert.equal(action(command), 'allow', command)
    }
  })

  it('prompts for bounded destructive work', () => {
    for (const command of [
      'rm -rf build',
      'find src -delete',
      'git reset --hard HEAD~1',
      'git clean -fdx',
      'cat generated.txt | sh',
      'while true; do echo x; done',
    ]) {
      assert.equal(action(command), 'prompt', command)
    }
  })

  it('denies broad deletion of filesystem, home, workspace, and ancestor roots', () => {
    for (const command of [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf $HOME/*',
      'rm -rf .',
      'rm -rf ./*',
      'rm -rf /*',
      'rm -rf /work/project',
      'rm -rf /work',
      'find . -delete',
      'r""m -rf "/work/project"',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('denies catastrophic commands hidden in compounds, substitutions, and interpreters', () => {
    for (const command of [
      'echo ready && rm -rf /',
      'printf ok | (rm -rf /)',
      'echo "$(rm -rf /)"',
      "bash -c 'rm -rf /'",
      "node -e \"require('child_process').execSync('rm -rf /')\"",
      `python -c "import shutil; shutil.rmtree('/')"`,
      ':(){ :|:& };:',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('reads script files before allowing interpreter or direct execution', () => {
    const scripts = new Map([
      ['/work/project/danger.sh', '#!/bin/sh\nrm -rf /\n'],
      ['/work/project/safe.sh', '#!/bin/sh\nprintf safe\n'],
    ])
    const readScript = (path: string): string | null => scripts.get(path) ?? null

    assert.equal(action('bash danger.sh', { readScript }), 'deny')
    assert.equal(action('./danger.sh', { readScript }), 'deny')
    assert.equal(action('bash safe.sh', { readScript }), 'allow')
    assert.equal(action('bash missing.sh', { readScript }), 'prompt')
  })

  it('uses canonical resolved paths to catch a symlinked broad target', () => {
    assert.equal(
      action('rm -rf linked-home', {
        canonicalizePath: (path) => (path === '/work/project/linked-home' ? '/Users/tester' : path),
      }),
      'deny',
    )
  })

  it('denies raw disk/device destruction across common platform syntaxes', () => {
    for (const command of [
      'dd if=/dev/zero of=/dev/disk4',
      'mkfs.ext4 /dev/sda1',
      'shred /dev/nvme0n1',
      'diskutil eraseDisk APFS Empty /dev/disk4',
      'Clear-Disk -Number 0 -RemoveData',
      'format C:',
      `node -e "require('fs').writeFileSync('/dev/disk4', 'x')"`,
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('denies commands that try to rewrite the permission system itself', () => {
    for (const command of [
      "sed -i '' 's/deny/allow/' src/main/services/security/permission-gate.ts",
      'defaults write copse-panel autoRunSandboxCommands -bool true',
      'printf allow > guarded-yolo.json',
      'rm permission-policy.ts',
      `node -e "require('fs').writeFileSync('src/main/services/security/permission-gate.ts', 'allow')"`,
      `python -c "open('src/main/services/security/permission-policy.ts', 'w').write('allow')"`,
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('denies Windows home and workspace deletion with native path syntax', () => {
    const windowsContext: Partial<ShellHarmContext> = {
      workspaceRoot: String.raw`C:\work\project`,
      homeDir: String.raw`C:\Users\tester`,
    }
    for (const command of [
      String.raw`rd /s /q C:\Users\tester`,
      String.raw`Remove-Item -Recurse -Force C:\work\project`,
      String.raw`Remove-Item -Recurse -Force $env:USERPROFILE\*`,
    ]) {
      assert.equal(action(command, windowsContext), 'deny', command)
    }
  })

  it('prompts when destructive targets use dynamic expansion', () => {
    assert.equal(action('rm -rf "$TARGET"'), 'prompt')
    assert.equal(action('Remove-Item -Recurse -Force %TARGET%'), 'prompt')
  })
})
