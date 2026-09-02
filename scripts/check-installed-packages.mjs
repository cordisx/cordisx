import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { npmPackItem } from './npm-pack-report.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const protocolTarball = process.env.CORDISX_PROTOCOL_TARBALL === undefined ? undefined : path.resolve(process.env.CORDISX_PROTOCOL_TARBALL)

async function run(file, args, options = {}) {
  try {
    return await execute(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(`${file} ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error })
  }
}

function parsePackReport(stdout, packageName) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`npm pack did not return JSON:\n${stdout}`, { cause: error })
  }
  const filename = npmPackItem(report, packageName).filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('npm pack did not report a tarball filename')
  }
  return filename
}

async function packWorkspace(workspace, packDirectory) {
  const packed = await run('npm', [
    'pack',
    `--workspace=${workspace}`,
    '--pack-destination',
    packDirectory,
    '--json',
  ], { cwd: repositoryRoot, env: process.env })
  return path.join(packDirectory, parsePackReport(packed.stdout, workspace))
}

async function expectMissing(target, label) {
  try {
    await access(target)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} must not be created by --dry-run: ${target}`)
}

async function verifyGeneratedProject(project, cordisxTarball, expectedVersion) {
  const packagePath = path.join(project, 'package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  if (manifest.license !== 'UNLICENSED') {
    throw new Error('generated plugin must leave its author an explicit license choice')
  }
  if (manifest.devDependencies?.cordisx !== expectedVersion) {
    throw new Error(`generated CordisX dependency must be ${expectedVersion}`)
  }
  manifest.devDependencies.cordisx = `file:${cordisxTarball}`
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: project,
    env: process.env,
  })
  await run('npm', ['run', 'check'], { cwd: project, env: process.env })
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: project, env: process.env })
  if (!dryRun.stdout.includes('[cordisx] bundle ready:') || !dryRun.stdout.includes('"status": "ready"')) {
    throw new Error('generated plugin was not accepted by cordisx dev --dry-run')
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-installed-check-'))
try {
  const packDirectory = path.join(temporaryRoot, 'pack')
  const runnerDirectory = path.join(temporaryRoot, 'runner')
  const cordisxHome = path.join(temporaryRoot, 'cordisx-home')
  await mkdir(packDirectory, { recursive: true })
  await mkdir(runnerDirectory, { recursive: true })
  await writeFile(
    path.join(runnerDirectory, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
    'utf8',
  )

  const [cordisxTarball, creatorTarball] = await Promise.all([
    packWorkspace('cordisx', packDirectory),
    packWorkspace('create-cordisx-plugin', packDirectory),
  ])
  if (protocolTarball !== undefined) await access(protocolTarball)
  await run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    cordisxTarball,
    creatorTarball,
    ...(protocolTarball === undefined ? [] : [protocolTarball]),
  ], { cwd: runnerDirectory, env: process.env })

  const installedCordisXRoot = path.join(runnerDirectory, 'node_modules', 'cordisx')
  const installedCordisXManifest = JSON.parse(await readFile(path.join(installedCordisXRoot, 'package.json'), 'utf8'))
  const avatarVersion = '1.0.0-rc.8'
  if (installedCordisXManifest.dependencies?.['@oneworks/avatar'] !== avatarVersion
    || installedCordisXManifest.dependencies?.['@oneworks/avatar-react'] !== avatarVersion) {
    throw new Error('installed cordisx must pin both OneWorks Avatar packages to exact RC.8 versions')
  }
  const installedLock = JSON.parse(await readFile(path.join(runnerDirectory, 'package-lock.json'), 'utf8'))
  const avatarLock = installedLock.packages?.['node_modules/@oneworks/avatar']
  const avatarReactLock = installedLock.packages?.['node_modules/@oneworks/avatar-react']
  if (avatarLock?.version !== avatarVersion
    || avatarLock?.integrity !== 'sha512-9vKWfiPUlEfVzcO+6Q2QsCmqlINZb2CpXjN4M/JO2+v0IwqsGIcWGaxW44lf3moSQj70lEmnF6F7bZofw7mcXQ==') {
    throw new Error('installed OneWorks Avatar package version or integrity drifted')
  }
  if (avatarReactLock?.version !== avatarVersion
    || avatarReactLock?.integrity !== 'sha512-fJ+p2LLG5tb3YV5QAAm/3gnkEFuCfMSR/WttpvMv8xNp64Ou6TB4Tz5QE6LqOwgT7q67qrBluZMwDfQUjX++aw=='
    || avatarReactLock?.dependencies?.['@oneworks/avatar'] !== avatarVersion) {
    throw new Error('installed OneWorks Avatar React package version, integrity, or singleton pin drifted')
  }
  const runnerRequire = createRequire(path.join(runnerDirectory, 'package.json'))
  const avatarReactManifestPath = path.join(runnerDirectory, 'node_modules', '@oneworks', 'avatar-react', 'package.json')
  const avatarReactRequire = createRequire(avatarReactManifestPath)
  const [directAvatarEntry, avatarReactAvatarEntry] = await Promise.all([
    realpath(runnerRequire.resolve('@oneworks/avatar')),
    realpath(avatarReactRequire.resolve('@oneworks/avatar')),
  ])
  if (directAvatarEntry !== avatarReactAvatarEntry) throw new Error('installed OneWorks Avatar runtime is not a singleton')
  await access(runnerRequire.resolve('@oneworks/avatar-react/style.css'))

  for (const packageName of ['cordisx', 'create-cordisx-plugin']) {
    const packageRoot = path.join(runnerDirectory, 'node_modules', packageName)
    const installedManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (installedManifest.license !== 'AGPL-3.0-or-later') {
      throw new Error(`${packageName} installed license metadata is invalid`)
    }
    await access(path.join(packageRoot, 'LICENSE'))
    await access(path.join(packageRoot, 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'))
  }

  await writeFile(path.join(runnerDirectory, 'conversation-consumer.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type { AgentConversationShellSource } from '@cordisx/protocol/agent-conversation-shell/v3'
import type { CordisXAgentConversationShellSourceFactoryV3 } from 'cordisx/contracts'

declare const ctx: Context
const factory: CordisXAgentConversationShellSourceFactoryV3 = (binding): AgentConversationShellSource => ({
  snapshot: async () => ({
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration }, generation: 'snapshot-1', snapshotSequence: 0, selection: { kind: 'no-room' }, items: [],
    composer: { availability: 'available', placeholder: { key: 'placeholder', fallback: 'Message' }, disabled: { value: false }, submit: { id: 'create-with-message' } },
    headerActions: [],
  }),
  subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
  updateRoomSettings: async request => ({
    type: 'update-room-settings', requestId: request.requestId, binding: request.binding,
    generation: request.generation, roomId: request.roomId,
    expectedSnapshotSequence: request.expectedSnapshotSequence,
    status: 'unavailable', code: 'settings-unavailable',
  }),
  dispose() {},
})
const registration = ctx.agentConversationShell.registerSource(factory)
registration.mount satisfies Function
ctx.commands.register({ id: 'create', title: { key: 'create', fallback: 'Create' } }, command => {
  if (command.hostContext !== undefined && 'scope' in command.hostContext) command.hostContext.scope satisfies 'header' | 'message' | 'approval' | 'composer-submit'
})
`, 'utf8')
  await writeFile(path.join(runnerDirectory, 'connector-consumer.ts'), `
import type {
  ConnectorEventSubscription,
  ConnectorSubscribeRuntimeResult,
} from '@cordisx/protocol/connector-service/v1'
import type {
  CordisXConnectorEventSubscription,
  CordisXConnectorSubscribeRuntimeResult,
} from 'cordisx/contracts'

declare const protocolSubscription: ConnectorEventSubscription
declare const hostSubscription: CordisXConnectorEventSubscription
declare const protocolResult: ConnectorSubscribeRuntimeResult
declare const hostResult: CordisXConnectorSubscribeRuntimeResult

protocolSubscription satisfies CordisXConnectorEventSubscription
hostSubscription satisfies ConnectorEventSubscription
if ('handle' in protocolResult) protocolResult.handle.unsubscribe()
if ('handle' in hostResult) hostResult.handle.unsubscribe()
`, 'utf8')
  await writeFile(path.join(runnerDirectory, 'agent-loop-collection-consumer.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentDefinition as ProtocolAgentDefinition,
  AgentLoopCommand as ProtocolAgentLoopCommand,
  AgentLoopTaskBinding as ProtocolAgentLoopTaskBinding,
  BoundAgentLoopClient as ProtocolBoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v1'
import type {
  AgentLoopCommand as ProtocolAgentLoopCommandV2,
  AgentLoopTaskBinding as ProtocolAgentLoopTaskBindingV2,
  BoundAgentLoopClient as ProtocolBoundAgentLoopClientV2,
} from '@cordisx/protocol/agent-loop/v2'
import type {
  AgentLoopCommand as ProtocolAgentLoopCommandV3,
  AgentLoopTaskBinding as ProtocolAgentLoopTaskBindingV3,
  BoundAgentLoopClient as ProtocolBoundAgentLoopClientV3,
} from '@cordisx/protocol/agent-loop/v3'
import type {
  AgentLoopCommand as ProtocolAgentLoopCommandV4,
  AgentLoopTaskBinding as ProtocolAgentLoopTaskBindingV4,
  BoundAgentLoopClient as ProtocolBoundAgentLoopClientV4,
} from '@cordisx/protocol/agent-loop/v4'
import type { AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { CORDISX_OWNER_DOCUMENT_SERVICE_V1 } from 'cordisx/contracts'
import type {
  CordisXNavigationCollectionLeadingVisual,
  AgentDefinition,
  AgentLoopCommand,
  AgentLoopCreateOrBindResult,
  AgentLoopSendResult,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
  CordisXOwnerDocumentLoadResultV1,
  CordisXOwnerDocumentReplaceResultV1,
  CordisXOwnerDocumentsV1,
  CordisXNavigationCollectionSnapshot,
  CordisXNavigationCollectionSource,
} from 'cordisx/contracts'
import { CORDISX_ROOM_COMPOSITE_AVATAR_MAX_PARTICIPANTS } from 'cordisx/contracts'

declare const ctx: Context
declare const definition: AgentDefinition
declare const protocolDefinition: ProtocolAgentDefinition
declare const protocolCommand: ProtocolAgentLoopCommand
declare const protocolBinding: ProtocolAgentLoopTaskBinding
declare const created: AgentLoopCreateOrBindResult
declare const sent: AgentLoopSendResult
declare const createCommands: readonly [
  Extract<AgentLoopCommand, { type: 'create-or-bind' }>,
  Extract<AgentLoopCommand, { type: 'create-or-bind' }>,
]
declare const snapshot: CordisXNavigationCollectionSnapshot
declare const source: CordisXNavigationCollectionSource
declare const avatar: AgentAvatarRef

const roomLeadingVisual = {
  kind: 'room-composite-avatar',
  participants: [{ participantId: 'lead', avatar }],
} satisfies CordisXNavigationCollectionLeadingVisual
const projectedRooms = {
  revision: 1,
  items: [{
    id: 'room-one',
    label: { key: 'room.one', fallback: 'Room one' },
    leadingVisual: roomLeadingVisual,
    route: { id: 'room', params: { roomId: 'room-one' } },
    order: 0,
  }],
} satisfies CordisXNavigationCollectionSnapshot
CORDISX_ROOM_COMPOSITE_AVATAR_MAX_PARTICIPANTS satisfies 16

ctx.agentLoop satisfies BoundAgentLoopClient
ctx.documents satisfies CordisXOwnerDocumentsV1
ctx.agentLoop satisfies ProtocolBoundAgentLoopClient
ctx.agentLoop satisfies ProtocolBoundAgentLoopClientV2
ctx.agentLoop satisfies ProtocolBoundAgentLoopClientV3
ctx.agentLoop satisfies ProtocolBoundAgentLoopClientV4
definition satisfies ProtocolAgentDefinition
protocolDefinition satisfies AgentDefinition
definition.avatar satisfies AgentAvatarRef | undefined
protocolCommand satisfies AgentLoopCommand
protocolBinding satisfies AgentLoopTaskBinding
declare const protocolCommandV2: ProtocolAgentLoopCommandV2
declare const protocolBindingV2: ProtocolAgentLoopTaskBindingV2
declare const protocolCommandV3: ProtocolAgentLoopCommandV3
declare const protocolBindingV3: ProtocolAgentLoopTaskBindingV3
declare const protocolCommandV4: ProtocolAgentLoopCommandV4
declare const protocolBindingV4: ProtocolAgentLoopTaskBindingV4
if (protocolCommandV2.type === 'create-or-bind') {
  ctx.agentLoop.createOrBind(protocolCommandV2).then(result => {
    if (result.status === 'accepted') {
      result.detailsUrl.target satisfies 'host' | 'external'
      result.delivery.disposition satisfies 'executed' | 'replayed' | 'reconciled'
    }
  })
}
ctx.agentLoop.subscribe(protocolBindingV2, -1)
if (protocolCommandV3.type === 'approval-decision') {
  ctx.agentLoop.decideApproval(protocolCommandV3).then(result => {
    if (result.status === 'accepted') result.decision satisfies 'approve' | 'deny' | 'cancel'
  })
}
if (protocolCommandV3.type === 'request-member-self-introduction') {
  ctx.agentLoop.requestMemberSelfIntroduction(protocolCommandV3).then(result => {
    if (result.status === 'accepted') result.messageId satisfies string
  })
}
if (protocolCommandV3.type === 'cancel-member-self-introduction') {
  ctx.agentLoop.cancelMemberSelfIntroduction(protocolCommandV3).then(result => {
    if (result.status === 'accepted') result.requestOperationId satisfies string
  })
}
ctx.agentLoop.subscribe(protocolBindingV3, -1)
if (protocolCommandV4.type === 'approval-decision') {
  ctx.agentLoop.decideApproval(protocolCommandV4).then(result => {
    if (result.status === 'accepted') result.causation.operationId satisfies string
  })
}
if (protocolCommandV4.type === 'request-member-self-introduction') {
  ctx.agentLoop.requestMemberSelfIntroduction(protocolCommandV4).then(result => {
    if (result.status === 'accepted') {
      result.causation.operationId satisfies string
      result.messageId satisfies string
    }
  })
}
if (protocolCommandV4.type === 'cancel-member-self-introduction') {
  ctx.agentLoop.cancelMemberSelfIntroduction(protocolCommandV4).then(result => {
    if (result.status === 'accepted') result.requestOperationId satisfies string
  })
}
ctx.agentLoop.subscribe(protocolBindingV4, -1)
ctx.agentLoop.durableLedger.providerAffinity satisfies 'generation-fenced'
definition.promptSections?.map(section => section.kind satisfies 'introduction' | 'personality' | 'role' | 'operations' | 'tools' | 'knowledge' | 'memory-policy' | 'memory' | 'other')
if (created.status === 'accepted') created.binding.task satisfies string
else created.authorization.state satisfies 'denied' | 'unavailable'
if (sent.status === 'accepted') sent.messageId satisfies string
else sent.authorization.state satisfies 'denied' | 'unavailable'
async function manageMultipleBindings(): Promise<Map<string, { binding: AgentLoopTaskBinding; cursor: number }>> {
  const results = await Promise.all(createCommands.map(command => ctx.agentLoop.createOrBind(command)))
  const bindings = results.flatMap(result => result.status === 'accepted' ? [result.binding] : [])
  const subscriptions = await Promise.all(bindings.map(binding => ctx.agentLoop.subscribe(binding, -1)))
  const byBinding = new Map<string, { binding: AgentLoopTaskBinding; cursor: number }>()
  for (const result of subscriptions) {
    if (result.status !== 'accepted') continue
    byBinding.set(result.handle.subscription.binding.bindingId, {
      binding: bindings.find(binding => binding.binding.bindingId === result.handle.subscription.binding.bindingId)!,
      cursor: result.handle.subscription.afterSequence,
    })
  }
  if (bindings[0] !== undefined) {
    await ctx.agentLoop.createOrBind({
      ...createCommands[0], commandId: 'bind-existing-task', target: { mode: 'bind', task: bindings[0].task },
    })
  }
  return byBinding
}
manageMultipleBindings satisfies () => Promise<Map<string, { binding: AgentLoopTaskBinding; cursor: number }>>
async function persistRoomDelivery(): Promise<CordisXOwnerDocumentLoadResultV1 | CordisXOwnerDocumentReplaceResultV1> {
  const current = await ctx.documents.load('room-registry')
  if (current.status === 'unavailable') return current
  return await ctx.documents.transaction({
    contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
    documentId: 'room-registry',
    expectedRevision: current.status === 'loaded' ? current.snapshot.revision : 0,
    schemaVersion: 1,
    value: { deliveryId: 'delivery-1', operationId: 'stable-operation-1', state: 'planned' },
  })
}
persistRoomDelivery satisfies () => Promise<CordisXOwnerDocumentLoadResultV1 | CordisXOwnerDocumentReplaceResultV1>
snapshot.items.map(item => item.route.params?.roomId)
roomLeadingVisual.participants.map(participant => participant.participantId)
projectedRooms.items.map(item => item.leadingVisual.participants.length)
ctx.slots.registerCollection({
  name: 'sidebar.navigation.items',
  id: 'chatroom.rooms',
  group: { id: 'chatroom', label: { key: 'chatroom.rooms', fallback: 'Rooms' } },
}, source).dispose()
`, 'utf8')
  await writeFile(path.join(runnerDirectory, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false,
    },
    include: ['conversation-consumer.ts', 'connector-consumer.ts', 'agent-loop-collection-consumer.ts'],
  }, null, 2)}\n`, 'utf8')
  const rootBin = name => path.join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
  await run(rootBin('tsc'), ['-p', 'tsconfig.json'], { cwd: runnerDirectory, env: process.env })

  const binDirectory = path.join(runnerDirectory, 'node_modules', '.bin')
  const executable = name => path.join(
    binDirectory,
    process.platform === 'win32' ? `${name}.cmd` : name,
  )
  const cliEnvironment = { ...process.env, CORDISX_HOME: cordisxHome }
  const help = await run(executable('cordisx'), ['--help'], {
    cwd: runnerDirectory,
    env: cliEnvironment,
  })
  if (!help.stdout.includes('cordisx setup')) throw new Error('installed cordisx --help is incomplete')

  await run(executable('cordisx'), ['setup'], { cwd: runnerDirectory, env: cliEnvironment })
  const configPath = path.join(cordisxHome, 'config.json')
  const initialConfig = JSON.parse(await readFile(configPath, 'utf8'))
  if (!Array.isArray(initialConfig.plugins) || initialConfig.plugins.length !== 0) {
    throw new Error('installed cordisx setup must create plugins: []')
  }
  initialConfig.plugins.push({
    id: 'cli-proxy-api',
    entry: 'cordisx:cli-proxy-api',
    enabled: true,
    config: {},
  })
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8')
  const installedSchemasteryUiRoot = path.join(installedCordisXRoot, 'node_modules', '@cordisx', 'schemastery-ui')
  await access(path.join(installedSchemasteryUiRoot, 'dist', 'index.js'))
  const installedSchemasteryUiManifest = JSON.parse(await readFile(path.join(installedSchemasteryUiRoot, 'package.json'), 'utf8'))
  if (installedSchemasteryUiManifest.name !== '@cordisx/schemastery-ui' || installedSchemasteryUiManifest.version !== '0.1.0-beta.2') {
    throw new Error('installed cordisx tarball is missing the pinned @cordisx/schemastery-ui runtime')
  }
  const [
    { loadConfig }, { buildRendererBundle }, { OwnerDocumentStore },
    { createOwnerDocumentBridgeHandler, parseOwnerDocumentBindingRequest }, { JSDOM },
    { CordisXAgentLoopBrokerV4 }, { PlaygroundMockAgentLoopHost, PlaygroundMockAgentLoopV4Transport },
    agentLoopContracts,
  ] = await Promise.all([
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/launcher/config.js')).href),
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/launcher/bundle.js')).href),
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/launcher/owner-document-store.js')).href),
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/launcher/owner-document-rpc.js')).href),
    import('jsdom'),
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/renderer/agent-loop-v4.js')).href),
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/renderer/playground-mock-agent-loop.js')).href),
    import(pathToFileURL(path.join(installedCordisXRoot, 'dist/src/agent-loop-contracts.js')).href),
  ])
  const ownerDocumentScope = {
    profileId: 'installed',
    identity: { source: 'https://plugins.example/chatroom', pluginId: 'chatroom' },
  }
  const installedDocumentStore = new OwnerDocumentStore(cordisxHome)
  const durableOperation = {
    deliveryId: 'delivery-installed-1', operationId: 'stable-operation-installed-1',
    issuedAt: 1, exactPayload: { text: 'hello' }, state: 'planned',
  }
  const durableAccepted = await installedDocumentStore.replace({
    scope: ownerDocumentScope, documentId: 'room-registry', expectedRevision: 0, schemaVersion: 1,
    value: durableOperation,
  })
  if (durableAccepted.status !== 'accepted') throw new Error('installed owner document store did not accept an outbox operation')
  const durableReload = await new OwnerDocumentStore(cordisxHome).load(ownerDocumentScope, 'room-registry')
  if (durableReload.status !== 'loaded' || durableReload.snapshot.value.operationId !== durableOperation.operationId) {
    throw new Error('installed owner document store did not reload the exact outbox operation')
  }
  // Installed public consumer proof: plugin ctx.documents -> browser binding ->
  // launcher authority. The direct store reload above is intentionally not the
  // only durability evidence.
  const durablePluginEntry = path.join(runnerDirectory, 'durable-plugin.mjs')
  await writeFile(durablePluginEntry, `export const inject = ['documents']\nexport function apply(ctx) { globalThis.__installedDurableClient = ctx.documents }\n`, 'utf8')
  const durableSource = pathToFileURL(durablePluginEntry).href
  const durableGeneration = 'installed-owner-documents-generation'
  const durableHandler = createOwnerDocumentBridgeHandler({
    secret: 'installed-owner-documents-secret', profileId: 'installed', generation: durableGeneration,
    store: new OwnerDocumentStore(cordisxHome),
    principalAllowed: principal => principal.identity.source === durableSource && principal.identity.pluginId === 'durable-plugin',
  })
  const durableBundle = await buildRendererBundle({
    version: 1, rootDir: runnerDirectory, codex: { debugPort: 9229 }, providers: [],
    plugins: [{ id: 'durable-plugin', entry: durablePluginEntry, source: durableSource, enabled: true, config: {} }],
  }, {
    profileId: 'installed', generation: durableGeneration,
    ownerDocumentAuthority: { secret: 'installed-owner-documents-secret', profileId: 'installed', generation: durableGeneration },
  })
  const durableDom = new JSDOM('<html lang="en"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>', {
    runScripts: 'dangerously', url: 'https://codex.local/',
  })
  Object.defineProperty(durableDom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  Object.defineProperty(durableDom.window, 'structuredClone', { value: globalThis.structuredClone })
  Object.defineProperty(durableDom.window, 'TextEncoder', { value: globalThis.TextEncoder })
  Object.defineProperty(durableDom.window, 'TextDecoder', { value: globalThis.TextDecoder })
  Object.defineProperty(durableDom.window, '__cordisxOwnerDocumentRequestV1', {
    configurable: true,
    value: payload => { void (async () => {
      const request = parseOwnerDocumentBindingRequest(JSON.parse(payload))
      const value = request.operation === 'load' ? await durableHandler.load(request) : await durableHandler.replace(request)
      durableDom.window.__cordisxOwnerDocumentReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
    })() },
  })
  durableDom.window.eval(durableBundle)
  await durableDom.window.__cordisxBoot
  const durableClient = durableDom.window.__installedDurableClient
  if (durableClient === undefined || Object.keys(durableClient).length !== 0) throw new Error('installed public ctx.documents client is missing or leaks binding state')
  const bridgeAccepted = await durableClient.replace({
    contract: 'cordisx.owner-documents/v1', documentId: 'room-outbox', expectedRevision: 0, schemaVersion: 1,
    value: { operationId: 'installed-public-bridge-operation', state: 'planned' },
  })
  if (bridgeAccepted.status !== 'accepted') throw new Error('installed public ctx.documents bridge did not commit')
  await durableDom.window.__cordisxRuntime?.dispose()
  durableDom.window.close()
  const bridgeReload = await new OwnerDocumentStore(cordisxHome).load({
    profileId: 'installed', identity: { source: durableSource, pluginId: 'durable-plugin' },
  }, 'room-outbox')
  if (bridgeReload.status !== 'loaded' || bridgeReload.snapshot.value.operationId !== 'installed-public-bridge-operation') {
    throw new Error('installed public ctx.documents bridge did not survive launcher store reload')
  }
  const installedBundle = await buildRendererBundle(await loadConfig(configPath))
  if (!installedBundle.includes('# CLIProxy Providers') || !installedBundle.includes('External providers and the native connection')) {
    throw new Error('installed built-in CLIProxy plugin bundle is missing its product README')
  }
  const localAgentLoopConfigPath = path.join(runnerDirectory, 'local-agent-loop.config.json')
  await writeFile(localAgentLoopConfigPath, `${JSON.stringify({
    version: 1,
    codex: { debugPort: 9229, agentLoopBackend: 'local-cli' },
    providers: [],
    plugins: [],
  }, null, 2)}\n`, 'utf8')
  const localAgentLoopBundle = await buildRendererBundle(await loadConfig(localAgentLoopConfigPath), {
    playground: true,
    profileId: 'playground',
    providerBridgeToken: 'installed-local-agent-loop-token',
  })
  if (!localAgentLoopBundle.includes('codex-local') || !localAgentLoopBundle.includes('installed-local-agent-loop-token')) {
    throw new Error('installed cordisx tarball does not compose the explicit local AgentLoop provider bridge')
  }

  const installedMockHost = new PlaygroundMockAgentLoopHost()
  const installedMockTransport = new PlaygroundMockAgentLoopV4Transport(installedMockHost)
  const installedBroker = new CordisXAgentLoopBrokerV4(installedMockTransport, installedMockHost, 'installed', 'installed-composition')
  const installedClient = installedBroker.bind({
    ownerKey: 'installed-runtime-owner', active: () => true,
    authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
  })
  const commandBase = commandId => ({
    $schema: agentLoopContracts.CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
    contract: 'cordisx.agent-loop-command/v4', schemaVersion: 4, commandId,
  })
  const installedDefinition = {
    $schema: agentLoopContracts.CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
    identity: { agentId: 'installed-agent', revision: 'revision-1' },
    inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
  }
  const installedCreated = await installedClient.createOrBind({
    ...commandBase('installed-create'), type: 'create-or-bind', definition: installedDefinition.identity,
    definitions: [installedDefinition], target: { mode: 'create' },
  })
  if (installedCreated.status !== 'accepted') throw new Error('installed v4 runtime create was not accepted')
  const installedSendCommand = {
    ...commandBase('installed-send'), type: 'send', binding: installedCreated.binding,
    content: [{ kind: 'text', text: '[approval]' }],
  }
  const [installedSent, installedReplayed] = await Promise.all([
    installedClient.send(installedSendCommand), installedClient.send(installedSendCommand),
  ])
  if (installedSent.status !== 'accepted' || installedReplayed.status !== 'accepted'
    || [installedSent.delivery.disposition, installedReplayed.delivery.disposition].sort().join(',') !== 'executed,replayed') {
    throw new Error('installed v4 runtime did not execute and replay one concurrent send')
  }
  const installedApproval = await installedClient.decideApproval({
    ...commandBase('installed-approval'), type: 'approval-decision', binding: installedCreated.binding,
    turn: installedSent.turn, approvalId: `simulated-approval-${installedSent.turn}`, decision: 'approved',
  })
  if (installedApproval.status !== 'accepted' || installedApproval.causation.operationId !== 'installed-approval') {
    throw new Error('installed v4 runtime approval decision lost durable causation')
  }
  const installedIntroductionCommand = {
    ...commandBase('installed-introduction'), type: 'request-member-self-introduction', binding: installedCreated.binding,
    participantId: 'installed-participant', memberId: 'installed-member', runId: 'installed-run',
    intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
  }
  const installedIntroduction = await installedClient.requestMemberSelfIntroduction(installedIntroductionCommand)
  if (installedIntroduction.status !== 'accepted') throw new Error('installed v4 runtime introduction was not accepted')
  const installedCancelCommand = {
    ...commandBase('installed-cancel'), type: 'cancel-member-self-introduction', binding: installedCreated.binding,
    participantId: installedIntroductionCommand.participantId, memberId: installedIntroductionCommand.memberId,
    runId: installedIntroductionCommand.runId, requestOperationId: installedIntroductionCommand.commandId,
  }
  const installedCancelled = await installedClient.cancelMemberSelfIntroduction(installedCancelCommand)
  const installedCancelReplay = await installedClient.cancelMemberSelfIntroduction(installedCancelCommand)
  const installedCancelConflict = await installedClient.cancelMemberSelfIntroduction({ ...installedCancelCommand, commandId: 'installed-cancel-again' })
  if (installedCancelled.status !== 'accepted' || installedCancelReplay.status !== 'accepted'
    || installedCancelReplay.delivery.disposition !== 'replayed'
    || installedCancelConflict.status !== 'conflict' || installedCancelConflict.code !== 'introduction-cancelled') {
    throw new Error('installed v4 runtime cancellation state or replay drifted')
  }
  const installedSubscription = await installedClient.subscribe(installedCreated.binding, 0)
  if (installedSubscription.status !== 'accepted') throw new Error('installed v4 runtime subscription was unavailable')
  const installedPage = await installedSubscription.handle.pages[Symbol.asyncIterator]().next()
  if (!installedPage.value?.events.some(event => event.type === 'lifecycle'
      && event.lifecycle.phase === 'turn.cancelled' && event.causation?.operationId === 'installed-cancel')
    || installedPage.value.events.some(event => event.type === 'message' && event.turn === installedIntroduction.turn)) {
    throw new Error('installed v4 runtime emitted an invalid cancellation event sequence')
  }
  installedSubscription.handle.unsubscribe()
  installedClient.dispose()
  installedBroker.dispose()

  const config = await run(executable('cordisx'), ['config'], {
    cwd: runnerDirectory,
    env: cliEnvironment,
  })
  if (!config.stdout.includes(configPath)) {
    throw new Error('installed cordisx config did not report its home config')
  }
  const doctor = await run(executable('cordisx'), ['doctor'], {
    cwd: runnerDirectory,
    env: cliEnvironment,
  })
  if (!doctor.stdout.includes('"status"')) throw new Error('installed cordisx doctor did not report a status')

  const profileRoot = path.join(cordisxHome, 'apps', 'codex', 'profiles', 'work')
  await run(executable('cordisx'), [
    'codex',
    'work',
    '--dry-run',
    '--executable',
    process.execPath,
  ], { cwd: runnerDirectory, env: cliEnvironment })
  const persistedConfig = JSON.parse(await readFile(configPath, 'utf8'))
  if (persistedConfig.apps?.codex?.profiles?.work?.dataMode !== 'shared') {
    throw new Error('installed cordisx dry-run must persist a new work profile as shared')
  }
  await expectMissing(profileRoot, 'named profile data directory')

  const createTarget = path.join(temporaryRoot, 'from-npm-create')
  const npxTarget = path.join(temporaryRoot, 'from-npx')
  await run('npm', ['create', 'cordisx-plugin', createTarget], {
    cwd: runnerDirectory,
    env: process.env,
  })
  await run('npm', ['exec', '--', 'create-cordisx-plugin', npxTarget], {
    cwd: runnerDirectory,
    env: process.env,
  })
  const creatorManifest = JSON.parse(await readFile(
    path.join(runnerDirectory, 'node_modules/create-cordisx-plugin/package.json'),
    'utf8',
  ))
  await verifyGeneratedProject(createTarget, cordisxTarball, creatorManifest.version)
  await verifyGeneratedProject(npxTarget, cordisxTarball, creatorManifest.version)

  console.log(`[cordisx] installed tarballs verified: licenses, exact singleton OneWorks Avatar RC.8 packages/style export, combined multi-binding AgentLoop, executable v4 create/send concurrent replay/approval/introduction/cancel/subscription, owner documents, and navigation collection${protocolTarball === undefined ? '' : ', exact local Protocol'}, durable outbox reload, local AgentLoop provider composition, conversation-shell and Connector consumer types, CLI, built-in README, both creator forms, generated checks, dev dry-run`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
