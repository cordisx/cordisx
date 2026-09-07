// Separate real Chrome/CDP integration checkpoint. It never opens or inspects Codex.
// Build the selected exact Host checkout first; the script never builds watched dist.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { ChatroomAgentSessionConversationSourceV10 } from ${
  JSON.stringify(chat + '/src/agent-session-conversation-source-v10.ts')
};
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from ${JSON.stringify(chat + '/src/agent-definition.ts')};
import { projectAgentConversationShellSnapshotV7 } from ${
  JSON.stringify(host + '/packages/cli/dist/src/renderer/agent-conversation-shell-projection.js')
};
export const manifest=${JSON.stringify(manifest)};
export const inject=['agents','sessions','approvals','documents','agentTools','settings'];
export function apply(ctx) {
  globalThis.__smokeContextReady=true;
  globalThis.__smokeStart=async()=>{
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
      const binding={bindingId:'shell-real-cdp',shell:'agent-desktop',ownerGeneration:'shell-generation',routeSelection:{scope:'room-or-new',selectedRoomParam:room.id}};
      const shell=new ChatroomAgentSessionConversationSourceV10(binding,domain.createSource(binding),sessions,'enter');
      await shell.snapshot();
      globalThis.__smokeRead=async()=>{
        const stored=await ctx.documents.load('room-registry');
        const snapshot=await shell.snapshot();
        const model=projectAgentConversationShellSnapshotV7('chatroom',snapshot,{resolve: text=>text.fallback??text.key},true);
        return {stored,snapshot,model};
      };
      globalThis.__smokeRevoke=()=>collaboration.revoke(acquired.sessionId);
      globalThis.__smokeReady=true;
    }catch(error){globalThis.__smokeError=String(error?.stack??error)}
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
const http = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(
    '<!doctype html><html lang="en"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div><main data-cordisx-playground-seat="main"></main></body></html>',
  )
})
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${http.address().port}`
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
let stderr = ''
browser.stderr.on('data', value => {
  stderr = (stderr + value).slice(-2000)
})
let cdp, installed
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
  installed = await install(target, bundle, undefined, undefined, undefined, authority)
  cdp = await CdpSession.connect(target.webSocketDebuggerUrl)
  const evaluate = async expression => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 30000)
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
    return reply.result?.value
  }
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
  await evaluate('void globalThis.__smokeStart()')
  for (let i = 0; i < 160; i++) {
    const state = await evaluate(
      '({ready:globalThis.__smokeReady,error:globalThis.__smokeError,text:document.body.innerText.slice(-2500),buttons:[...document.querySelectorAll("button")].map(b=>({text:b.textContent,disabled:b.disabled}))})',
    )
    if (state.error) throw new Error(state.error)
    if (state.ready) break
    if (i === 10 || i === 40) console.log('PENDING', JSON.stringify(state))
    if (
      state.text.includes('chatroom 请求 ') && state.text.includes('one exact Agent Session')
      && state.buttons.some(button => button.text === '仅此次允许' && !button.disabled)
    ) {
      console.log('PERMISSION', state.text.match(/chatroom 请求 ([a-z.]+)/)?.[1])
      await evaluate(
        '(()=>{const button=[...document.querySelectorAll("button")].find(button=>button.textContent==="仅此次允许"&&!button.disabled);if(!button)throw new Error("observed permission button disappeared");button.click();return true})()',
      )
    }
    await pause(200)
  }
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
  const first = JSON.parse((await promisify(execFile)(command.argv[0], argv)).stdout)
  const replay = JSON.parse((await promisify(execFile)(command.argv[0], argv)).stdout)
  assert.equal(first.status, 'accepted')
  assert.equal(replay.disposition, 'replayed')
  assert.equal(first.messageId, replay.messageId)
  await pause(350)
  const result = await evaluate('globalThis.__smokeRead()')
  assert.equal(result.stored.status, 'loaded')
  const room = result.stored.snapshot.value.rooms.find(item => item.id === 'room-real-cdp')
  assert.equal(room.cliMessages.length, 1)
  assert.equal(
    result.model.entries.filter(item => item.kind === 'message' && item.messageId === first.messageId).length,
    1,
  )
  assert.equal(result.snapshot.items.find(item => item.messageId === first.messageId).source.kind, 'plugin-command')
  await evaluate('globalThis.__smokeRevoke()')
  await assert.rejects(promisify(execFile)(command.argv[0], argv))
  const report = {
    status: 'passed',
    host: hostSha,
    chatroom: chatSha,
    protocol: protocolSha,
    simulated: ['Agent driver execution'],
    real: [
      'production installer',
      'Host Agent runtime Session ownership',
      'CLI subprocess',
      'private socket authentication',
      'CDP target/context dispatch',
      'Chatroom handler',
      'Host documents Room CAS',
      'Chatroom source-v10',
      'Host Shell model',
    ],
    first,
    replay,
    roomMessages: room.cliMessages.length,
    notProven: ['native Codex', 'user acceptance'],
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log('RESULT', JSON.stringify(report))
} finally {
  await cdp?.close?.()
  if (installed) await uninstall(installed).catch(() => {})
  await authority.agentTools?.close()
  browser.kill('SIGTERM')
  await new Promise(resolve => http.close(resolve))
  await pause(300)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
