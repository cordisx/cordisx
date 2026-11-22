import type { NativeSubmissionScope } from './native-provider-selection-client.js'

/** Bind the current composer and thread to its renderer and navigation generation. */
export function nativeSubmissionScope(
  owner: Pick<NativeSubmissionScope, 'targetId' | 'rendererGeneration'>,
  navigationGeneration: number,
  composerId: string | undefined,
  threadId: string | undefined,
): NativeSubmissionScope {
  return {
    ...owner,
    navigationGeneration,
    ...(composerId === undefined ? {} : { composerId }),
    ...(threadId === undefined ? {} : { threadId }),
  }
}
