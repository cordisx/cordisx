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

/** Read a single previous boundary for the current authenticated composer. */
export function desktopLogicalPrevious(input: {
  runtime: NativeSubmissionControllerOptions['runtime']
  migration: NativeSubmissionControllerOptions['logicalMigration']
  disposed(): boolean
}) {
  return async (scope: NativeSubmissionScope) => {
    try {
      if (input.disposed() || !input.migration || !await input.runtime.revalidate(scope, false)) return undefined
      const previous = await input.migration.previous(scope)
      if (!previous || input.disposed() || !await input.runtime.revalidate(scope, false)) return undefined
      return await input.migration.previous(scope) === previous && !input.disposed() ? previous : undefined
    } catch {
      return undefined
    }
  }
}

/** CDP dispatch keeps the document owner live through the controller check. */
export async function desktopLogicalCdpNavigation(
  controller: NativeSubmissionController,
  scope: NativeSubmissionScope,
  sessionId: unknown,
  current: () => Promise<NativeSubmissionScope | undefined>,
  disposed: () => boolean,
) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[\0\r\n]/u.test(sessionId)) {
    throw new Error('Invalid logical source')
  }
  const allowed = await controller.logicalSourceNavigation(scope, sessionId)
  const live = await current()
  return allowed && !!live && sameScope(live, scope) && !disposed()
}
