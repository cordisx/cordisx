import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'
import type { SelectionPatch } from './native-model-provider-state.js'

/** Apply the existing native Fast setting through the transport's scoped authority. */
export async function applyNativeFastMode(
  enabled: boolean,
  control: NativeModelSelectionControl | undefined,
  selectedModel: string | undefined,
  threadId: string | undefined,
  request: (
    method: 'thread/settings/update',
    params: { threadId: string; serviceTier: 'priority' | null },
  ) => Promise<unknown>,
  assertCurrent: () => void,
  publish: (patch: SelectionPatch) => void,
): Promise<'accepted' | 'unavailable'> {
  const model = selectedModel ?? control?.model
  const supports = control?.models.some(item => item.id === model && item.supportsFastMode) === true
  if (!control || !model || enabled && !supports) return 'unavailable'
  publish({ error: null })
  try {
    if (threadId !== undefined) {
      await request('thread/settings/update', { threadId, serviceTier: enabled ? 'priority' : null })
    }
    assertCurrent()
    publish({ serviceTier: enabled ? 'priority' : null, error: null })
    return 'accepted'
  } catch (error) {
    try {
      assertCurrent()
      publish({
        error: error instanceof Error && error.message.trim()
          ? error.message
          : 'Native model provider selection failed',
      })
    } catch { /* A superseded selection does not publish into its successor. */ }
    return 'unavailable'
  }
}
