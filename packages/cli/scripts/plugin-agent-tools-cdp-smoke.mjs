// Separate real Chrome/CDP integration checkpoint. It never opens or inspects Codex.
// Build the selected exact Host checkout first; the script never builds watched dist.
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
const [hostInput, chatInput, reportInput] = process.argv.slice(2)
if (!hostInput || !chatInput || !reportInput) {
  throw new Error('Usage: node plugin-agent-tools-cdp-smoke.mjs HOST_CHECKOUT CHATROOM_CHECKOUT REPORT.json')
}
const host = path.resolve(hostInput)
const chat = path.resolve(chatInput)
const reportPath = path.resolve(reportInput)
const revision = async root => (await promisify(execFile)('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
const hostSha = await revision(host)
const chatSha = await revision(chat)
const hostPackage = JSON.parse(await readFile(path.join(host, 'packages/cli/package.json'), 'utf8'))
const protocolSha = hostPackage.dependencies['@cordisx/protocol'].split('#')[1]
const hostModule = name => import(pathToFileURL(`${host}/packages/cli/dist/src/${name}.js`))
const { buildRendererBundle } = await hostModule('launcher/bundle')
const { createOwnerDocumentBridgeHandler, OwnerDocumentLeaseRegistry } = await hostModule('launcher/owner-document-rpc')
const { OwnerDocumentStore } = await hostModule('launcher/owner-document-store')
const { install } = await hostModule('launcher/cdp-installation')
const { uninstall } = await hostModule('launcher/cdp-installation-support')
const { CdpSession } = await hostModule('launcher/cdp-session')
const { findFreeLoopbackPort } = await hostModule('launcher/process')
const root = await mkdtemp('/tmp/cordisx-real-cdp-tools-')
const entry = path.join(root, 'fixture.ts')
const actualEntry = path.join(chat, 'src/chatroom.ts')
const source = pathToFileURL(actualEntry).href
const sessionId = 'session-real-cdp-agent'
const capabilities = [
  'agents.create',
  'agents.get',
  'agents.live.subscribe',
  'sessions.get',
  'sessions.read',
  'sessions.subscribe',
]
const manifest = {
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v6.schema.json',
  schemaVersion: 6,
  id: 'chatroom',
  services: [],
  capabilities: capabilities.map(name => ({ name, required: false, scope: { sessionIds: [sessionId] } })),
}
const fixture = `
import { DurableChatroomRoomStore } from ${JSON.stringify(chat + '/src/room-store.ts')};
import { createRoom, addRoomRun, bindRoomRunSession } from ${JSON.stringify(chat + '/src/room.ts')};
import { ChatroomCliBindings } from ${JSON.stringify(chat + '/src/room-cli-bindings.ts')};
import { ChatroomConversationController } from ${JSON.stringify(chat + '/src/conversation-source.ts')};
import { ChatroomAgentSessionController } from ${JSON.stringify(chat + '/src/agent-session-controller.ts')};
import { ChatroomPageSource } from ${JSON.stringify(chat + '/src/chatroom-page-source.ts')};
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from ${JSON.stringify(chat + '/src/agent-definition.ts')};
export const manifest=${JSON.stringify(manifest)};
export const inject=['agents','sessions','approvals','documents','agentTools','settings'];
export function apply(ctx) {
  globalThis.__smokeContextReady=true;
  globalThis.__smokeStart=async()=>{
    globalThis.__smokeStartComplete=false;
    globalThis.__smokeStartError=undefined;
    try {
      const acquired=await ctx.agents.create({sessionId:${
  JSON.stringify(sessionId)
},mutationId:'create-real-cdp-agent'});
      if(acquired.status!=='accepted')throw new Error('real Host Session create '+JSON.stringify(acquired));
      const store=await DurableChatroomRoomStore.openOwnerDocuments(ctx.documents);
      let room=createRoom({id:'room-real-cdp',title:'Real CDP Room'});
      room=createRoom({...room,participants:[{id:'human',kind:'human',name:'You'},...room.memberships.map(member=>({id:member.participantId,kind:'agent',name:member.label}))]});
      const member=room.memberships[0];
      room=addRoomRun(room,{runId:'run-real-cdp',memberId:member.memberId,status:'creating'});
      room=bindRoomRunSession(room,'run-real-cdp',acquired.sessionId);
      await store.upsert(room);
      const collaboration=new ChatroomCliBindings(ctx.agentTools,store,ctx.settings);
      await collaboration.ensureBound(room,room.runs[0]);
      const sessions=new ChatroomAgentSessionController({agents:ctx.agents,sessions:ctx.sessions,approvals:ctx.approvals},CHATROOM_DEFAULT_AGENT_CONFIGURATION,store);
      const domain=new ChatroomConversationController(store.rooms);
      const settings={current:'enter',subscribe:()=>()=>{}};
      const page=new ChatroomPageSource(domain,sessions,settings);
      await page.hydrate(room.id);
      globalThis.__smokeRead=async()=>{
        const stored=await ctx.documents.load('room-registry');
        return {stored,page:page.getSnapshot(room.id)};
      };
      globalThis.__smokeColdRead=()=>{
        globalThis.__smokeColdComplete=false;
        globalThis.__smokeColdError=undefined;
        globalThis.__smokeColdResult=undefined;
        void (async()=>{
          const coldStore=await DurableChatroomRoomStore.openOwnerDocuments(ctx.documents);
          const coldSessions=new ChatroomAgentSessionController({agents:ctx.agents,sessions:ctx.sessions,approvals:ctx.approvals},CHATROOM_DEFAULT_AGENT_CONFIGURATION,coldStore);
          const coldDomain=new ChatroomConversationController(coldStore.rooms);
          const coldPage=new ChatroomPageSource(coldDomain,coldSessions,settings);
          try {
            await coldPage.hydrate(room.id);
            return coldPage.getSnapshot(room.id);
          } finally {
            coldPage.dispose();
            try {
              await coldSessions.dispose();
            } finally {
              try {
                coldDomain.dispose();
              } finally {
                coldStore.dispose();
              }
            }
          }
        })().then(
          result=>{globalThis.__smokeColdResult=result;globalThis.__smokeColdComplete=true},
          error=>{globalThis.__smokeColdError=String(error?.stack??error)},
        );
      };
      globalThis.__smokeRevoke=()=>collaboration.revoke(acquired.sessionId);
      ctx.effect(()=>async()=>{
        page.dispose();
        try {
          await sessions.dispose();
        } finally {
          try {
            domain.dispose();
          } finally {
            try {
              await collaboration.dispose();
            } finally {
              store.dispose();
            }
          }
        }
      },'chatroom-cdp-smoke');
      globalThis.__smokeStartComplete=true;
    }catch(error){globalThis.__smokeStartError=String(error?.stack??error)}
  };
}
`
await writeFile(entry, fixture)
const config = {
  version: 1,
  rootDir: host,
  codex: { debugPort: 0, agentLoopBackend: 'mock' },
  providers: [],
  plugins: [{ id: 'chatroom', source, entry, enabled: true, config: { cliReporting: true }, manifest }],
}
const generation = 'real-cdp-cli-validation'
const secret = randomBytes(32).toString('hex')
const leases = new OwnerDocumentLeaseRegistry({ stable: [{ pluginId: 'chatroom', source }] })
const authority = createOwnerDocumentBridgeHandler({
  secret,
  profileId: 'smoke',
  generation,
  store: new OwnerDocumentStore(root),
  principalAllowed: principal => leases.allowed(principal),
  plugins: [{ id: 'chatroom', source, entry: actualEntry, enabled: true, config: { cliReporting: true } }],
})
console.log('PHASE build production renderer')
let observedSetup
const actualHandle = authority.agentTools.handle.bind(authority.agentTools)
authority.agentTools.handle = async (value, dispatch) => {
  const result = await actualHandle(value, dispatch)
  if (value.operation === 'agent-tools-bind') {
    observedSetup = await actualHandle(
      { ...value, operation: 'agent-tools-setup', bindingId: result.bindingId },
      dispatch,
    )
  }
  return result
}
const bundle = await buildRendererBundle(config, {
  playground: true,
  profileId: 'smoke',
  generation,
  ownerDocumentAuthority: { secret, profileId: 'smoke', generation },
})
console.log('BUNDLE BYTES', Buffer.byteLength(bundle))
const http = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET' && req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.end(bundle)
    return
  }
  if (req.method !== 'GET' || req.url !== '/') {
    res.writeHead(404)
    res.end()
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end(
    '<!doctype html><html lang="en"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div><main data-cordisx-playground-seat="main"></main></body></html>',
  )
})
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${http.address().port}`
// Deliver the unchanged production IIFE over the fixture's HTTP server. Sending
// its inline source maps through one CDP command can exceed Chrome's deadline.
const bootstrap = `globalThis.__smokeBundleLoaded = new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = ${JSON.stringify(url + '/bundle.js')};
  script.onload = () => resolve(true);
  script.onerror = () => reject(new Error('fixture production bundle failed to load'));
  const append = () => (document.head ?? document.documentElement).append(script);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', append, { once: true });
  else append();
});`
const port = await findFreeLoopbackPort()
const browser = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(root, 'chrome')}`,
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] })
const browserExit = new Promise(resolve => {
  browser.once('error', error => resolve({ error: String(error) }))
  browser.once('exit', (code, signal) => resolve({ code, signal }))
})
let stderr = ''
browser.stderr.on('data', value => {
  stderr = (stderr + value).slice(-2000)
})
let cdp, installed, report, cleanup, primaryError
const cleanupErrors = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  let target
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(item => item.type === 'page' && item.url.startsWith(url))
      if (target) break
    } catch {}
    await pause(100)
  }
  if (!target) throw new Error('Chrome unavailable ' + stderr)
  console.log('PHASE production CDP install', port)
  try {
    installed = await install(target, bootstrap, undefined, undefined, undefined, authority)
  } catch (error) {
    console.error('INSTALL ERROR', error?.stack ?? String(error))
    console.error('CHROME STDERR TAIL', stderr)
    throw error
  }
  console.log('PHASE installed')
  cdp = await CdpSession.connect(target.webSocketDebuggerUrl)
  const evaluate = async expression => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 30000)
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
    return reply.result?.value
  }
  const allowedFixtureCapabilities = new Set(capabilities)
  const pumpFixtureApprovals = async (phase, completeExpression, errorExpression) => {
    for (let i = 0; i < 160; i++) {
      const state = await evaluate(
        `({complete:Boolean(${completeExpression}),error:${errorExpression},text:document.body.innerText.slice(-2500),buttons:[...document.querySelectorAll("button")].map(b=>({text:b.textContent,disabled:b.disabled}))})`,
      )
      if (state.error) throw new Error(state.error)
      if (state.complete) return
      if (i === 10 || i === 40) console.log('PENDING', phase, JSON.stringify(state))
      const prompts = [...state.text.matchAll(/chatroom 请求 ([a-z.]+)/gu)]
      const capability = prompts.at(-1)?.[1]
      if (
        capability !== undefined && allowedFixtureCapabilities.has(capability)
        && state.text.includes('one exact Agent Session')
        && state.buttons.some(button => button.text === '仅此次允许' && !button.disabled)
      ) {
        console.log('PERMISSION', phase, capability)
        await evaluate(
          '(()=>{const buttons=[...document.querySelectorAll("button")].filter(button=>button.textContent==="仅此次允许"&&!button.disabled);if(buttons.length!==1)throw new Error("expected one fixture permission button");buttons[0].click();return true})()',
        )
      }
      await pause(200)
    }
    throw new Error(`${phase} did not complete`)
  }
  await evaluate('globalThis.__smokeBundleLoaded')
  for (let i = 0; i < 100; i++) {
    if (await evaluate('globalThis.__smokeContextReady===true')) break
    await pause(100)
  }
  console.log(
    'BOOT',
    JSON.stringify(
      await evaluate('({ready:__smokeContextReady===true,plugins:globalThis.__cordisxRuntime?.snapshot().plugins})'),
    ),
  )
  console.log('PHASE fixture startup')
  await evaluate('void globalThis.__smokeStart()')
  await pumpFixtureApprovals(
    'fixture startup',
    'globalThis.__smokeStartComplete===true',
    'globalThis.__smokeStartError',
  )
  console.log('PHASE fixture startup complete')
  const setup = observedSetup
  if (!setup) throw new Error('fixture setup not ready')
  assert.match(setup.skills[0].content, /Actively report/)
  const command = setup.commands[0]
  const argv = [
    ...command.argv.slice(1),
    'send',
    '--operation',
    'real-cdp-report',
    '--text',
    'Real CDP authenticated Room report.',
  ]
  console.log('PHASE CLI first')
  const first = JSON.parse((await promisify(execFile)(command.argv[0], argv)).stdout)
  assert.equal(first.status, 'accepted')
  console.log('PHASE CLI first accepted', first.messageId)
  console.log('PHASE CLI replay')
  const replay = JSON.parse((await promisify(execFile)(command.argv[0], argv)).stdout)
  assert.equal(replay.disposition, 'replayed')
  assert.equal(first.messageId, replay.messageId)
  console.log('PHASE CLI replay confirmed', replay.messageId)
  console.log('PHASE live page projection')
  await pause(350)
  const result = await evaluate('globalThis.__smokeRead()')
  assert.equal(result.stored.status, 'loaded')
  const room = result.stored.snapshot.value.rooms.find(item => item.id === 'room-real-cdp')
  assert.equal(room.cliMessages.length, 1)
  const pageMessages = result.page.items.filter(item => item.kind === 'message' && item.source === 'chatroom-cli')
  assert.deepEqual(pageMessages.map(item => item.messageId), room.cliMessages.map(item => item.messageId))
  const pageMessage = pageMessages.find(item => item.messageId === first.messageId)
  assert.ok(pageMessage)
  assert.equal(pageMessage.author.participantId, room.cliMessages[0].participantId)
  assert.equal(pageMessage.body[0].text.fallback, room.cliMessages[0].text)
  assert.equal(pageMessage.timestamp, room.cliMessages[0].timestamp)
  assert.equal(pageMessage.semantic.causation.operationId, room.cliMessages[0].operationId)
  console.log('PHASE live page projection confirmed')
  console.log('PHASE cold page projection')
  await evaluate('void globalThis.__smokeColdRead()')
  await pumpFixtureApprovals(
    'cold page projection',
    'globalThis.__smokeColdComplete===true',
    'globalThis.__smokeColdError',
  )
  const coldPage = await evaluate('globalThis.__smokeColdResult')
  const coldMessages = coldPage.items.filter(item => item.kind === 'message' && item.source === 'chatroom-cli')
  assert.deepEqual(coldMessages.map(item => item.messageId), room.cliMessages.map(item => item.messageId))
  const coldMessage = coldMessages.find(item => item.messageId === first.messageId)
  assert.ok(coldMessage)
  assert.equal(coldMessages.filter(item => item.messageId === first.messageId).length, 1)
  assert.equal(coldMessage.author.participantId, room.cliMessages[0].participantId)
  assert.equal(coldMessage.body[0].text.fallback, room.cliMessages[0].text)
  assert.equal(coldMessage.timestamp, room.cliMessages[0].timestamp)
  assert.equal(coldMessage.semantic.causation.operationId, room.cliMessages[0].operationId)
  const afterCold = await evaluate('globalThis.__smokeRead()')
  assert.deepEqual(afterCold.stored, result.stored, 'cold page hydration must not rewrite Host owner documents')
  console.log('PHASE cold page projection confirmed')
  console.log('PHASE revoke')
  await evaluate('globalThis.__smokeRevoke()')
  await assert.rejects(promisify(execFile)(command.argv[0], argv))
  console.log('PHASE revoke confirmed')
  report = {
    status: 'passed',
    host: hostSha,
    chatroom: chatSha,
    protocol: protocolSha,
    simulated: [
      'fixture Agent driver execution',
      'fixture permission approval click',
      'fixture HTTP delivery of unchanged production bundle',
    ],
    real: [
      'production installer',
      'Host Session ownership and capability authorization',
      'CLI subprocess',
      'private socket authentication',
      'CDP target/context dispatch',
      'Chatroom handler',
      'Host documents Room CAS',
      'Chatroom direct page projection',
      'cold page projection from Host documents',
    ],
    first,
    replay,
    roomMessages: room.cliMessages.length,
    notProven: [
      'native Codex',
      'production loopback graph admission',
      'real Agent execution',
      'human permission approval',
      'user acceptance',
    ],
  }
} catch (error) {
  primaryError = error
} finally {
  console.log('PHASE cleanup')
  let chromeExited = false
  const cleanupStep = async (label, operation) => {
    try {
      await operation()
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${String(error?.message ?? error)}`, { cause: error }))
    }
  }
  await cleanupStep('CDP close', async () => cdp?.close?.())
  await cleanupStep('plugin uninstall', async () => {
    if (installed) await uninstall(installed)
  })
  await cleanupStep('Agent tools socket close', async () => authority.agentTools?.close())
  await cleanupStep('fixture Chrome exit', async () => {
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM')
    let browserResult = await Promise.race([
      browserExit,
      pause(5_000).then(() => ({ timeout: true })),
    ])
    if (browserResult.timeout === true) {
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL')
      browserResult = await Promise.race([
        browserExit,
        pause(5_000).then(() => ({ timeout: true })),
      ])
    }
    assert.equal(browserResult.timeout, undefined, 'fixture Chrome did not exit after SIGKILL')
    assert.equal(browserResult.error, undefined, 'fixture Chrome process failed')
    chromeExited = true
  })
  await cleanupStep('fixture HTTP close', async () => new Promise(resolve => http.close(resolve)))
  await cleanupStep('CDP closed assertion', async () => assert.equal(cdp?.isClosed() ?? true, true))
  await cleanupStep('debug port closed assertion', async () => {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) }))
  })
  await cleanupStep('temporary root removal', async () => {
    assert.equal(chromeExited, true, 'refusing to remove the temporary root while fixture Chrome is running')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await assert.rejects(access(root), error => error?.code === 'ENOENT')
  })
  if (cleanupErrors.length === 0) {
    cleanup = {
      installationRemoved: true,
      cdpClosed: true,
      chromeExited: true,
      debugPortClosed: true,
      temporaryRootRemoved: true,
    }
    console.log('PHASE cleanup complete')
  }
}
const failures = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors]
if (failures.length > 0) throw new AggregateError(failures, 'smoke execution or cleanup failed')
if (report === undefined || cleanup === undefined) throw new Error('smoke result was not completed')
const completedReport = { ...report, cleanup }
await writeFile(reportPath, JSON.stringify(completedReport, null, 2) + '\n')
console.log('RESULT', JSON.stringify(completedReport))
