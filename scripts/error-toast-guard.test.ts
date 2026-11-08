import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'

const run = promisify(execFile)

it('enforces the actual E2E, CI and eval config guards through pinned WDIO without a browser', async () => {
  const root = await mkdtemp(resolve('.tmp/error-toast-guard-'))
  const output = join(root, 'compiled')
  try {
    await build({
      entryPoints: {
        'wdio.conf': resolve('wdio.conf.ts'),
        'wdio.ci.conf': resolve('wdio.ci.conf.ts'),
        'wdio.eval.conf': resolve('wdio.eval.conf.ts'),
        assertions: resolve('tests/e2e/helpers/assert-no-error-toasts.ts'),
        guard: resolve('tests/e2e/helpers/error-toast-guard.ts'),
        unsupported: resolve('src/renderer/attachments/handle-file-drop.ts'),
        toast: resolve('src/renderer/views/toast.ts'),
      },
      outdir: output,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      banner: {
        js: "import {createRequire as createOfflineRequire} from 'node:module';const require=createOfflineRequire(import.meta['url']);",
      },
      outExtension: { '.js': '.mjs' },
      external: ['@wdio/globals', 'electron', 'electron-chromedriver'],
      plugins: [
        {
          name: 'offline-native-boundaries',
          setup(builder): void {
            builder.onLoad({ filter: /[/\\]electron-executable\.ts$/ }, () => ({
              contents: 'export function resolveElectronExecutable(){return "/offline/electron"}',
              loader: 'js',
            }))
            builder.onLoad({ filter: /[/\\]electron-browser-version\.ts$/ }, () => ({
              contents: 'export function resolveElectronBrowserVersion(){return "1"}',
              loader: 'js',
            }))
            builder.onResolve({ filter: /^node:child_process$/ }, () => ({
              path: 'child-process-boundary',
              namespace: 'offline-native-boundary',
            }))
            builder.onLoad({ filter: /.*/, namespace: 'offline-native-boundary' }, () => ({
              contents: `function blocked(){globalThis.offlineKillCalls=(globalThis.offlineKillCalls??0)+1;throw new Error('Offline subprocess boundary')}
export {blocked as execFileSync,blocked as execSync,blocked as execFile,blocked as exec,blocked as spawn,blocked as spawnSync};`,
              loader: 'js',
            }))
          },
        },
      ],
    })
    const requireFromProject = createRequire(join(process.cwd(), 'package.json'))
    const mochaAdapter = join(
      dirname(requireFromProject.resolve('@wdio/mocha-framework/package.json')),
      'build/index.js',
    )
    // The installed local runner declares @wdio/runner as its dependency.
    const localRunnerRoot = await realpath(resolve('node_modules/@wdio/local-runner'))
    const workerRunner = join(localRunnerRoot, '../runner/build/index.js')
    const fixture = join(root, 'body.mjs')
    await writeFile(
      fixture,
      `describe('offline toast guard',()=>{afterEach(async()=>globalThis.toastFixture.cleanup());it('body',async()=>globalThis.toastFixture.body())})`,
    )
    const probe = join(root, 'probe.mjs')
    await writeFile(
      probe,
      String.raw`import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {_setGlobal} from '@wdio/globals';
import {JSDOM} from 'jsdom';
const [compiled,fixture,adapterPath,runnerPath]=process.argv.slice(2);
const framework=(await import(pathToFileURL(adapterPath).href)).default;
const Runner=(await import(pathToFileURL(runnerPath).href)).default;
const assertions=await import(pathToFileURL(join(compiled,'assertions.mjs')).href);
const guard=await import(pathToFileURL(join(compiled,'guard.mjs')).href);
const unsupported=await import(pathToFileURL(join(compiled,'unsupported.mjs')).href);
const toast=await import(pathToFileURL(join(compiled,'toast.mjs')).href);
let ledger=[],visible=[],fault,executeCalls=0;
function documentWith(messages=[]){
  ledger=[...messages];visible=[];
  globalThis.window={__copseE2e:{getErrorToasts:()=>[...ledger]}};
  globalThis.document={querySelectorAll:()=>visible.map(textContent=>({textContent}))};
}
documentWith();
_setGlobal('browser',{
  async execute(fn,...args){executeCalls++;if(fault==='hang')return new Promise(()=>{});if(fault)throw fault;return fn(...args)},
  async saveScreenshot(){throw new Error('No image/browser in this offline fixture')},
});

// Exercise the actual product boundary once: unsupported HEIC is a DOM-only error.
const dom=new JSDOM('<!doctype html><body></body>');
globalThis.window=dom.window;globalThis.document=dom.window.document;
window.__copseE2e={getErrorToasts:()=>[...ledger],pushErrorToast:message=>ledger.push(message)};
const unused=()=>{throw new Error('Unsupported HEIC must not stage an attachment or read a file')};
await unsupported.attachFiles([new File([new Uint8Array([0,1,2,3])],'photo.heic',{type:'image/heic'})],
  {attachFile:unused,attachTextBlock:unused,quoteText:unused,attachImage:unused,attachVideo:unused,attachArchive:unused},
  {fs:{readFile:unused,readImage:unused}},null);
const expectedToast=document.querySelector('.toast-error');
assert.ok(expectedToast);assert.equal(expectedToast.textContent,unsupported.UNSUPPORTED_IMAGE_MESSAGE);
assert.equal(document.querySelectorAll('.attachment-chips .image-chip').length,0);
assert.deepEqual(ledger,[]);
assert.deepEqual(await assertions.collectErrorToasts(),[unsupported.UNSUPPORTED_IMAGE_MESSAGE]);
await assert.rejects(assertions.assertNoErrorToasts(),guard.UnexpectedErrorToastsError);
await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Actual product toast did not naturally dismiss'))},10000);
  const observer=new window.MutationObserver(()=>{
    if(!expectedToast.isConnected){clearTimeout(timer);observer.disconnect();resolve()}
  });
  observer.observe(document.body,{childList:true,subtree:true});
});
assert.deepEqual(ledger,[]);await assertions.assertNoErrorToasts();
toast.showErrorToast('Unexpected',new Error('recorded application fault'));
assert.deepEqual(ledger,['Unexpected: recorded application fault']);
document.querySelector('.toast-error').click();
assert.equal(document.querySelector('.toast-error'),null);
await assert.rejects(assertions.assertNoErrorToasts(),guard.UnexpectedErrorToastsError);
dom.window.close();documentWith();

const configs=[];
for(const name of ['wdio.conf','wdio.ci.conf','wdio.eval.conf']) configs.push([name,(await import(pathToFileURL(join(compiled,name+'.mjs')).href)).config]);
assert.equal(globalThis.offlineKillCalls??0,0);
const results=[];
async function runCase(name,config,scenario,expected,legacy=false){
  documentWith();fault=undefined;executeCalls=0;globalThis.offlineKillCalls=0;
  const rootErrors=[];
  const realHook=config.mochaOpts.rootHooks.afterEach;
  assert.equal(typeof realHook,'function');
  globalThis.toastFixture={body:async()=>{},cleanup:async()=>{}};
  if(['unexpected','cleanup-replaces-document','cleanup-dies','cleanup-throws'].includes(scenario))globalThis.toastFixture.body=async()=>{ledger.push('application fault')};
  if(scenario==='expected'||scenario==='expected-plus-unexpected'||scenario==='repeated'||scenario==='still-visible'||scenario==='ledger-only')globalThis.toastFixture.body=async()=>{
    visible=['expected'];
    assert.deepEqual(ledger,[]);
    assert.deepEqual(await assertions.collectErrorToasts(),['expected']);
    if(scenario!=='still-visible')visible=[];
    if(scenario==='expected-plus-unexpected')ledger.push('additional error');
    if(scenario==='repeated')ledger.push('expected','expected');
    if(scenario==='ledger-only')ledger.push('expected');
  };
  if(scenario==='body-fails')globalThis.toastFixture.body=async()=>{throw new Error('original body failure')};
  if(scenario==='cleanup-replaces-document')globalThis.toastFixture.cleanup=async()=>documentWith();
  if(scenario==='cleanup-dies')globalThis.toastFixture.cleanup=async()=>{fault=new Error('invalid session id')};
  if(scenario==='cleanup-throws')globalThis.toastFixture.cleanup=async()=>{throw new Error('later cleanup failure')};
  if(scenario==='cleanup-new-error')globalThis.toastFixture.cleanup=async()=>{ledger.push('cleanup application fault')};
  if(scenario==='looks-like-transport')globalThis.toastFixture.body=async()=>{ledger.push('ECONNREFUSED: Timeout of 30000ms exceeded')};
  if(scenario==='transport')globalThis.toastFixture.body=async()=>{fault=new Error('invalid session id')};
  if(scenario==='budget')globalThis.toastFixture.body=async()=>{fault='hang'};
  const roots=legacy?undefined:{...config.mochaOpts.rootHooks,async afterEach(){try{await realHook.call(this)}catch(error){rootErrors.push(error);throw error}}};
  const testConfig={...config,rootDir:process.cwd(),mochaOpts:{...config.mochaOpts,timeout:15000,rootHooks:roots},
    ...(legacy?{afterTest:async()=>assertions.assertNoErrorToasts('legacy')}:{})};
  const adapter=await framework.init('offline-0',testConfig,[fixture],{},new EventEmitter());
  assert.equal(adapter.hasTests(),true);
  const failures=await adapter.run();
  assert.equal(failures,scenario==='cleanup-throws'?2:expected,name+':'+scenario);
  if(['unexpected','cleanup-replaces-document','cleanup-dies','cleanup-throws','expected-plus-unexpected','repeated','still-visible','ledger-only','cleanup-new-error','looks-like-transport'].includes(scenario)&&!legacy){
    assert.ok(rootErrors.some(error=>error instanceof guard.UnexpectedErrorToastsError),name+':'+scenario+' must retain the actual typed invariant fault');
  }
  const worker=new Runner();
  const reporter=new EventEmitter();reporter.waitForSync=async()=>{};
  worker._reporter=reporter;
  let exitCode;
  worker.on('exit',code=>{exitCode=code});
  await worker._shutdown(failures,0);
  assert.equal(exitCode,expected===0?0:1);
  if(scenario==='transport'||scenario==='budget'){
    if(name==='wdio.eval.conf')assert.equal(globalThis.offlineKillCalls,0);
    else{assert.equal(executeCalls,1);assert.equal(globalThis.offlineKillCalls,2)}
  }else assert.equal(globalThis.offlineKillCalls,0);
  results.push({config:name,scenario,mochaFailures:failures,workerExit:exitCode,executeCalls});
}
for(const [name,config] of configs){
  for(const [scenario,expected] of [['clean',0],['unexpected',1],['expected',0],['expected-plus-unexpected',1],['repeated',1],['still-visible',1],['ledger-only',1],['body-fails',1],['cleanup-replaces-document',1],['cleanup-dies',1],['cleanup-throws',1],['cleanup-new-error',1],['looks-like-transport',1]])await runCase(name,config,scenario,expected);
  await runCase(name,config,'transport',name==='wdio.eval.conf'?1:0);
  if(name==='wdio.conf')await runCase(name,config,'budget',0);
  await runCase(name,config,'clean',0);
}
await runCase('legacy-log-only-control',configs[0][1],'unexpected',0,true);

documentWith();assert.deepEqual(await assertions.collectErrorToasts(),[]);
documentWith(['new document fault']);assert.deepEqual(await assertions.collectErrorToasts(),['new document fault']);
for(const [,config]of configs){
  await assert.rejects(config.mochaOpts.rootHooks.afterEach.call({}),guard.UnexpectedErrorToastsError);
  await assert.rejects(config.mochaOpts.rootHooks.afterEach.call({currentTest:{title:'unknown state'}}),guard.UnexpectedErrorToastsError);
}
console.log('OFFLINE_TOAST_GUARD_RESULT '+JSON.stringify({adapter:'installed @wdio/mocha-framework',worker:'installed @wdio/runner',network:false,browser:false,results,actualProductBoundary:['HEIC DOM-only/natural dismissal','showErrorToast ledger survives real dismissal']}));
`,
    )
    const result = await run(
      process.execPath,
      [probe, output, fixture, mochaAdapter, workerRunner],
      { cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    )
    assert.match(result.stdout, /OFFLINE_TOAST_GUARD_RESULT /)
    assert.match(result.stderr, /E2E error-toast guard failed/)
    console.log(result.stdout.trim())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
