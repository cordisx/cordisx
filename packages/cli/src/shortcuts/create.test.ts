import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createShortcut } from './create.js'
import * as store from './store.js'
import { legacyShortcutKey, shortcutKey } from './model.js'
import { dockScope, prepareDockImage, prepareOptionalDockImage } from './dock.js'
import { inspectBundle, nativeOperation, shortcutHelper } from './native.js'
import { type CordisXManagedInvocation, parseCordisXCli } from '../cli/parse.js'
vi.mock(
  '../adapters/registry.js',
  () => ({
    resolveHostAdapter: () => ({
      resolveLaunchPlan: async () => ({ appName: 'Fixture', executable: '/usr/bin/true' }),
    }),
  }),
)
let roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-entry-test-'))
  roots.push(root)
  const home = path.join(root, 'home'), directory = path.join(root, 'entries'), registry = path.join(root, 'records')
  await mkdir(home)
  await mkdir(directory)
  const input = {
    invocation: parseCordisXCli(['codex', 'work', '--create-shortcut']) as CordisXManagedInvocation,
    appId: 'codex',
    profileId: 'work',
    dataMode: 'host-isolated' as const,
    home,
    cwd: root,
    env: {},
    output: { registry, directory },
  }
  return {
    root,
    input,
    record: path.join(registry, shortcutKey(await realpath(home), 'codex', 'work', 'host-isolated') + '.json'),
  }
}
async function makeLegacyEntry(f: Awaited<ReturnType<typeof fixture>>, custom = false) {
  const created = await createShortcut(f.input)
  const oldId = legacyShortcutKey(await realpath(f.input.home), 'codex', 'work')
  const oldRecord = path.join(f.input.output.registry, `${oldId}.json`)
  const oldBundle = path.join(f.input.output.directory, 'Fixture · work.app')
  const resources = path.join(created.path, 'Contents/Resources')
  await nativeOperation({
    operation: 'assemble',
    path: oldBundle,
    helper: shortcutHelper,
    icon: path.join(resources, 'base.icns'),
    lightIcon: path.join(resources, 'dock-light.icns'),
    defaultIcon: path.join(resources, 'dock-default.icns'),
    entryId: oldId,
    name: 'Fixture · work',
    recordPath: oldRecord,
  })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', oldBundle])
  if (custom) {
    const finderInfo = Buffer.alloc(32)
    finderInfo.writeUInt16BE(0x0400, 8)
    execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.FinderInfo', finderInfo.toString('hex'), oldBundle])
  }
  const current = JSON.parse(await readFile(f.record, 'utf8'))
  const inspected = await inspectBundle(oldBundle)
  await store.writePrivateJson(oldRecord, {
    ...current,
    entryId: oldId,
    bundlePath: oldBundle,
    bookmark: inspected.bookmark,
    dataMode: undefined,
    iconSource: custom ? 'user' : 'host-default',
  })
  await rm(created.path, { recursive: true })
  await rm(f.record)
  return { oldRecord, oldBundle }
}
describe.skipIf(process.platform !== 'darwin')('native shortcut transaction (no Host launch)', () => {
  it('creates separate CordisX entries for both data modes of one profile', async () => {
    const f = await fixture()
    const isolated = await createShortcut(f.input)
    const shared = await createShortcut({
      ...f.input,
      dataMode: 'shared',
      invocation: parseCordisXCli([
        'codex',
        'work',
        '--data',
        'shared',
        '--create-shortcut',
      ]) as CordisXManagedInvocation,
    })
    expect(shared.path).not.toBe(isolated.path)
    expect(path.basename(shared.path)).toContain('Shared')
    expect(path.basename(isolated.path)).toContain('Isolated')
    const sharedRecord = path.join(
      f.input.output.registry,
      shortcutKey(await realpath(f.input.home), 'codex', 'work', 'shared') + '.json',
    )
    expect(JSON.parse(await readFile(sharedRecord, 'utf8')).argv).toContain('shared')
    expect(JSON.parse(await readFile(f.record, 'utf8')).argv).toContain('host-isolated')
  })
  it('migrates a matching legacy record to one named CordisX entry', async () => {
    const f = await fixture(), legacy = await makeLegacyEntry(f)
    const migrated = await createShortcut(f.input)
    expect(migrated.updated).toBe(true)
    expect(path.basename(migrated.path)).toBe('CordisX · Fixture · work · Isolated.app')
    expect((await inspectBundle(migrated.path)).entryId)
      .toBe(shortcutKey(await realpath(f.input.home), 'codex', 'work', 'host-isolated'))
    await expect(stat(legacy.oldBundle)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(legacy.oldRecord)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves a Finder custom icon during legacy migration', async () => {
    const f = await fixture(), legacy = await makeLegacyEntry(f, true)
    const migrated = await createShortcut(f.input)
    expect(migrated.iconSource).toBe('user')
    expect((await inspectBundle(migrated.path)).customIcon).toBe(true)
    await expect(stat(legacy.oldBundle)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('prepares both Dock appearances from an automatic entry', async () => {
    const f = await fixture(), created = await createShortcut(f.input)
    expect((await stat(path.join(created.path, 'Contents/Resources/dock-light.icns'))).isFile()).toBe(true)
    expect((await stat(path.join(created.path, 'Contents/Resources/dock-default.icns'))).isFile()).toBe(true)
    const scope = dockScope(
      shortcutKey(await realpath(f.input.home), 'codex', 'work', 'host-isolated'),
      f.record,
      f.root,
    )
    expect(await prepareDockImage(scope, { home: await realpath(f.input.home), app: 'codex', profile: 'work' }))
      .toBe(true)
    for (const file of [scope.lightIconPath, scope.darkIconPath, scope.defaultIconPath]) {
      expect((await stat(file)).size).toBeGreaterThan(1024)
    }
    await expect(stat(scope.iconPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('updates the same entry and preserves a user rename/move', async () => {
    const f = await fixture(), first = await createShortcut(f.input)
    const moved = path.join(f.root, 'My renamed entry.app')
    await rename(first.path, moved)
    const result = await createShortcut(f.input)
    expect(result.path).toBe(await realpath(moved))
    expect(result.updated).toBe(true)
    expect(JSON.parse(await readFile(f.record, 'utf8')).bundlePath).toBe(await realpath(moved))
  })
  it('restores the actually displaced path after a moved entry commit fails', async () => {
    const f = await fixture(), first = await createShortcut(f.input)
    const moved = path.join(f.root, 'Moved.app')
    await rename(first.path, moved)
    // Force an icon transaction without modifying unrelated files.
    const record = JSON.parse(await readFile(f.record, 'utf8'))
    record.iconDigest = 'outdated'
    await store.writePrivateJson(f.record, record)
    const original = store.writePrivateJson
    vi.spyOn(store, 'writePrivateJson').mockImplementation(async (file, value) => {
      if (file === f.record) throw new Error('injected record commit failure')
      await original(file, value)
    })
    await expect(createShortcut(f.input)).rejects.toThrow('injected')
    expect((await stat(moved)).isDirectory()).toBe(true)
    await expect(stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves Finder customization and reassembles after the user removes it', async () => {
    const f = await fixture(), first = await createShortcut(f.input)
    const before = (await stat(first.path)).ino
    const finderInfo = Buffer.alloc(32)
    finderInfo.writeUInt16BE(0x0400, 8)
    execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.FinderInfo', finderInfo.toString('hex'), first.path])
    expect((await createShortcut(f.input)).iconSource).toBe('user')
    expect((await stat(first.path)).ino).toBe(before)
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.FinderInfo', first.path])
    expect((await createShortcut(f.input)).iconSource).toBe('cordisx-default')
    expect((await stat(first.path)).ino).not.toBe(before)
    expect(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', first.path])).not.toThrow()
  })
  it('never overwrites an unrelated same-name file', async () => {
    const f = await fixture(), target = path.join(f.input.output.directory, 'CordisX · Fixture · work · Isolated.app')
    await writeFile(target, 'keep')
    await expect(createShortcut(f.input)).rejects.toThrow('unrelated')
    expect(await readFile(target, 'utf8')).toBe('keep')
  })
  it('keeps optional Dock initialization usable after its saved entry is deleted', async () => {
    const f = await fixture(), created = await createShortcut(f.input)
    const scope = dockScope(
      shortcutKey(await realpath(f.input.home), 'codex', 'work', 'host-isolated'),
      f.record,
      f.root,
    )
    await writeFile(scope.iconPath, 'stale', { mode: 0o600 })
    await rm(created.path, { recursive: true })
    await expect(prepareOptionalDockImage(scope, { home: await realpath(f.input.home), app: 'codex', profile: 'work' }))
      .resolves.toBeUndefined()
    await expect(stat(scope.iconPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
