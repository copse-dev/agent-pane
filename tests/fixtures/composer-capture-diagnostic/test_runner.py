import copy
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('composer_diagnostic', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
INPUTS = Path(__file__).parent


def write_complete_capture(out, protocol):
    attempts = out / 'composer-observer/png-attempts'
    attempts.mkdir(parents=True)
    for index, name in enumerate(protocol['pngNames']):
        (attempts / f'{index+1}-{name}').write_bytes(b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 2400, 1600))
    def rect(x, y, width, height):
        return {'x': x, 'y': y, 'width': width, 'height': height, 'top': y, 'bottom': y + height, 'left': x, 'right': x + width}
    geometry = {
        't': 1000.5, 'dpr': 2, 'viewport': protocol['viewport'],
        'targetsUnchanged': dict.fromkeys(('composer', 'pane', 'conversation', 'transcript', 'result'), True),
        'composer': {'rect': rect(264, 687, 913, 101), 'clientWidth': 911, 'clientHeight': 99, 'borderTop': '1px', 'borderBottom': '1px'},
        'reserve': '101px',
        'conversation': {'rect': rect(241, 41, 959, 759), 'paddingBottom': '113px'},
        'transcript': {'rect': rect(241, 187, 959, 460), 'clientHeight': 460, 'scrollHeight': 492, 'scrollTop': 32, 'bottomGap': 0, 'stickyBand': '46px', 'stickyScrollBand': ''},
        'result': rect(265, 274.6953125, 896, 196), 'resultHeading': None,
    }
    kinds = ['raf', 'resize-observer', 'mutation', 'producer:copse-diag-composer-sync', 'producer:copse-diag-programmatic-scroll']
    kinds += [prefix + name for name in protocol['pngNames'] for prefix in ('png-call-before:', 'png-call-after:')]
    rows = [dict(copy.deepcopy(geometry), kind=kind) for kind in kinds]
    rows[3]['detail'] = {'producerTime': 900.5, 'detail': {'reason': 'resize-observer', 'measuredHeight': 101, 'height': 101, 'previousReserve': '99px'}}
    rows[4]['detail'] = {'producerTime': 901, 'detail': {'requested': 32, 'before': 30, 'landed': 32, 'stack': 'Error\n at setScrollTopProgrammatically'}}
    timeline = out / 'composer-observer/timeline.json'
    timeline.write_text(json.dumps(rows))
    return rows, timeline


class DiagnosticContracts(unittest.TestCase):
    def test_spawn_failure_retains_a_command_receipt_and_logs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            commands = runner.Commands(root, root / 'evidence')
            with self.assertRaises(FileNotFoundError):
                commands.run('missing', [str(root / 'nonexistent-executable')])
            record = json.loads((root / 'evidence/commands.json').read_text())[0]
            self.assertEqual(record['exit'], 125)
            self.assertTrue(record['error'])
            self.assertTrue((root / 'evidence/missing.stderr.log').exists())

    def test_command_timeout_retains_partial_stdout_and_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            commands = runner.Commands(root, root / 'evidence')
            code = commands.run('timeout', [sys.executable, '-u', '-c', 'import time; print("partial"); time.sleep(30)'], timeout=0.2)
            self.assertEqual(code, 124)
            self.assertEqual((root / 'evidence/timeout.stdout.log').read_text(), 'partial\n')
            self.assertEqual(commands.records[0]['exit'], 124)

    def test_stale_outputs_block_attribution_without_removing_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            runner.require_fresh_outputs(repo)
            (repo / '.tmp/composer-observer').mkdir(parents=True)
            raw = repo / '.tmp/composer-observer/prior.json'
            raw.write_text('previous subject')
            with self.assertRaisesRegex(RuntimeError, 'Stale case output'):
                runner.require_fresh_outputs(repo)
            with patch.object(runner, 'cleanup'):
                record = runner.run_case(repo, repo / 'carrier', runner.load_protocol(INPUTS), *runner.CASES[0], 0)
            self.assertEqual(record['specInvocations'], 0)
            self.assertFalse(record['complete'])
            self.assertIn('left untouched', record['resetError'])
            self.assertEqual(raw.read_text(), 'previous subject')

    def test_failed_first_case_does_not_drop_or_replay_either_outcome(self):
        calls = []

        def execute(name, source, index):
            calls.append((name, source, index))
            return {'name': name, 'source': source, 'complete': index == 1, 'testExit': 1 if index == 0 else 0, 'failedOutputsRetained': index == 0}

        records = runner.collect_pair(execute)
        self.assertEqual(calls, [(name, source, index) for index, (name, source) in enumerate(runner.CASES)])
        self.assertEqual([r['testExit'] for r in records], [1, 0])
        self.assertTrue(records[0]['failedOutputsRetained'])

    def test_unexpected_first_case_exception_still_attempts_only_the_other_fixed_case(self):
        calls = []

        def execute(name, source, index):
            calls.append(name)
            if not index:
                raise RuntimeError('window vanished before trace')
            return {'name': name, 'source': source, 'complete': True}

        records = runner.collect_pair(execute)
        self.assertEqual(calls, ['current', 'accepted'])
        self.assertIn('window vanished', records[0]['error'])

    def test_scope_rejects_an_extra_source_and_modified_patch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('protocol.json', 'observation.patch'):
                (root / name).write_bytes((INPUTS / name).read_bytes())
            protocol = json.loads((root / 'protocol.json').read_text())
            protocol['cases'].append({'name': 'extra', 'source': '0' * 40})
            (root / 'protocol.json').write_text(json.dumps(protocol))
            with self.assertRaisesRegex(ValueError, 'scope changed'):
                runner.load_protocol(root)
            (root / 'protocol.json').write_bytes((INPUTS / 'protocol.json').read_bytes())
            (root / 'observation.patch').write_text('arbitrary fixture replacement')
            with self.assertRaisesRegex(ValueError, 'patch changed'):
                runner.load_protocol(root)

    def test_local_other_branch_and_rerun_contexts_are_rejected_before_execution(self):
        valid = {'GITHUB_ACTIONS': 'true', 'DIAGNOSTIC_RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': 'copse-dev/agent-pane', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': runner.BRANCH, 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'composer-canonical-pair'}
        runner.validate_context(valid, 'Linux', 'x86_64', 'VERSION_ID="24.04"')
        for key, value in [('GITHUB_ACTIONS', 'false'), ('GITHUB_REF', 'refs/heads/main'), ('GITHUB_RUN_ATTEMPT', '2'), ('RUNNER_ARCH', 'ARM64'), ('DIAGNOSTIC_RUNNER_ENVIRONMENT', 'self-hosted')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                runner.validate_context({**valid, key: value}, 'Linux', 'x86_64', 'VERSION_ID="24.04"')

    def test_hydrated_references_are_never_retained_as_generated_captures(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            repo, out = Path(temp) / 'repo', Path(temp) / 'out'
            screenshots = repo / 'tests/e2e/screenshots'
            screenshots.mkdir(parents=True)
            for name in protocol['pngNames']:
                (screenshots / name).write_bytes(b'old accepted reference')
            runner.retain_outputs(repo, out, protocol)
            self.assertFalse((out / 'original-png-paths').exists())
            self.assertFalse(runner.capture_summary(out, protocol)['complete'])

    def test_failed_capture_attempts_are_all_retained_without_substitution(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            repo, out = Path(temp) / 'repo', Path(temp) / 'out'
            attempts = repo / '.tmp/composer-observer/png-attempts'
            attempts.mkdir(parents=True)
            for ordinal in (1, 2):
                (attempts / f'{ordinal}-composer-observer-bordered.png').write_bytes(b'raw attempt ' + bytes([ordinal]))
            (repo / 'e2e-failure-artifacts').mkdir()
            (repo / 'e2e-failure-artifacts/error.log').write_text('stale window')
            runner.retain_outputs(repo, out, protocol)
            self.assertEqual(len(list((out / 'composer-observer/png-attempts').iterdir())), 2)
            self.assertEqual((out / 'e2e-failure-artifacts/error.log').read_text(), 'stale window')
            self.assertFalse(runner.capture_summary(out, protocol)['complete'])

    def test_complete_capture_requires_retained_producer_details_and_exact_viewport(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            rows, timeline = write_complete_capture(out, protocol)
            attempts = out / 'composer-observer/png-attempts'
            self.assertTrue(runner.capture_summary(out, protocol)['complete'])
            final_capture = attempts / ('3-' + protocol['pngNames'][2])
            duplicate = attempts / ('4-' + protocol['pngNames'][0])
            final_capture.rename(duplicate)
            self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            duplicate.rename(final_capture)
            incomplete = copy.deepcopy(rows)
            incomplete[3]['detail'] = {'producerTime': 1}
            timeline.write_text(json.dumps(incomplete))
            self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            rows[-1]['viewport'] = {'width': 800, 'height': 600}
            timeline.write_text(json.dumps(rows))
            self.assertFalse(runner.capture_summary(out, protocol)['complete'])

    def test_missing_or_null_promised_geometry_cannot_complete_a_capture(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            rows, timeline = write_complete_capture(out, protocol)
            paths = [('t',), ('reserve',), ('result',), ('resultHeading',), ('targetsUnchanged',)]
            paths += [(group,) for group in ('composer', 'conversation', 'transcript')]
            paths += [('composer', key) for key in ('rect', 'clientWidth', 'clientHeight', 'borderTop', 'borderBottom')]
            paths += [('conversation', key) for key in ('rect', 'paddingBottom')]
            paths += [('transcript', key) for key in ('rect', 'clientHeight', 'scrollHeight', 'scrollTop', 'bottomGap', 'stickyBand', 'stickyScrollBand')]
            paths += [(group, 'rect', key) for group in ('composer', 'conversation', 'transcript') for key in ('x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right')]
            paths += [('result', key) for key in ('x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right')]
            for path in paths:
                for fault in ('missing', 'null'):
                    if path == ('resultHeading',) and fault == 'null':
                        continue  # No heading is a valid observed state in this fixture.
                    with self.subTest(path=path, fault=fault):
                        broken = copy.deepcopy(rows)
                        parent = broken[-1]
                        for key in path[:-1]:
                            parent = parent[key]
                        if fault == 'missing':
                            del parent[path[-1]]
                        else:
                            parent[path[-1]] = None
                        timeline.write_text(json.dumps(broken))
                        self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            # The originally accepted kind/DPR/viewport-only record is incomplete.
            skeleton = [{key: row[key] for key in ('kind', 'dpr', 'viewport')} for row in rows]
            timeline.write_text(json.dumps(skeleton))
            self.assertFalse(runner.capture_summary(out, protocol)['complete'])

    def test_nonfinite_or_wrong_type_geometry_and_css_values_are_incomplete(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            rows, timeline = write_complete_capture(out, protocol)
            paths = [('t',), ('composer', 'clientWidth'), ('composer', 'clientHeight')]
            paths += [('transcript', key) for key in ('clientHeight', 'scrollHeight', 'scrollTop', 'bottomGap')]
            paths += [(group, 'rect', key) for group in ('composer', 'conversation', 'transcript') for key in ('x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right')]
            paths += [('result', key) for key in ('x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right')]
            for path in paths:
                for value in (float('nan'), float('inf'), -float('inf'), True, '101', {}):
                    with self.subTest(path=path, value=value):
                        broken = copy.deepcopy(rows)
                        parent = broken[-1]
                        for key in path[:-1]:
                            parent = parent[key]
                        parent[path[-1]] = value
                        timeline.write_text(json.dumps(broken))
                        self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            for path in [('reserve',), ('composer', 'borderTop'), ('composer', 'borderBottom'), ('conversation', 'paddingBottom'), ('transcript', 'stickyBand'), ('transcript', 'stickyScrollBand')]:
                for value in ('NaNpx', 'Infinitypx', '100%', True):
                    broken = copy.deepcopy(rows)
                    parent = broken[-1]
                    for key in path[:-1]:
                        parent = parent[key]
                    parent[path[-1]] = value
                    timeline.write_text(json.dumps(broken))
                    self.assertFalse(runner.capture_summary(out, protocol)['complete'])

    def test_missing_or_replaced_targets_are_incomplete_even_with_finite_rectangles(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            rows, timeline = write_complete_capture(out, protocol)
            for key in ('composer', 'pane', 'conversation', 'transcript', 'result'):
                for value in (False, None, 1, 'true'):
                    with self.subTest(target=key, value=value):
                        broken = copy.deepcopy(rows)
                        broken[-1]['targetsUnchanged'][key] = value
                        timeline.write_text(json.dumps(broken))
                        self.assertFalse(runner.capture_summary(out, protocol)['complete'])

    def test_producer_details_must_be_present_finite_and_explicit(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            rows, timeline = write_complete_capture(out, protocol)
            for index, keys in ((3, ('measuredHeight', 'height')), (4, ('requested', 'before', 'landed'))):
                for path in [('detail', 'producerTime')] + [('detail', 'detail', key) for key in keys]:
                    for value in (None, float('nan'), float('inf'), True, '101'):
                        broken = copy.deepcopy(rows)
                        parent = broken[index]
                        for key in path[:-1]:
                            parent = parent[key]
                        parent[path[-1]] = value
                        timeline.write_text(json.dumps(broken))
                        self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            for index, key, value in ((3, 'reason', ''), (3, 'reason', 'unknown'), (3, 'previousReserve', None), (3, 'previousReserve', 'NaNpx'), (4, 'stack', ''), (4, 'stack', None)):
                broken = copy.deepcopy(rows)
                broken[index]['detail']['detail'][key] = value
                timeline.write_text(json.dumps(broken))
                self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            for index, keys in ((3, ('reason', 'measuredHeight', 'height', 'previousReserve')), (4, ('requested', 'before', 'landed', 'stack'))):
                for key in keys:
                    broken = copy.deepcopy(rows)
                    del broken[index]['detail']['detail'][key]
                    timeline.write_text(json.dumps(broken))
                    self.assertFalse(runner.capture_summary(out, protocol)['complete'])
            rows[3]['detail']['detail']['reason'] = 'initial'
            rows[3]['detail']['detail']['previousReserve'] = ''
            timeline.write_text(json.dumps(rows))
            self.assertTrue(runner.capture_summary(out, protocol)['complete'])

    def test_finite_before_after_mismatch_remains_complete_and_visible(self):
        protocol = runner.load_protocol(INPUTS)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            rows, timeline = write_complete_capture(out, protocol)
            rows[-1]['reserve'] = '99px'
            rows[-1]['composer']['rect']['height'] = 123
            rows[-1]['composer']['rect']['bottom'] = rows[-1]['composer']['rect']['top'] + 123
            rows[-1]['transcript']['clientHeight'] = 436
            rows[-1]['transcript']['rect']['height'] = 436
            rows[-1]['transcript']['rect']['bottom'] = rows[-1]['transcript']['rect']['top'] + 436
            rows[-1]['transcript']['scrollTop'] = 34
            rows[-1]['transcript']['bottomGap'] = 22
            timeline.write_text(json.dumps(rows))
            summary = runner.capture_summary(out, protocol)
            self.assertTrue(summary['complete'])
            self.assertEqual(summary['boundaries'][-1]['reserve'], '99px')
            self.assertEqual(summary['boundaries'][-1]['composer']['rect']['height'], 123)
            self.assertEqual(summary['boundaries'][-1]['transcript']['scrollTop'], 34)
            self.assertEqual(summary['boundaries'][-1]['transcript']['bottomGap'], 22)

    def test_build_archive_contains_actual_bundle_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            repo, out = Path(temp) / 'repo', Path(temp) / 'out'
            (repo / 'dist').mkdir(parents=True)
            out.mkdir()
            (repo / 'dist/renderer.js').write_bytes(b'actual compiled bytes')
            receipt = runner.archive_build(repo, out)
            import tarfile
            with tarfile.open(out / 'actual-dist.tar.gz') as archive:
                self.assertEqual(archive.extractfile('dist/renderer.js').read(), b'actual compiled bytes')
            self.assertEqual(receipt['archiveSha256'], runner.sha(out / 'actual-dist.tar.gz'))


if __name__ == '__main__':
    unittest.main()
