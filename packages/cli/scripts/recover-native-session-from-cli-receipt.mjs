// Explicit local recovery of one verified mapping. Never recreates old SessionEvents or submits a task.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { OwnerDocumentStore } from '../dist/src/launcher/owner-document-store.js'
import { nativeSessionStoreScope } from '../dist/src/launcher/native-agent-session-rpc.js'
import { EntityDirectoryAuthority } from '../dist/src/launcher/entity-directory.js'
import { entityInstallationId } from '../dist/src/launcher/owner-document-rpc.js'
import { nativeAgentInstructions } from '../dist/src/renderer/codex-desktop-agent-setup.js'
const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i]
  if (name === '--apply') args.set(name, true)
  else args.set(name, process.argv[++i])
}
const required = name => {
  const value = args.get(name)
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`)
  return value
}
const home = path.resolve(required('--home'))
const sessionId = required('--session-id')
const roomId = required('--room-id')
const accountHome = await realpath(required('--codex-home'))
const rolloutPath = await realpath(required('--rollout'))
assert.ok(
  rolloutPath.startsWith(accountHome + '/sessions/'),
  'Native transcript must belong to the current local account home',
)
const account = JSON.parse(await readFile(required('--account-proof'), 'utf8'))
const idle = JSON.parse(await readFile(required('--idle-proof'), 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
async function files(root) {
  const out = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...await files(file))
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(file)
  }
  return out
}
const owners = []
for (const file of await files(path.join(home, 'state/owner-documents/v1'))) {
  const raw = await readFile(file)
  const value = JSON.parse(raw)
  const doc = value.documents?.['room-registry']
  const room = doc?.value?.rooms?.find(room =>
    room.id === roomId && room.runs?.some(run => run.sessionId === sessionId)
  )
  if (room) owners.push({ file, raw, value, doc, room })
}
assert.equal(owners.length, 1, 'Room/Session must resolve to one exact stored owner')
const { file, raw, value: stored, doc, room } = owners[0]
assert.equal(hash(raw), required('--expected-owner-sha'), 'Original owner snapshot changed before recovery')
assert.equal(stored.profileId, required('--profile-id'))
assert.equal(stored.identity.source, required('--source'))
assert.equal(stored.identity.pluginId, 'chatroom')
const runs = room.runs.filter(run => run.sessionId === sessionId)
assert.equal(runs.length, 1)
const run = runs[0]
const member = room.memberships.find(member => member.memberId === run.memberId)
assert.ok(member && run.collaborationMode === 'cli', 'Only an existing authenticated CLI run may use this importer')
const receipts = room.cliMessages.filter(item =>
  item.sessionId === sessionId && item.runId === run.runId
  && item.memberId === member.memberId && item.participantId === member.participantId && item.roomId === roomId
)
assert.ok(receipts.length > 0)
const rolloutBytes = await readFile(rolloutPath)
const rows = rolloutBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
const metas = rows.filter(row => row.type === 'session_meta')
assert.equal(metas.length, 1)
const threadId = metas[0].payload.id
assert.equal(account.threadId, threadId)
assert.equal(account.hostId, 'local')
assert.equal(idle.threadId, threadId)
assert.equal(idle.latestTurnStatus, 'completed')
assert.equal(idle.wake?.reason, 'inactiveStatus')
const started = rows.filter(row => row.type === 'event_msg' && row.payload.type === 'task_started')
const completed = rows.filter(row => row.type === 'event_msg' && row.payload.type === 'task_complete')
assert.equal(started.length, completed.length, 'An unfinished native task prevents recovery')
assert.equal(completed.at(-1)?.payload.turn_id, idle.latestTurnId)
function objects(value) {
  if (typeof value === 'string') {
    try {
      return objects(JSON.parse(value))
    } catch {
      return value.split('\n').flatMap(line => {
        try {
          return objects(JSON.parse(line))
        } catch {
          return []
        }
      })
    }
  }
  if (Array.isArray(value)) return value.flatMap(objects)
  if (value && typeof value === 'object') return [value, ...Object.values(value).flatMap(objects)]
  return []
}
const matches = []
for (const row of rows) {
  if (row.type !== 'response_item' || row.payload.type !== 'custom_tool_call_output') continue
  for (const output of objects(row.payload.output)) {
    const receipt = receipts.find(receipt => receipt.messageId === output.messageId)
    if (!receipt) continue
    assert.equal(output.status, 'accepted')
    for (const key of ['roomId', 'memberId', 'operationId', 'messageId']) assert.equal(output[key], receipt[key])
    const call = rows.find(candidate =>
      candidate.type === 'response_item' && candidate.payload.type === 'custom_tool_call'
      && candidate.payload.call_id === row.payload.call_id
    )
    assert.ok(call && call.payload.name === 'exec' && typeof call.payload.input === 'string')
    assert.equal((call.payload.input.match(/tools\.exec_command\(/g) ?? []).length, 1)
    assert.ok(
      call.payload.input.includes('command.mjs') && call.payload.input.includes('--binding')
        && call.payload.input.includes(receipt.operationId),
    )
    matches.push({ receipt, callId: row.payload.call_id })
  }
}
assert.equal(matches.length, 1, 'Only one real native tool receipt may establish the restored mapping')
const authority = new EntityDirectoryAuthority(home, stored.profileId)
const binding = {
  profileId: stored.profileId,
  pluginId: stored.identity.pluginId,
  installationId: entityInstallationId(stored.profileId, stored.identity.pluginId),
  pluginGeneration: 1,
}
const entities = await authority.snapshot(binding)
const catalog = new Map()
const visiting = new Set()
function resolve(identity) {
  const key = JSON.stringify(identity)
  if (visiting.has(key)) throw new Error('Entity inheritance cycle')
  if (catalog.has(key)) return
  visiting.add(key)
  const entity = entities.entities.find(entity =>
    entity.identity.agentId === identity.agentId && entity.identity.revision === identity.revision
  )
  assert.ok(entity && entity.access === 'owned' && entity.digest === identity.revision)
  assert.equal(entity.owner.pluginId, stored.identity.pluginId)
  assert.equal(entity.owner.profileId, stored.profileId)
  assert.equal(entity.owner.installationId, binding.installationId)
  catalog.set(key, entity.definition)
  for (const parent of entity.definition.extends ?? []) resolve(parent)
  visiting.delete(key)
}
resolve(member.definition)
const setup = { definition: member.definition, definitions: [...catalog.values()] }
const instructions = nativeAgentInstructions(setup)
const developer = rows.filter(row =>
  row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'developer'
)
  .flatMap(row => row.payload.content.map(block => block.text ?? ''))
assert.equal(
  developer.filter(text => text === instructions).length,
  1,
  'Exact compiled setup must equal the original native developer instructions',
)
const setupDigest = hash(instructions)
const evidence = {
  kind: 'verified-cli-receipt-mapping',
  importedAt: new Date().toISOString(),
  roomId,
  runId: run.runId,
  sessionId,
  memberId: member.memberId,
  participantId: member.participantId,
  messageId: matches[0].receipt.messageId,
  operationId: matches[0].receipt.operationId,
  callId: matches[0].callId,
  nativeHostId: 'local',
  threadId,
  rolloutSha256: hash(rolloutBytes),
  definitionDigest: member.definition.revision,
  setupDigest,
  completedTurns: completed.length,
}
const mapping = {
  contract: 'cordisx.native-agent-session/v1',
  sessionId,
  threadId,
  setup,
  setupDigest,
  completedTurns: completed.length,
  recoveryEvidence: evidence,
}
const store = new OwnerDocumentStore(home)
const scope = nativeSessionStoreScope(stored.profileId, stored.identity)
const documentId = `native-session.${hash(sessionId).slice(0, 40)}`
const roomDigest = hash(JSON.stringify(doc))
const unchangedRoom = () =>
  hash(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).documents['room-registry'])) === roomDigest
if (args.get('--apply')) {
  const old = await store.load(scope, documentId)
  assert.equal(old.status, 'missing', 'An existing native binding must not be overwritten by a one-time import')
  const result = await store.replace({
    scope,
    documentId,
    expectedRevision: 0,
    schemaVersion: 1,
    value: mapping,
    commitAllowed: unchangedRoom,
  })
  assert.equal(result.status, 'accepted')
  const loaded = await store.load(scope, 'native-session-index')
  assert.ok(loaded.status === 'missing' || loaded.status === 'loaded')
  const ids = loaded.status === 'loaded' ? loaded.snapshot.value.sessionIds : []
  assert.ok(Array.isArray(ids) && !ids.includes(sessionId))
  const indexed = await store.replace({
    scope,
    documentId: 'native-session-index',
    expectedRevision: loaded.status === 'loaded' ? loaded.snapshot.revision : 0,
    schemaVersion: 1,
    value: { sessionIds: [...ids, sessionId] },
    commitAllowed: unchangedRoom,
  })
  assert.equal(indexed.status, 'accepted')
  assert.ok(unchangedRoom())
}
const report = {
  status: args.get('--apply') ? 'imported-mapping-only' : 'validated',
  ...evidence,
  owner: { profileId: stored.profileId, identity: stored.identity },
  nativeStoreScope: scope,
  roomRevision: doc.revision,
  roomDigest,
  oldEventsImported: 0,
  taskMessagesSubmitted: 0,
}
await writeFile(required('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(report))
