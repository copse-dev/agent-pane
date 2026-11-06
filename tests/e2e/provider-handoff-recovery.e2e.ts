import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../src/shared/safe-json.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { agentIsIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const MODEL = 'qwen/qwen3.6-35b-a3b'
const NEW_GOAL = 'NEW_PROVIDER_GOAL_72f4'
let root = ''
let localCalls = 0
const bodySchema = z.object({
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
})
const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString()
  })
  request.on('end', () => {
    if (request.url?.endsWith('/models')) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify(
          request.url.includes('/api/')
            ? { models: [{ key: MODEL, type: 'llm' }] }
            : { data: [{ id: MODEL }] },
        ),
      )
      return
    }
    const parsed = safeJsonParse(body, decodeWithSchema(bodySchema))
    if (!parsed?.tools?.some((tool) => tool.function.name === 'write_file')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Provider handoff fixture' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    localCalls++
    if (localCalls === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'checkpoint', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'checkpoint.txt', content: 'completed before provider failure\n' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
    } else {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { type: 'authentication_error', message: 'Synthetic expired credential' },
        }),
      )
    }
  })
})
async function chooseModel(prefix: string): Promise<void> {
  const picker = $('.footer-model-host .model-picker')
  await picker.$('.model-picker-trigger').click()
  const menu = picker.$('.model-picker-menu')
  await menu.waitForDisplayed({ timeout: 10_000 })
  const browse = menu.$('[aria-label="Browse all models"]')
  if (await browse.isDisplayed()) await browse.click()
  const option = menu.$(`.model-picker-option[data-value^="${prefix}"]`)
  await option.waitForDisplayed({ timeout: 15_000 })
  await option.click()
}
async function settle(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const dialog = $('#approval-dialog')
      if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true)
        await dialog.$('.approval-approve').click()
      return agentIsIdle()
    },
    { timeout: 45_000, interval: 100, timeoutMsg: 'handoff turn did not settle' },
  )
}
async function send(text: string): Promise<void> {
  await setComposerValue(text)
  await submitComposer()
}

describe('recover into a reused ACP session after another provider', function () {
  this.timeout(120_000)
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-provider-handoff-'))
    writeFileSync(
      join(root, 'fixture-agent.cjs'),
      `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let r={};
if(q.method==='initialize')r={protocolVersion:1,agentCapabilities:{},authMethods:[],agentInfo:{name:'History fixture',version:'1'}};
if(q.method==='session/new'){fs.appendFileSync('wire.jsonl',JSON.stringify({kind:'new'})+'\\n');r={sessionId:'history-session',configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'ready',options:[{value:'ready',name:'Ready'},{value:'holding',name:'Holding'}]}]}};
if(q.method==='session/set_config_option'){fs.writeFileSync('config-held','');const timer=setInterval(()=>{if(!fs.existsSync('release-config'))return;clearInterval(timer);send({jsonrpc:'2.0',id:q.id,result:{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:q.params.value,options:[{value:'ready',name:'Ready'},{value:'holding',name:'Holding'}]}]}})},20);return};
if(q.method==='session/prompt'){const text=q.params.prompt.filter(b=>b.type==='text').map(b=>b.text).join('');fs.appendFileSync('wire.jsonl',JSON.stringify({kind:'prompt',text})+'\\n');const n=fs.readFileSync('wire.jsonl','utf8').split('\\n').filter(x=>x.includes('"kind":"prompt"')).length;const reply=n===1?'Completed the old goal.':text.includes('${NEW_GOAL}')?'Recovered the current provider request.':'STALE: still answering the old goal.';send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'history-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:reply}}}});r={stopReason:'end_turn'}};
send({jsonrpc:'2.0',id:q.id,result:r})});process.stdin.on('end',()=>process.exit(0));\n`,
    )
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@copse.invalid',
        'commit',
        '-m',
        'Synthetic ACP provider handoff fixture',
      ],
      { cwd: root },
    )
    const url = await new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('missing fixture address'))
          return
        }
        resolve(`http://127.0.0.1:${String(address.port)}/v1`)
      })
    })
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '0',
      LM_STUDIO_API_KEY: 'fixture-key',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    })
    resetUserData()
    seedEmptyProject(root, 'e2e-provider-handoff-recovery', {
      model: 'acp:history-fixture',
      localServerUrl: url,
      localDefaultModel: MODEL,
      roleModels: { research: `lmstudio:${MODEL}` },
      subagentsEnabled: false,
      registeredAcpAgents: [
        {
          id: 'history-fixture',
          title: 'History fixture',
          command: process.execPath,
          args: [join(root, 'fixture-agent.cjs')],
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'ready', label: 'Ready' },
            { value: 'holding', label: 'Holding' },
          ],
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(async () => {
    await saveAppScreenshot('provider-handoff-final-state.png')
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '1', LM_STUDIO_API_KEY: '' })
    resetUserData()
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    if (root) removeE2eTree(root)
  })

  it('delivers the intervening request and partial progress without replacing the agent session', async () => {
    await send('OLD_AGENT_GOAL: finish the first request.')
    await settle()
    await expect($('.messages-list')).toHaveText('Completed the old goal.', { containing: true })
    await chooseModel(`lmstudio:${MODEL}`)
    await send(
      `${NEW_GOAL}: checkpoint the current request, then finish it. If the provider fails, continue from the checkpoint.`,
    )
    await $('[data-turn-recovery-card]').waitForDisplayed({ timeout: 30_000 })
    assert.equal(
      readFileSync(join(root, 'checkpoint.txt'), 'utf8'),
      'completed before provider failure\n',
    )
    await chooseModel('acp:history-fixture')
    await $('[data-turn-recovery-card]').$('button*=Retry this turn').click()
    await settle()
    await expect($('.messages-list')).toHaveText('Recovered the current provider request.', {
      containing: true,
    })
    await expect($('.messages-list')).not.toHaveText('STALE: still answering the old goal.', {
      containing: true,
    })
    const records = readFileSync(join(root, 'wire.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) =>
        safeJsonParse(
          line,
          decodeWithSchema(z.object({ kind: z.string(), text: z.string().optional() })),
        ),
      )
    assert.equal(
      records.filter((record) => record?.kind === 'new').length,
      1,
      'the existing ACP session must be retained',
    )
    const prompts = records.filter((record) => record?.kind === 'prompt')
    assert.equal(prompts.length, 2)
    assert.ok(prompts[1]?.text?.includes(NEW_GOAL))
    assert.equal(localCalls, 2, 'the completed local write must not be repeated')
    await saveAppScreenshot('provider-handoff-current-request-recovered.png')
  })

  it('keeps unseen provider context when Stop cancels before prompt dispatch', async () => {
    const goal = 'SECOND_PROVIDER_REQUEST_91c2'
    const promptRecords = (): string[] =>
      readFileSync(join(root, 'wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.includes('"kind":"prompt"'))
    await chooseModel(`lmstudio:${MODEL}`)
    await send(
      `${NEW_GOAL}: ${goal}. Continue using the existing checkpoint and finish this newer request.`,
    )
    await $('[data-turn-recovery-card]').waitForDisplayed({ timeout: 30_000 })
    await chooseModel('acp:history-fixture#holding')
    await $('[data-turn-recovery-card]').$('button*=Retry this turn').click()
    await browser.waitUntil(async () => existsSync(join(root, 'config-held')), { timeout: 15_000 })
    await $('.stop-btn').click()
    writeFileSync(join(root, 'release-config'), '')
    await settle()
    assert.equal(promptRecords().length, 2, 'Stop during configuration must not dispatch a prompt')
    await send('Continue the interrupted provider request from the existing checkpoint.')
    await settle()
    const prompts = promptRecords()
    assert.equal(prompts.length, 3)
    assert.ok(
      prompts.at(-1)?.includes(goal),
      'the stopped turn must not consume unseen provider history',
    )
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            [...document.querySelectorAll('.msg-assistant .message-text')]
              .at(-1)
              ?.textContent.includes('Recovered the current provider request.') === true,
        ),
      { timeout: 10_000 },
    )
    assert.equal(
      readFileSync(join(root, 'checkpoint.txt'), 'utf8'),
      'completed before provider failure\n',
    )
    await saveAppScreenshot('provider-handoff-cancel-before-dispatch-recovered.png')
  })
})
