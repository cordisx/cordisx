import type {
  NativeSubmissionController,
  NativeSubmissionControllerOptions,
  NativeSubmissionScope,
} from './native-submission-controller-contracts.js'
import { sameScope } from './native-submission-records.js'

/** Navigation requires both the authenticated chain and the same idle native scope. */
export function desktopLogicalNavigation(input: {
  runtime: NativeSubmissionControllerOptions['runtime']
  migration: NativeSubmissionControllerOptions['logicalMigration']
  disposed(): boolean
}) {
  return async (scope: NativeSubmissionScope, sessionId: string) => {
    try {
      return !input.disposed() && !!input.migration && await input.runtime.revalidate(scope, true)
        && await input.migration.canNavigate(scope, sessionId)
        && !input.disposed() && await input.runtime.revalidate(scope, true)
        && await input.migration.canNavigate(scope, sessionId)
    } catch {
      return false
    }
  }
}

type NeighborInput = {
  runtime: NativeSubmissionControllerOptions['runtime']
  migration: NativeSubmissionControllerOptions['logicalMigration']
  disposed(): boolean
}

function desktopLogicalNeighbor(input: NeighborInput, direction: 'previous' | 'next') {
  return async (scope: NativeSubmissionScope) => {
    try {
      if (input.disposed() || !input.migration || !await input.runtime.revalidate(scope, false)) return undefined
      const neighbor = await input.migration[direction](scope)
      if (!neighbor || input.disposed() || !await input.runtime.revalidate(scope, false)) return undefined
      return await input.migration[direction](scope) === neighbor && !input.disposed() ? neighbor : undefined
    } catch {
      return undefined
    }
  }
}

/** Read one authenticated boundary in either direction. */
export const desktopLogicalNeighbors = (input: NeighborInput) => ({
  logicalPrevious: desktopLogicalNeighbor(input, 'previous'),
  logicalNext: desktopLogicalNeighbor(input, 'next'),
})

/** CDP dispatch keeps the document owner live through the controller check. */
export async function desktopLogicalCdpNavigation(
  controller: NativeSubmissionController,
  scope: NativeSubmissionScope,
  sessionId: unknown,
  current: () => Promise<NativeSubmissionScope | undefined>,
  disposed: () => boolean,
) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[\0\r\n]/u.test(sessionId)) {
    throw new Error('Invalid logical session')
  }
  const allowed = await controller.logicalSourceNavigation(scope, sessionId)
  const live = await current()
  return allowed && !!live && sameScope(live, scope) && !disposed()
}
