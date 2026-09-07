import { afterEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { PluginAgentToolAuthority } from '../packages/cli/src/launcher/plugin-agent-tools.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import {
  deployAgentToolResources,
  readAgentToolResources,
} from '../packages/cli/src/launcher/plugin-agent-tool-resources.js'
import {
  dispatchAgentTool,
  getAgentToolSetup,
  installAgentTools,
} from '../packages/cli/src/renderer/plugin-agent-tools.js'
import type { BrowserOwnerDocumentBridge } from '../packages/cli/src/renderer/owner-documents.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cx-agent-tools-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'skills/room'), { recursive: true })
  await mkdir(path.join(root, 'cli'))
  await writeFile(path.join(root, 'index.js'), 'export function apply() {}')
  await writeFile(path.join(root, 'skills/room/SKILL.md'), '# Room Skill\nUse the real CLI to report.')
  await writeFile(
    path.join(root, 'cli/send.mjs'),
    `import { invokeAgentTool } from 'cordisx/agent-tools';
const result = await invokeAgentTool({bindingPath: process.argv[3], input: JSON.parse(process.argv[4])});
process.stdout.write(JSON.stringify(result));`,
  )
  await writeFile(
    path.join(root, 'cordisx-agent-tools.json'),
    JSON.stringify({
      contract: 'cordisx.agent-tools/v1',
      skills: [{ id: 'room', path: './skills/room' }],
      commands: [{ id: 'send', entry: './cli/send.mjs', skillId: 'room' }],
    }),
  )
  return root
}

test('real subprocess CLI reaches live renderer handler through restricted local Host authority; revocation fails closed', async () => {
  const root = await fixture()
  const entry = path.join(root, 'index.js')
  const principal = {
    profileId: 'test',
    generation: 'launch',
    moduleGeneration: 'module',
    identity: { source: pathToFileURL(entry).href, pluginId: 'room' },
  }
  let active = true
  const authority = new PluginAgentToolAuthority({
    ...principal,
    secret: 'test-secret',
    principalAllowed: () => active,
    plugins: [{ id: 'room', entry, enabled: true }],
  })
  cleanup.push(() => authority.close())
  const token = issueOwnerDocumentPrincipalToken('test-secret', principal)
  const ctx = new Context()
  // Only the CDP transport is substituted in this scoped test. The authority,
  // renderer service, resource deployment and subprocess socket call are real.
  const bridge = {
    request: (token: string, value: Record<string, unknown>) =>
      authority.handle({ version: 1, token, ...value }, dispatchAgentTool),
  } as BrowserOwnerDocumentBridge
  const service = installAgentTools(ctx, {
    bridge,
    principal: { ...principal.identity, moduleGeneration: 'module', token },
    active: () => active,
    ownsSession: sessionId => sessionId === 'session-owned',
  })
  cleanup.push(async () => service.dispose())
  service.register({ id: 'send' }, async ({ input, binding }) => {
    const record = { input, binding }
    await writeFile(path.join(root, 'received.json'), JSON.stringify(record))
    return { status: 'accepted', roomId: (binding.scope as { roomId: string }).roomId }
  })
  await expect(service.bind({ commandId: 'send', sessionId: 'foreign', scope: {} })).rejects.toThrow('owner')
  const handle = await service.bind({
    commandId: 'send',
    sessionId: 'session-owned',
    scope: { roomId: 'room-owned', memberId: 'member-owned' },
  })
  const setup = await getAgentToolSetup('session-owned')
  expect(setup.skills[0]?.content).toContain('real CLI')
  const command = setup.commands[0]!
  const result = await promisify(execFile)(command.argv[0]!, [
    ...command.argv.slice(1),
    JSON.stringify({ text: 'hello', roomId: 'spoofed' }),
  ])
  expect(JSON.parse(result.stdout)).toEqual({ status: 'accepted', roomId: 'room-owned' })
  expect(JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8')).binding).toEqual({
    sessionId: 'session-owned',
    scope: { roomId: 'room-owned', memberId: 'member-owned' },
  })
  expect(JSON.stringify(setup)).not.toContain('test-secret')
  await handle.revoke()
  await expect(getAgentToolSetup('session-owned')).rejects.toThrow('rebind')
  await expect(promisify(execFile)(command.argv[0]!, [...command.argv.slice(1), '{}'])).rejects.toThrow()
  active = false
  await expect(
    authority.handle(
      { token, operation: 'agent-tools-register', commandId: 'send', registrationId: 'forged' },
      dispatchAgentTool,
    ),
  ).rejects.toThrow('stale')
})

test('package descriptor is outside browser graph and its entry must match; traversal is rejected', async () => {
  const root = await fixture()
  await mkdir(path.join(root, 'dist/runtime'), { recursive: true })
  const entry = path.join(root, 'dist/runtime/index.js')
  await writeFile(entry, 'export {}')
  await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({ entry: './dist/runtime/index.js' }))
  expect((await readAgentToolResources(entry))?.root).toBe(root)
  await writeFile(
    path.join(root, 'cordisx-agent-tools.json'),
    JSON.stringify({
      contract: 'cordisx.agent-tools/v1',
      skills: [{ id: 'room', path: './../outside' }],
      commands: [{ id: 'send', entry: './cli/send.mjs', skillId: 'room' }],
    }),
  )
  await expect(deployAgentToolResources(entry, 'send', path.join(root, 'deployed'))).rejects.toThrow('path segment')
})
