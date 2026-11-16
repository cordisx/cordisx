import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import { ChannelConversationDisplayStore } from '../packages/cli/src/launcher/channel-conversation-display-store.js'

const ref = {
  adapterId: 'feishu',
  accountId: 'own',
  tenantId: 'tenant',
  conversationId: 'oc_group',
  kind: 'group' as const,
}
const avatar: RasterImageSnapshotV1 = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
  contract: 'cordisx.raster-image-snapshot/v1',
  schemaVersion: 1,
  mediaType: 'image/png',
  encoding: 'base64',
  width: 1,
  height: 1,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
}

describe('durable conversation display hints', () => {
  it('reopens normalized names and avatars without persisting a capability or private input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-display-'))
    const file = path.join(root, 'conversation-display.json')
    try {
      const store = await ChannelConversationDisplayStore.open(file)
      store.retainAccounts([ref])
      store.put(ref, { name: '  Project\0 group ', avatar })
      const updatedAt = store.get(ref)?.updatedAt
      store.put(ref, { name: 'oc_group', avatar: { ...avatar, data: 'https://private.test/image' } })
      expect(store.get(ref)?.updatedAt).toBe(updatedAt)
      await store.close()
      const saved = await ChannelConversationDisplayStore.open(file)
      expect(saved.get(ref)).toMatchObject({ name: 'Project  group', avatar })
      expect(saved.get({ ...ref, accountId: 'other' })).toBeUndefined()
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await readFile(file, 'utf8')).not.toMatch(/private|token|messages|https:\/\/private/u)
      await saved.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes retired accounts and refuses late writes that would restore them', async () => {
    const store = new ChannelConversationDisplayStore()
    store.put(ref, { name: 'Old group' })
    store.retainAccounts([{ ...ref, accountId: 'other' }])
    store.put(ref, { name: 'Late old result' })
    expect(store.list(ref)).toEqual([])
    await store.close()
    store.put({ ...ref, accountId: 'other' }, { name: 'Disposed' })
    expect(store.list({ ...ref, accountId: 'other' })).toEqual([])
  })

  it('ignores malformed local data and keeps ordinary startup available', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-display-corrupt-'))
    const file = path.join(root, 'conversation-display.json')
    try {
      await writeFile(file, '{broken')
      const store = await ChannelConversationDisplayStore.open(file)
      expect(store.list(ref)).toEqual([])
      store.put(ref, { name: 'Recovered group' })
      await store.close()
      const saved = await ChannelConversationDisplayStore.open(file)
      expect(saved.get(ref)?.name).toBe('Recovered group')
      await saved.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
