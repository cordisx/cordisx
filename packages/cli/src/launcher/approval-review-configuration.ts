import { loadHomeConfig, updateHomeConfigAtomic } from '../config/home-config.js'
import { parseApprovalReviewSettings } from '../config/approval-review-config.js'
import { callerThreadId } from './agent-bridge-context.js'
import { readApprovalReviewCatalog } from './approval-review-catalog.js'

/** Reviewer routing is operator-owned; a reviewed agent cannot choose its own reviewer. */
export function createApprovalReviewConfiguration(input: { configPath: string; profileId: string }) {
  return async (operation: string, value: unknown, metadata?: unknown) => {
    try {
      const args = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
      const allowed = operation === 'read' ? [] : operation === 'save' ? ['settings', 'expectedRevision'] : undefined
      if (!args || !allowed || Object.keys(args).some(key => !allowed.includes(key))) {
        throw new Error('INVALID_REQUEST')
      }
      const context = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
      if (operation === 'save' && (callerThreadId(metadata) || context['cordisx/channelContext'] !== undefined)) {
        throw new Error('LOCAL_USER_REQUIRED')
      }
      const config = await loadHomeConfig(input.configPath)
      const profile = config.apps.codex?.profiles[input.profileId]
      if (!profile) throw new Error('PROFILE_UNAVAILABLE')
      if (operation === 'read') {
        return {
          status: 'ok',
          revision: profile.approvalReview?.revision ?? 0,
          settings: profile.approvalReview?.settings ?? null,
          applies: 'native-restart',
          scope: 'profile',
          sessionOverride: false,
          routing: 'parent-provider',
        }
      }
      if (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0) {
        throw new Error('INVALID_REVISION')
      }
      const settings = args.settings === null ? null : parseApprovalReviewSettings(args.settings)
      if (settings) await readApprovalReviewCatalog(settings, input.configPath)
      const next = await updateHomeConfigAtomic(config => {
        const app = config.apps.codex, profile = app?.profiles[input.profileId]
        if (!profile) throw new Error('PROFILE_UNAVAILABLE')
        if ((profile.approvalReview?.revision ?? 0) !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
        return {
          ...config,
          apps: {
            ...config.apps,
            codex: {
              ...app,
              profiles: {
                ...app.profiles,
                [input.profileId]: {
                  ...profile,
                  approvalReview: { revision: Number(args.expectedRevision) + 1, settings },
                },
              },
            },
          },
        }
      }, input.configPath)
      return {
        status: 'ok',
        ...next.apps.codex!.profiles[input.profileId]!.approvalReview!,
        applies: 'native-restart',
        application: 'saved',
        scope: 'profile',
        routing: 'parent-provider',
        sessionOverride: false,
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
        ? error.message
        : 'REVIEW_CONFIGURATION_UNAVAILABLE'
      return { status: 'rejected', code }
    }
  }
}
