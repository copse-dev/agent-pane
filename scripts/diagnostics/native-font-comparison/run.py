#!/usr/bin/env python3
"""Temporary read-only provenance experiment; never accepts or publishes baselines."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from PIL import Image, ImageChops

ROOT = Path.cwd()
OUT = ROOT / '_native-font-evidence'
OUT.mkdir(exist_ok=True)
TMP = Path(os.environ['RUNNER_TEMP']) / 'native-font-comparison'
TMP.mkdir(exist_ok=True)
SOURCES = {
    'plan-old': ('66335a44247b58e95fb16ce12fb2e0c1cbc7ebda', ['thread-plan']),
    'native-old': ('b28b2e092280e508b1e647808e10b891dac675b7', ['sidebar-thread-changes', 'accent-color']),
    'current': ('392d66574036fc6f17072c41958da1fe94e11e90', ['thread-plan', 'sidebar-thread-changes', 'accent-color']),
}
PUBLIC = 'https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev/screenshots/sha256/'
errors = []
states = {}
DEADLINE = time.monotonic() + 43 * 60

def emit(kind, **data):
    row = dict(kind=kind, **data)
    print(json.dumps(row, sort_keys=True), flush=True)
    with (OUT / 'evidence.jsonl').open('a') as f:
        f.write(json.dumps(row, sort_keys=True) + '\n')

def command(args, cwd=ROOT, env=None, seconds=480, name='command'):
    seconds = min(seconds, int(DEADLINE-time.monotonic()))
    if seconds < 30:
        raise RuntimeError('Diagnostic deadline reached before '+name)
    print('RUN', name, 'cwd=', str(cwd), 'argv=', json.dumps(args), flush=True)
    with (OUT / (name + '.log')).open('w') as log:
        process = subprocess.Popen(['timeout', '-k', '15', str(seconds), *args], cwd=cwd,
                                   env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=seconds+20)
        except subprocess.TimeoutExpired:
            # Do not block reading a pipe held open by a wedged native child.
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            status = 124
    print((OUT / (name + '.log')).read_text(errors='replace'), end='', flush=True)
    if status:
        raise RuntimeError(f'{name} exited {status}')

def output(args, cwd=ROOT, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def runtime_info(binary, cwd):
    env = dict(os.environ, ELECTRON_RUN_AS_NODE='1')
    env.pop('ELECTRON_OVERRIDE_DIST_PATH', None)
    return json.loads(output([str(binary), '-p',
        'JSON.stringify({versions:process.versions,platform:process.platform,arch:process.arch})'], cwd, env))

def image_record(path):
    im = Image.open(path).convert('RGB')
    result = dict(sha256=sha(path), bytes=path.stat().st_size, dimensions=list(im.size))
    result['samples'] = {f'{x},{y}': list(im.getpixel((x,y))) for x,y in
                         [(0,15),(553,274),(553,275),(553,276),(554,274)]
                         if x < im.width and y < im.height}
    # Crop hashes plus bright chromatic pixels distinguish glyph LCD fringes from flat gray AA.
    result['crops'] = {}
    for name, box in {'assistant-T': (530,240,1050,330),
                      'plan-body': (30,400,1200,1080), 'rounded-corner': (1320,0,1520,40)}.items():
        x,y,r,b = box
        if r <= im.width and b <= im.height:
            crop = im.crop(box)
            pixels = list(crop.getdata())
            result['crops'][name] = dict(box=list(box), rgb_sha256=hashlib.sha256(crop.tobytes()).hexdigest(),
                bright_chromatic_pixels=sum(max(p)-min(p)>8 and max(p)>70 for p in pixels))
    return result

def compare(left, right, label):
    a = Image.open(left).convert('RGB')
    b = Image.open(right).convert('RGB')
    info = dict(label=label, before_sha256=sha(left), after_sha256=sha(right),
                before_dimensions=list(a.size), after_dimensions=list(b.size))
    if a.size != b.size:
        info['dimension_mismatch'] = True
    else:
        d = ImageChops.difference(a,b)
        info.update(changed_pixels=sum(p != (0,0,0) for p in d.getdata()), bbox=d.getbbox())
        if a.height>1:
            info['after_shifted_up_one_pixel_equal'] = ImageChops.difference(
                a.crop((0,0,a.width,a.height-1)), b.crop((0,1,b.width,b.height))).getbbox() is None
        info['crop_deltas'] = {}
        for name, box in {'assistant-T':(530,240,1050,330),'plan-body':(30,400,1200,1080),
                          'rounded-corner':(1320,0,1520,40)}.items():
            if box[2]<=a.width and box[3]<=a.height:
                dc=ImageChops.difference(a.crop(box),b.crop(box))
                info['crop_deltas'][name]=dict(changed_pixels=sum(p!=(0,0,0) for p in dc.getdata()),bbox=dc.getbbox())
    emit('comparison', **info)

def references(tree, source, specs):
    dest = OUT / 'references' / source
    dest.mkdir(parents=True, exist_ok=True)
    names = sorted(set(name for spec in specs for name in re.findall(
        r"['\"]([\w-]+\.png)['\"]", (tree / f'tests/e2e/{spec}.e2e.ts').read_text())))
    manifest_path=tree/'tests/e2e/screenshots/manifest.json'
    manifest=json.loads(manifest_path.read_text()).get('screenshots',{}) if manifest_path.exists() else {}
    for name in names:
        original=tree/'tests/e2e/screenshots'/name
        if original.exists():
            shutil.copy2(original,dest/name)
        elif name in manifest:
            expected=manifest[name]['sha256']
            data = subprocess.check_output(['node', '--input-type=module', '-e',
                'const r=await fetch(process.argv[1],{signal:AbortSignal.timeout(40000)});if(!r.ok)throw Error(`HTTP ${r.status}`);process.stdout.write(Buffer.from(await r.arrayBuffer()))',
                PUBLIC+expected+'.png'], cwd=tree, timeout=45)
            (dest/name).write_bytes(data)
            if sha(dest/name)!=expected:
                raise RuntimeError('Reference hash mismatch: '+name)
        else:
            raise RuntimeError('Reference missing: '+name)
        emit('original-reference', source=source, name=name, **image_record(dest/name))
    return names

# One OS/font inventory for every source/runtime; never apt-install between cases.
environment = {
    'runner_image_os': os.environ.get('ImageOS'), 'runner_image_version': os.environ.get('ImageVersion'),
    'runner_os': os.environ.get('RUNNER_OS'), 'uname': output(['uname','-a']),
    'os_release': Path('/etc/os-release').read_text(), 'node': output(['node','--version']),
    'font_packages': output(['dpkg-query','-W','fonts-noto-core','fonts-noto-cjk','fonts-noto-color-emoji','fontconfig']),
    # Default fc-list "file" output adds a colon; explicit format yields real filesystem paths.
    'font_files': output(['fc-list','--format','%{file}\n']),
}
font_hashes={}
for name in sorted(set(environment['font_files'].splitlines())):
    path=Path(name.strip())
    if path.is_file(): font_hashes[str(path)]=sha(path)
environment['font_file_sha256']=font_hashes
if not font_hashes:
    raise RuntimeError('No installed font files were hashed; environment evidence is incomplete')
(OUT/'environment.json').write_text(json.dumps(environment,indent=2))
emit('environment', **environment)

for source,(revision,specs) in SOURCES.items():
    try:
        tree=TMP/source
        if subprocess.run(['git','cat-file','-e',revision+'^{commit}'],cwd=ROOT).returncode:
            command(['git','fetch','--no-tags','origin',revision],name='fetch-'+source)
        command(['git','worktree','add','--detach',str(tree),revision],name='worktree-'+source)
        if output(['git','rev-parse','HEAD'],tree)!=revision: raise RuntimeError('Wrong source revision')
        names=references(tree,source,specs)
        # Each worktree has its own materialized node_modules and its own store inputs.
        env=dict(os.environ, npm_config_store_dir=str(TMP/('pnpm-store-'+source)),npm_config_ignore_scripts='false')
        env.pop('ELECTRON_OVERRIDE_DIST_PATH',None)
        env.pop('COPSE_E2E_CHROMEDRIVER_BINARY',None)
        command(['pnpm','install','--frozen-lockfile'],tree,env,seconds=540,name='install-'+source)
        command(['pnpm','run','build'],tree,env,seconds=420,name='build-'+source)
        electron=Path(output(['node','-p',"require('electron')"],tree,env).splitlines()[-1])
        if not electron.is_absolute() or not electron.is_file():
            raise RuntimeError('Electron executable missing after normal installation: '+str(electron))
        driver=Path(output(['node','-p',"require('node:path').join(require('node:path').dirname(require.resolve('electron-chromedriver/package.json')),'bin','chromedriver')"],tree,env))
        runtime=runtime_info(electron,tree)
        state=dict(tree=tree,names=names,specs=specs,env=env,electron=electron,driver=driver,runtime=runtime)
        states[source]=state
        emit('source',source=source,revision=revision,lock_sha256=sha(tree/'pnpm-lock.yaml'),
             electron_binary_sha256=sha(electron.resolve()),driver_binary_sha256=sha(driver.resolve()),
             driver_version=output([str(driver),'--version'],tree,env),runtime=runtime,
             # WDIO does not export ./package.json; read the installed package symlink directly.
             wdio=json.loads((tree/'node_modules/webdriverio/package.json').read_text())['version'],
             pliant_sha256=sha(tree/'assets/fonts/Pliant-Variable.ttf'),
             averia_sha256=sha(tree/'assets/fonts/AveriaSerifLibre-Regular.ttf'))
    except Exception as exc:
        errors.append(str(exc));emit('prepare-error',source=source,error=str(exc))

cases=[(source,'locked') for source in SOURCES if source in states]
if 'current' in states:
    for source in ['plan-old','native-old']:
        if source not in states: continue
        old=states[source]['runtime'];current=states['current']['runtime']
        # Supported runtime path override only when native Node ABI, OS, and arch match.
        if (old['versions']['modules'],old['platform'],old['arch']) == (current['versions']['modules'],current['platform'],current['arch']):
            cases.append((source,'shared-current'))
        else: emit('shared-runtime-skipped',source=source,reason='Native module ABI/platform/architecture differ',old=old,current=current)

for source,mode in cases:
    state=states[source];tree=state['tree'];env=dict(state['env'])
    if mode=='shared-current':
        env['ELECTRON_OVERRIDE_DIST_PATH']=str(states['current']['electron'].resolve().parent)
        env['COPSE_E2E_CHROMEDRIVER_BINARY']=str(states['current']['driver'].resolve())
    for repeat in [1,2]:
        case=f'{source}-{mode}-r{repeat}';dest=OUT/'captures'/case;dest.mkdir(parents=True,exist_ok=True)
        before_mtime={}
        case_passed=False
        try:
            # Restore original references before each run; do not inherit prior screenshot output.
            for name in state['names']:
                shutil.copy2(OUT/'references'/source/name,tree/'tests/e2e/screenshots'/name)
                before_mtime[name]=(tree/'tests/e2e/screenshots'/name).stat().st_mtime_ns
            args=['pnpm','run','test:e2e:ci','--']
            for spec in state['specs']: args+=['--spec',f'tests/e2e/{spec}.e2e.ts']
            emit('case-start',case=case,source=source,revision=SOURCES[source][0],
                 runtime_override=env.get('ELECTRON_OVERRIDE_DIST_PATH'),driver_override=env.get('COPSE_E2E_CHROMEDRIVER_BINARY'))
            command(args,tree,env,seconds=240,name=case)
            case_passed=True
        except Exception as exc:
            errors.append(str(exc));emit('case-error',case=case,error=str(exc))
        finally:
            for name in state['names']:
                path=tree/'tests/e2e/screenshots'/name
                if not path.exists(): continue
                if path.stat().st_mtime_ns == before_mtime.get(name):
                    errors.append(f'{case}: no fresh capture for {name}')
                    emit('capture-not-produced',case=case,name=name,case_passed=case_passed)
                    continue
                shutil.copy2(path,dest/name)
                emit('capture',case=case,name=name,case_passed=case_passed,**image_record(dest/name))
                compare(OUT/'references'/source/name,dest/name,f'{case}:{name}:reference-vs-render')
            failures=tree/'e2e-failure-artifacts'
            if failures.exists(): shutil.copytree(failures,dest/'failure-artifacts',dirs_exist_ok=True)
    for name in state['names']:
        paths=[OUT/'captures'/f'{source}-{mode}-r{n}'/name for n in [1,2]]
        if all(p.exists() for p in paths): compare(*paths,f'{source}-{mode}:{name}:repeat')

# Cross-source controls and shared-runtime effects, all decoded on this runner.
for old in ['plan-old','native-old']:
    if old not in states: continue
    for name in states[old]['names']:
        current=OUT/'captures/current-locked-r1'/name
        for mode in ['locked','shared-current']:
            historic=OUT/'captures'/f'{old}-{mode}-r1'/name
            if historic.exists() and current.exists(): compare(historic,current,f'{old}-{mode}:{name}:vs-current')
        locked=OUT/'captures'/f'{old}-locked-r1'/name
        shared=OUT/'captures'/f'{old}-shared-current-r1'/name
        if locked.exists() and shared.exists(): compare(locked,shared,f'{old}:{name}:runtime-only')
emit('complete',errors=errors)
sys.exit(1 if errors else 0)
