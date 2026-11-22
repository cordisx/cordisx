import { isDeepStrictEqual } from 'node:util'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'

type Native = { nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown> }
type Placement = { name: string | null; projectId: string | null; sectionId: string | null }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)

/** Missing metadata is not evidence that a source is projectless or unsectioned. */
export async function logicalPresentation(native: Native, threadId: string): Promise<Placement | undefined> {
  const thread = object(object(await native.nativeRequest('thread/read', { threadId, includeTurns: false }))?.thread)
  if (!thread || thread.id !== threadId || !['name', 'projectId', 'section'].every(key => Object.hasOwn(thread, key))) {
    return undefined
  }
  const section = thread.section === null ? null : object(thread.section)?.id
  if (
    thread.name !== null && !text(thread.name) || thread.projectId !== null && !text(thread.projectId)
    || section !== null && !text(section)
  ) return undefined
  return { name: thread.name as string | null, projectId: thread.projectId as string | null, sectionId: section }
}

/** Preserve the native project and explicit section position before accepting a new destination. */
export async function placeLogicalDestination(
  native: Native,
  fence: ChannelNativeSourceFence,
  sourceId: string,
  destination: string,
  source: Placement,
  available: (threadId: string) => boolean,
  providers: readonly string[],
) {
  if (!available(destination)) return false
  let target = await logicalPresentation(native, destination)
  if (!target || !available(destination) || !isDeepStrictEqual(await logicalPresentation(native, sourceId), source)) {
    return false
  }
  if (target.projectId !== source.projectId && (target.projectId !== null || source.projectId === null)) return false
  const name = source.name ?? 'Continued conversation'
  await native.nativeRequest(
    'thread/name/set',
    fence.allowOwned('thread/name/set', destination, {
      threadId: destination,
      name,
    }),
  )
  if (target.projectId !== source.projectId) {
    await native.nativeRequest(
      'thread/metadata/update',
      fence.allowOwned('thread/metadata/update', destination, { threadId: destination, projectId: source.projectId }),
    )
  }
  target = await logicalPresentation(native, destination)
  if (
    !target || target.projectId !== source.projectId || target.name !== name
    || target.sectionId !== null && target.sectionId !== source.sectionId
    || !available(destination) || !isDeepStrictEqual(await logicalPresentation(native, sourceId), source)
  ) return false
  if (source.sectionId !== null) {
    await native.nativeRequest(
      'thread/section/move',
      fence.allowOwned('thread/section/move', destination, {
        threadId: destination,
        sectionId: source.sectionId,
        beforeThreadId: sourceId,
      }),
    )
    const page = object(
      await native.nativeRequest('thread/list', {
        sectionId: source.sectionId,
        includedThreadIds: [destination, sourceId],
        sortKey: 'section_position',
        sortDirection: 'asc',
        limit: 2,
        modelProviders: [...new Set(providers)],
        sourceKinds: [
          'cli',
          'vscode',
          'exec',
          'appServer',
          'subAgent',
          'subAgentReview',
          'subAgentCompact',
          'subAgentThreadSpawn',
          'subAgentOther',
          'unknown',
        ],
      }),
    )
    if (
      !page || !Array.isArray(page.data) || page.data.length !== 2
      || object(page.data[0])?.id !== destination || object(page.data[1])?.id !== sourceId
    ) return false
  }
  target = await logicalPresentation(native, destination)
  return !!target && target.name === name && target.projectId === source.projectId
    && target.sectionId === source.sectionId && available(destination)
    && isDeepStrictEqual(await logicalPresentation(native, sourceId), source)
}
