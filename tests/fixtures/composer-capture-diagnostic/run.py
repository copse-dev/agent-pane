"""Bounded, hosted-only observation of two immutable public Copse fixtures."""
from pathlib import Path
import hashlib
import json
import math
import os
import platform
import re
import shutil
import signal
import struct
import subprocess
import sys
import tarfile
import time

CASES = (
    ('current', '453ac5c12eb56a897aebf43292209ec9d7886b03'),
    ('accepted', '5d14c144b6a1dd75834bd44ba69345256cba56fc'),
)
BRANCH = 'refs/heads/codex/composer-canonical-diagnostic-20261114'
SPEC = 'tests/e2e/composer-border-observer.e2e.ts'
PATCH_SHA = '7ca190b9a62acae5c710c9ba5794daa7679b1571883a5df28facbfce2dc673a2'
INPUT_NAMES = ('run.py', 'test_runner.py', 'cleanup.sh', 'protocol.json', 'observation.patch', 'README.md')
PROFILE_KEYS = ('COPSE_DIR', 'COPSE_PANEL_USER_DATA', 'COPSE_WORKSPACE_DIR')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def validate_context(env, system, machine, os_release):
    expected = {
        'GITHUB_ACTIONS': 'true', 'DIAGNOSTIC_RUNNER_ENVIRONMENT': 'github-hosted',
        'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': 'copse-dev/agent-pane',
        'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': BRANCH, 'GITHUB_RUN_ATTEMPT': '1',
        'GITHUB_JOB': 'composer-canonical-pair',
    }
    if any(env.get(k) != v for k, v in expected.items()):
        raise RuntimeError('Refusing execution outside the first audited hosted dispatch')
    if system != 'Linux' or machine != 'x86_64' or 'VERSION_ID="24.04"' not in os_release:
        raise RuntimeError('The matched pair requires Ubuntu 24.04 x64')


def require_hosted():
    validate_context(os.environ, platform.system(), platform.machine(), Path('/etc/os-release').read_text())


def load_protocol(directory):
    protocol = json.loads((directory / 'protocol.json').read_text())
    cases = tuple((c['name'], c['source']) for c in protocol['cases'])
    if cases != CASES or protocol['spec'] != SPEC or protocol['observationPatchSha256'] != PATCH_SHA:
        raise ValueError('Diagnostic scope changed')
    if sha(directory / 'observation.patch') != PATCH_SHA:
        raise ValueError('Observation patch changed')
    if len(protocol['originalBlobs']) != 14 or len(protocol['instrumentedFiles']) != 5:
        raise ValueError('Incomplete frozen source inputs')
    if protocol['limits']['caseCount'] != 2 or protocol['limits']['outerRetries'] != 0:
        raise ValueError('The diagnostic has no retry or additional-case mode')
    return protocol


def profile_sample(repo):
    path = repo / 'tests/e2e/electron-shell/.e2e-env.json'
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            return None
        return {k: value[k] for k in PROFILE_KEYS if isinstance(value.get(k), str)}
    except (OSError, ValueError):
        return None


class Commands:
    def __init__(self, repo, out):
        self.repo, self.out = repo, out
        self.records = []
        self.profiles = []

    def run(self, label, argv, timeout=60, env=None, watch_profile=False):
        self.out.mkdir(parents=True, exist_ok=True)
        code = 125
        started = time.time()
        failure = None
        try:
            with (self.out / (label + '.stdout.log')).open('w') as stdout, (self.out / (label + '.stderr.log')).open('w') as stderr:
                child = subprocess.Popen(argv, cwd=self.repo, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                try:
                    deadline = time.monotonic() + timeout
                    while child.poll() is None:
                        if watch_profile:
                            sample = profile_sample(self.repo)
                            if sample and (not self.profiles or sample != self.profiles[-1]['paths']):
                                self.profiles.append({'observedAt': time.time(), 'paths': sample})
                                save(self.out / 'profile-history.json', self.profiles)
                        if time.monotonic() >= deadline:
                            code = 124
                            break
                        time.sleep(0.025)
                    else:
                        code = child.returncode
                finally:
                    # Only the session created for this command; the ordinary CI
                    # janitor below handles detached Electron/Gortex descendants.
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(child.pid, sig)
                        except ProcessLookupError:
                            break
                        if child.poll() is None:
                            try:
                                child.wait(timeout=3)
                            except subprocess.TimeoutExpired:
                                pass
                    child.wait(timeout=3)
        except Exception as error:
            failure = str(error)
            raise
        finally:
            self.records.append({'label': label, 'argv': argv, 'exit': code, 'error': failure, 'startedAt': started, 'finishedAt': time.time()})
            save(self.out / 'commands.json', self.records)
        return code

    def checked(self, label, argv, **options):
        if self.run(label, argv, **options) != 0:
            raise RuntimeError(label + ' failed; see retained logs')


def git(repo, *argv):
    return subprocess.check_output(['git', *argv], cwd=repo, text=True).strip()


def inventory(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        relative = str(path.relative_to(directory))
        if path.is_symlink():
            result[relative] = {'symlink': os.readlink(path)}
        elif path.is_file():
            result[relative] = {'sha256': sha(path), 'bytes': path.stat().st_size, 'mode': path.stat().st_mode & 0o777}
    return result


def archive_build(repo, out):
    dist = repo / 'dist'
    if not dist.is_dir():
        return None
    entries = inventory(dist)
    save(out / 'build-inventory.json', entries)
    target = out / 'actual-dist.tar.gz'
    with tarfile.open(target, 'w:gz') as archive:
        archive.add(dist, arcname='dist')
    return {'archiveSha256': sha(target), 'archiveBytes': target.stat().st_size, 'entries': len(entries)}


def retain_outputs(repo, out, protocol):
    for source, target in [('.tmp/composer-observer', 'composer-observer'), ('e2e-failure-artifacts', 'e2e-failure-artifacts')]:
        path = repo / source
        if path.exists():
            shutil.copytree(path, out / target, dirs_exist_ok=True)
    # A pre-existing hydrated reference is never called a generated screenshot.
    attempts = out / 'composer-observer/png-attempts'
    for name in protocol['pngNames']:
        original = repo / 'tests/e2e/screenshots' / name
        captured = list(attempts.glob('*-' + name))
        if original.exists() and any(sha(original) == sha(p) for p in captured):
            (out / 'original-png-paths').mkdir(exist_ok=True)
            shutil.copyfile(original, out / 'original-png-paths' / name)


def finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def finite_pixels(value, allow_empty=False):
    if not isinstance(value, str):
        return False
    value = value.strip()
    if allow_empty and value == '':
        return True
    if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)px', value):
        return False
    return finite_number(float(value[:-2]))


def valid_rect(value):
    return (isinstance(value, dict)
            and all(finite_number(value.get(key)) for key in ('x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right'))
            and value['width'] > 0 and value['height'] > 0)


def valid_geometry(row):
    composer = row.get('composer')
    conversation = row.get('conversation')
    transcript = row.get('transcript')
    targets = row.get('targetsUnchanged')
    return (finite_number(row.get('t'))
            and isinstance(targets, dict)
            and all(targets.get(key) is True for key in ('composer', 'pane', 'conversation', 'transcript', 'result'))
            and isinstance(composer, dict) and valid_rect(composer.get('rect'))
            and all(finite_number(composer.get(key)) for key in ('clientWidth', 'clientHeight'))
            and all(finite_pixels(composer.get(key)) for key in ('borderTop', 'borderBottom'))
            and finite_pixels(row.get('reserve'))
            and isinstance(conversation, dict) and valid_rect(conversation.get('rect'))
            and finite_pixels(conversation.get('paddingBottom'))
            and isinstance(transcript, dict) and valid_rect(transcript.get('rect'))
            and all(finite_number(transcript.get(key)) for key in ('clientHeight', 'scrollHeight', 'scrollTop', 'bottomGap'))
            and all(finite_pixels(transcript.get(key), allow_empty=True) for key in ('stickyBand', 'stickyScrollBand'))
            and valid_rect(row.get('result'))
            # This fixture has no heading. Explicit null is valid; an absent
            # field or a malformed rectangle still means incomplete evidence.
            and 'resultHeading' in row
            and (row['resultHeading'] is None or valid_rect(row['resultHeading'])))


def valid_producer(row):
    envelope = row.get('detail')
    if not isinstance(envelope, dict) or not finite_number(envelope.get('producerTime')):
        return False
    detail = envelope.get('detail')
    if not isinstance(detail, dict):
        return False
    if row['kind'] == 'producer:copse-diag-composer-sync':
        return (detail.get('reason') in ('initial', 'raf', 'resize-observer', 'window-resize', 'store-select', 'message-added')
                and all(finite_number(detail.get(key)) for key in ('measuredHeight', 'height'))
                and finite_pixels(detail.get('previousReserve'), allow_empty=True))
    if row['kind'] == 'producer:copse-diag-programmatic-scroll':
        return (all(finite_number(detail.get(key)) for key in ('requested', 'before', 'landed'))
                and isinstance(detail.get('stack'), str) and bool(detail['stack'].strip()))
    return False


def capture_summary(out, protocol):
    attempts = sorted((out / 'composer-observer/png-attempts').glob('*.png'))
    timeline = out / 'composer-observer/timeline.json'
    raw_rows = json.loads(timeline.read_text()) if timeline.exists() else []
    timeline_valid = isinstance(raw_rows, list) and all(isinstance(r, dict) and isinstance(r.get('kind'), str) for r in raw_rows)
    rows = raw_rows if timeline_valid else []
    boundaries = [r for r in rows if r['kind'].startswith('png-call-')]
    expected = {prefix + name for name in protocol['pngNames'] for prefix in ('png-call-before:', 'png-call-after:')}
    complete = len(attempts) == 3 and len(boundaries) == 6 and {r['kind'] for r in boundaries} == expected
    complete = complete and all(sum(path.name.endswith('-' + name) for path in attempts) == 1 for name in protocol['pngNames'])
    complete = complete and all(r.get('dpr') == 2 and r.get('viewport') == protocol['viewport'] for r in boundaries)
    required_kinds = {'raf', 'resize-observer', 'mutation', 'producer:copse-diag-composer-sync'}
    complete = complete and required_kinds.issubset({r.get('kind') for r in rows})
    producers = [r for r in rows if r['kind'].startswith('producer:')]
    geometry_valid = bool(rows) and all(valid_geometry(row) for row in rows)
    producers_valid = bool(producers) and all(valid_producer(row) for row in producers)
    complete = complete and timeline_valid and geometry_valid and producers_valid
    pngs = {}
    for path in attempts:
        header = path.read_bytes()[:24]
        if header[:8] != b'\x89PNG\r\n\x1a\n':
            complete = False
        width, height = struct.unpack('>II', header[16:24]) if len(header) == 24 else (0, 0)
        complete = complete and (width, height) == (2400, 1600)
        pngs[path.name] = {'sha256': sha(path), 'width': width, 'height': height, 'bytes': path.stat().st_size}
    return {'complete': bool(complete), 'rows': len(rows), 'timelineValid': timeline_valid, 'geometryValid': geometry_valid, 'producerDetailsValid': producers_valid, 'boundaries': boundaries, 'rawAttempts': pngs}


def runtime_snapshot(repo, out, commands, protocol):
    for label, argv in [('node-version', ['node', '--version']), ('pnpm-version', ['pnpm', '--version']), ('font-inventory', ['fc-list']), ('system-font-match', ['fc-match', 'system-ui']), ('package-versions', ['dpkg-query', '-W', 'bubblewrap', 'socat', 'fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji'])]:
        commands.checked(label, argv)
    electron = repo / 'node_modules/electron'
    if json.loads((electron / 'package.json').read_text())['version'] != protocol['electron']:
        raise RuntimeError('Unexpected Electron version')
    driver = repo / 'node_modules/electron-chromedriver/bin/chromedriver'
    commands.checked('chromedriver-version', [str(driver), '--version'])
    if protocol['chromium'] not in (out / 'chromedriver-version.stdout.log').read_text():
        raise RuntimeError('Unexpected ChromeDriver version')
    commands.checked('font-files', ['fc-list', '--format', '%{file}\n'])
    fonts = {s: sha(Path(s)) for s in sorted(set((out / 'font-files.stdout.log').read_text().splitlines())) if s}
    result = {'platform': platform.platform(), 'machine': platform.machine(), 'osRelease': Path('/etc/os-release').read_text(), 'image': {k: os.environ.get(k) for k in ('ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH')}, 'fontFiles': fonts, 'electronBinarySha256': sha(electron / 'dist/electron'), 'chromedriverBinarySha256': sha(driver), 'versionLogs': {name: (out / (name + '.stdout.log')).read_text() for name in ('node-version', 'pnpm-version', 'chromedriver-version', 'package-versions', 'system-font-match')}}
    save(out / 'runtime.json', result)
    return result


def cleanup(commands, inputs, phase):
    require_hosted()
    commands.checked(phase + '-processes-before-cleanup', ['ps', '-eo', 'pid,ppid,pgid,sid,comm'])
    commands.checked(phase + '-normal-ci-janitor', ['bash', str(inputs / 'cleanup.sh')])
    commands.checked(phase + '-processes-after-cleanup', ['ps', '-eo', 'pid,ppid,pgid,sid,comm'])


def require_fresh_outputs(repo):
    for relative in ('dist', '.tmp/composer-observer', 'e2e-failure-artifacts'):
        if (repo / relative).exists():
            raise RuntimeError('Stale case output; refusing to attribute it to this subject: ' + relative)


def run_case(repo, root, protocol, name, source, index):
    out = root / 'evidence' / name
    commands = Commands(repo, out)
    record = {'name': name, 'source': source, 'specInvocations': 0, 'outerRetries': 0, 'testExit': None}
    build_started = False
    fresh_outputs = False
    try:
        require_fresh_outputs(repo)
        fresh_outputs = True
        cleanup(commands, root, 'before')
        commands.checked('checkout', ['git', 'checkout', '--detach', source])
        if git(repo, 'rev-parse', 'HEAD') != source:
            raise RuntimeError('Wrong immutable subject')
        commands.checked('archive-source', ['git', 'archive', '--format=tar.gz', '--output=' + str(out / 'source.tar.gz'), source])
        record['sourceTree'] = git(repo, 'rev-parse', source + '^{tree}')
        for path, blob in protocol['originalBlobs'].items():
            if git(repo, 'rev-parse', source + ':' + path) != blob:
                raise RuntimeError('Original source input changed: ' + path)
        if index:
            # Fresh installed trees per subject, reusing only the verified input
            # store selected by the normal setup action in this same job.
            for modules in [repo / 'node_modules', *(repo / 'packages').glob('*/node_modules')]:
                if modules.is_symlink():
                    modules.unlink()
                elif modules.exists():
                    shutil.rmtree(modules)
            commands.checked('clean-locked-install', ['pnpm', 'install', '--frozen-lockfile'], timeout=protocol['limits']['installSeconds'])
        record['runtime'] = runtime_snapshot(repo, out, commands, protocol)
        commands.checked('apply-check', ['git', 'apply', '--check', str(root / 'observation.patch')])
        commands.checked('apply-observation', ['git', 'apply', str(root / 'observation.patch')])
        record['instrumentedFiles'] = {path: sha(repo / path) for path in protocol['instrumentedFiles']}
        if record['instrumentedFiles'] != protocol['instrumentedFiles']:
            raise RuntimeError('Instrumented source differs from the reviewed fixture')
        build_started = True
        commands.checked('build', ['pnpm', 'run', 'build'], timeout=protocol['limits']['buildSeconds'])
        record['build'] = archive_build(repo, out)
        record['specInvocations'] = 1
        record['testExit'] = commands.run('owning-spec', ['pnpm', 'run', 'test:e2e:ci', '--', '--spec', SPEC], timeout=protocol['limits']['specSeconds'], watch_profile=True)
    except Exception as error:
        record['error'] = str(error)
    finally:
        operations = [('cleanup', lambda: cleanup(commands, root, 'after'))]
        if build_started and not record.get('build'):
            operations.append(('retain-partial-build', lambda: record.update(partialBuild=archive_build(repo, out))))
        if record['specInvocations']:
            operations.append(('retain-outputs', lambda: retain_outputs(repo, out, protocol)))
        for label, operation in operations:
            try:
                operation()
            except Exception as error:
                record[label + 'Error'] = str(error)
        record['commands'] = commands.records
        record['profiles'] = commands.profiles
        record['profileCleanup'] = [{'paths': sample['paths'], 'remaining': {key: path for key, path in sample['paths'].items() if Path(path).exists()}} for sample in commands.profiles]
        try:
            record['capture'] = capture_summary(out, protocol)
        except Exception as error:
            record['captureError'] = str(error)
        # Reset only this disposable hosted checkout after all evidence is safe.
        try:
            if not fresh_outputs:
                raise RuntimeError('Pre-existing outputs left untouched; no subject reset or deletion')
            if any(k.endswith('Error') for k in record):
                raise RuntimeError('Retention or cleanup failed; leaving checkout outputs untouched')
            helper = repo / 'tests/e2e/helpers/composer-diagnostic.ts'
            if helper.exists():
                if sha(helper) != protocol['instrumentedFiles']['tests/e2e/helpers/composer-diagnostic.ts']:
                    raise RuntimeError('Unrecognized diagnostic helper; refusing to remove it')
                helper.unlink()
            commands.checked('reset-subject', ['git', 'reset', '--hard', source])
            for relative in ('dist', '.tmp/composer-observer', 'e2e-failure-artifacts'):
                path = repo / relative
                if path.exists():
                    shutil.rmtree(path)
        except Exception as error:
            record['resetError'] = str(error)
        profiles_clean = bool(commands.profiles) and all(not sample['remaining'] for sample in record['profileCleanup'])
        record['complete'] = record['testExit'] == 0 and bool(record.get('build')) and record.get('capture', {}).get('complete', False) and profiles_clean and 'error' not in record and not any(k.endswith('Error') for k in record)
        save(out / 'case.json', record)
    return record


def collect_pair(callback):
    results = []
    for index, (name, source) in enumerate(CASES):
        try:
            results.append(callback(name, source, index))
        except Exception as error:
            results.append({'name': name, 'source': source, 'complete': False, 'error': str(error)})
    return results


def prepare(repo, inputs, root):
    require_hosted()
    protocol = load_protocol(inputs)
    root.mkdir(exist_ok=False)
    evidence = root / 'evidence'
    (evidence / 'inputs').mkdir(parents=True)
    for name in INPUT_NAMES:
        shutil.copyfile(inputs / name, root / name)
        shutil.copyfile(inputs / name, evidence / 'inputs' / name)
    workflow = repo / '.github/workflows/thread-container.yml'
    shutil.copyfile(workflow, evidence / 'inputs/thread-container.yml')
    carrier = git(repo, 'rev-parse', 'HEAD')
    if carrier != os.environ['GITHUB_SHA']:
        raise RuntimeError('Workflow checkout does not match its dispatched SHA')
    save(evidence / 'reviewed-inputs.json', {'carrier': carrier, 'tree': git(repo, 'rev-parse', 'HEAD^{tree}'), 'workflowSha256': sha(workflow), 'inputs': {name: sha(root / name) for name in INPUT_NAMES}, 'sources': protocol['cases']})
    commands = Commands(repo, evidence / 'prepare')
    commands.checked('fixture-contract-tests', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(root), '-p', 'test_runner.py'])
    commands.checked('fetch-two-subjects', ['git', 'fetch', '--no-tags', '--depth=1', 'origin', *[source for _, source in CASES]], timeout=120)
    for _, source in CASES:
        for path, blob in protocol['originalBlobs'].items():
            if git(repo, 'rev-parse', source + ':' + path) != blob:
                raise RuntimeError('Frozen original input differs: ' + path)
    commands.checked('select-first-source', ['git', 'checkout', '--detach', CASES[0][1]])


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('prepare', 'run'):
        raise SystemExit('Usage: run.py prepare|run; no source, case-selection or retry arguments')
    require_hosted()
    repo = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    root = Path(os.environ['RUNNER_TEMP']) / 'composer-capture-diagnostic'
    if sys.argv[1] == 'prepare':
        prepare(repo, Path(__file__).resolve().parent, root)
        return
    protocol = load_protocol(root)
    results = collect_pair(lambda name, source, index: run_case(repo, root, protocol, name, source, index))
    matched = len(results) == 2 and results[0].get('runtime') == results[1].get('runtime') and bool(results[0].get('runtime'))
    summary = {'cases': results, 'runtimeMatched': matched, 'caseCount': 2, 'outerRetries': 0, 'stoppingRule': 'Stop after these two actual outcomes. No automatic attribution, baseline or gate decision.', 'complete': matched and all(r.get('complete') for r in results)}
    save(root / 'evidence/pair.json', summary)
    raise SystemExit(0 if summary['complete'] else 1)


if __name__ == '__main__':
    main()
