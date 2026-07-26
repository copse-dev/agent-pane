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

  it('does not mistake an attached file-descriptor redirect for a script', () => {
    const command = String.raw`cd /work/project && find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/.git/*' -exec grep -li 'yolo' {} \; 2>/dev/null`
    assert.equal(action(command), 'allow')
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

  it('denies destruction that deletes nothing: ownership, permissions, relocation', () => {
    // The gate originally modelled deletion verbs only, so these ran silently
    // under Guarded YOLO despite equivalent broad impact.
    for (const command of [
      'sudo chown -R nobody /',
      'chmod -R 000 /',
      'chmod -R 000 ~',
      'chown -R nobody /etc',
      'mv ~ /tmp/gone',
      'mv /etc /tmp/gone',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('treats system trees as catastrophic targets', () => {
    for (const command of ['rm -rf /etc', 'rm -rf /usr', 'rm -rf /System']) {
      assert.equal(action(command), 'deny', command)
    }
    // Reading from a system tree stays routine — only destructive targets count.
    for (const command of ['cat /etc/hosts', 'ls /usr/bin']) {
      assert.equal(action(command), 'allow', command)
    }
  })

  it('sees through pass-through wrappers instead of degrading to a prompt', () => {
    for (const command of ['timeout 5 rm -rf ~', 'nice rm -rf ~', 'xargs rm -rf ~']) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('prompts for bounded overwrite and hijack forms', () => {
    for (const command of [
      'dd if=/dev/zero of=/Users/tester/.ssh/id_rsa',
      'ln -sf /dev/null ~/.bashrc',
      'crontab -r',
      'chmod -R 755 /work/project/dist',
    ]) {
      assert.equal(action(command), 'prompt', command)
    }
  })

  it('leaves routine permission and rename work alone', () => {
    for (const command of [
      'chmod +x scripts/build.sh',
      'chmod 644 README.md',
      'mv src/a.ts src/b.ts',
      'ln -s ../shared shared',
    ]) {
      assert.equal(action(command), 'allow', command)
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

  it('sees through a wrapper option that takes a separate value', () => {
    // The flag-skip loop only dropped flag-shaped tokens, so the *value* became
    // argv[0] and the real command was never inspected — a hard deny degraded to
    // a bare prompt.
    for (const command of [
      'sudo -u root rm -rf /',
      'nice -n 10 rm -rf /',
      'ionice -c 3 rm -rf /',
      'xargs -n 1 rm -rf /',
      'timeout -s KILL 5 rm -rf /',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('denies a tree delete without -f, which deletes just the same', () => {
    assert.equal(action('rm -r /'), 'deny')
    assert.equal(action('rm -r ~'), 'deny')
    assert.equal(action('rm --recursive /'), 'deny')
  })

  it('assesses code hidden behind backticks, eval, and find -exec', () => {
    for (const command of [
      'echo `rm -rf /`',
      'eval "rm -rf /"',
      'eval rm -rf /',
      'find / -name x -exec rm -rf / +',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('models redirects, which carry no command name at all', () => {
    // Truncating a system file is unrecoverable in place; a credential file is a
    // takeover whether the write appends or truncates.
    assert.equal(action('echo "" > /etc/hosts'), 'deny')
    assert.equal(action('echo "tester ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers'), 'deny')
    assert.equal(action(': > /Users/tester/.ssh/id_rsa'), 'prompt')
    assert.equal(action('echo x >> /Users/tester/.bashrc'), 'prompt')
    assert.equal(action('tee /etc/hosts < /dev/null'), 'prompt')
    // In-workspace and /tmp writes are ordinary build output.
    assert.equal(action('echo built > dist/marker.txt'), 'allow')
    assert.equal(action('echo line >> logs/app.log'), 'allow')
    assert.equal(action('echo x > /tmp/scratch.txt'), 'allow')
  })

  it('denies signals that take out the whole session', () => {
    assert.equal(action('kill -9 -1'), 'deny')
    assert.equal(action('kill -9 1'), 'deny')
    assert.equal(action('pkill -9 -u tester'), 'deny')
    // A single named process is ordinary process management.
    assert.equal(action('kill -9 4321'), 'allow')
    assert.equal(action('pkill -f "node scripts/watch"'), 'allow')
  })

  it('denies whole-device destruction that names no /dev node pattern', () => {
    for (const command of [
      'wipefs -a /dev/sda',
      'blkdiscard /dev/nvme0n1',
      'sgdisk --zap-all /dev/sda',
      'cryptsetup luksFormat /dev/sda1',
      'hdparm --security-erase NULL /dev/sda',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('denies destruction of the copies you would restore from', () => {
    for (const command of [
      'vssadmin delete shadows /all /quiet',
      'wbadmin delete catalog -quiet',
      'tmutil delete /Volumes/Backup',
      'tmutil disable',
      'journalctl --vacuum-time=1s',
      'bcdedit /set recoveryenabled No',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
    // Reading backup state is not destroying it.
    assert.equal(action('tmutil listbackups'), 'allow')
  })

  it('denies turning off the protections that would stop the next command', () => {
    for (const command of [
      'csrutil disable',
      'spctl --master-disable',
      'setenforce 0',
      'systemctl stop firewalld',
      'ufw disable',
      'Set-MpPreference -DisableRealtimeMonitoring $true',
    ]) {
      assert.equal(action(command), 'deny', command)
    }
    assert.equal(action('systemctl status myapp'), 'allow')
  })

  it('denies account and registry destruction', () => {
    for (const command of [
      'userdel -r tester',
      'passwd -d root',
      'dscl . -delete /Users/tester',
      String.raw`reg delete HKLM\SOFTWARE /f`,
    ]) {
      assert.equal(action(command), 'deny', command)
    }
  })

  it('treats attribute and ACL lockout like a recursive chmod', () => {
    assert.equal(action('chattr -R +i /'), 'deny')
    assert.equal(action(String.raw`takeown /f C:\Windows /r`), 'deny')
  })

  it('prompts for destructive version-control operations', () => {
    for (const command of [
      'git push --force origin main',
      'git push origin :main',
      'git branch -D main',
      'git reflog expire --expire=now --all',
      'git update-ref -d refs/heads/main',
      'git filter-branch --force --index-filter x HEAD',
      'git stash clear',
      'git checkout .',
      'git gc --prune=now',
    ]) {
      assert.equal(action(command), 'prompt', command)
    }
    // Ordinary version control still auto-runs.
    for (const command of [
      'git status',
      'git commit -m wip',
      'git push origin feature',
      'git push --force-with-lease origin feature',
      'git checkout -b feature',
      'git stash push -m wip',
      'git gc',
    ]) {
      assert.equal(action(command), 'allow', command)
    }
  })

  it('prompts for relocation and mirror deletion that are not catastrophic', () => {
    // `rm -rf src` prompts, so moving the same tree away should not be silent.
    assert.equal(action('mv /work/project/src /tmp/gone'), 'prompt')
    assert.equal(action('mv /Users/tester/.ssh /tmp/gone'), 'prompt')
    assert.equal(action('rsync -a --delete /tmp/empty/ /work/project/'), 'deny')
    // `mv -t DEST SRC` puts the destination first; reading it positionally let a
    // home-directory move through.
    assert.equal(action('mv -t /tmp/gone /Users/tester'), 'deny')
    // Renames and copies inside the workspace stay routine.
    assert.equal(action('mv src/a.ts src/b.ts'), 'allow')
    assert.equal(action('mv build/out.js dist/out.js'), 'allow')
    assert.equal(action('rsync -a src/ dist/'), 'allow')
  })

  it('prompts for a write that lands on a credential path without a redirect', () => {
    assert.equal(action('cp /dev/null /Users/tester/.ssh/id_rsa'), 'prompt')
    assert.equal(action('install -m 000 /dev/null /Users/tester/.bashrc'), 'prompt')
    assert.equal(action('cp -r src/assets dist/assets'), 'allow')
  })

  it('reaches interpreter deletion behind require() and non-literal targets', () => {
    // A target the analysis cannot resolve previously produced no signal at all.
    assert.equal(
      action(`node -e "require('fs').rmSync(process.env.HOME,{recursive:true})"`),
      'prompt',
    )
    assert.equal(action(`node -e "require('fs').promises.rm('/',{recursive:true})"`), 'deny')
    assert.equal(action(`node -e "require('rimraf').sync('/')"`), 'deny')
    assert.equal(action(`python3 -c "import pathlib; pathlib.Path('/etc').unlink()"`), 'deny')
    assert.equal(action(`ruby -e "FileUtils.rm_rf(Dir.home)"`), 'prompt')
  })

  it('does not hard-deny a target another tool substitutes at run time', () => {
    // `{}` resolved lexically to the workspace root, so a routine cleanup was
    // DENIED outright with no approval path.
    assert.equal(action('find . -name "*.tmp" | xargs -I{} rm -rf {}'), 'prompt')
  })

  it('does not mistake a redirect target for an executable', () => {
    // Any relative path after `>`/`<` used to become a segment head, so the gate
    // tried to read it as a script and prompted with a misleading reason.
    for (const command of [
      'echo built > dist/marker.txt',
      'tee dist/report.txt < src/in.txt',
      'sort < src/in.txt > dist/out.txt',
    ]) {
      assert.equal(action(command), 'allow', command)
    }
    // Nor an argument that merely looks script-shaped.
    assert.equal(action('/usr/bin/git add build.sh'), 'allow')
    assert.equal(action('/bin/ls scripts/build.sh'), 'allow')
  })
})
