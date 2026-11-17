import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { finishNativeContextCapture, prepareNativeContextCapture } from './native-context-capture.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

/** Capture only a request actually dispatched to this launch-owned app-server. */
export function createDesktopNativeContextCapture({ path, sha256, nativeVersion, serverId, read, emit }) {
  if (!path || !/^[a-f0-9]{64}$/u.test(sha256 ?? '') || nativeVersion !== '0.167.0-alpha.3.2') return undefined
  let startup
  const known = new Map()
  return {
    async invalidate(method, params) {
      const sessionId = params?.threadId
      if (!known.has(sessionId)) return
      const config = object(params.config)
      if (
        method === 'thread/resume' || ['thread/settings/update', 'turn/start'].includes(method)
          && (params.model != null && params.model !== known.get(sessionId)
            || params.modelProvider != null && params.modelProvider !== 'openai'
            || Object.keys(config).some(key =>
              key.startsWith('features') || key.startsWith('model_context_window')
              || key.startsWith('model_auto_compact') || key.startsWith('model_post_turn_compact')
            ))
      ) {
        known.delete(sessionId)
        try {
          await emit('cordisx/context/invalidate', { threadId: sessionId })
        } catch { /* Optional observation. */ }
      }
    },
    async prepare(method, params) {
      if (method !== 'thread/start' || typeof params.cwd !== 'string') return undefined
      try {
        const bytes = await readFile(path)
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) return undefined
        const startupConfig = object(
          object(
            await read('config/read', {
              cwd: process.cwd(),
              includeLayers: false,
            }),
          ).config,
        )
        const config = object(object(await read('config/read', { cwd: params.cwd, includeLayers: false })).config)
        const requirementsValue = object(await read('configRequirements/read', {})).requirements
        const requirements = object(requirementsValue)
        if (
          startupConfig.model_provider !== 'openai' || startupConfig.model_catalog_json !== path
          || config.model_catalog_json !== path || requirementsValue !== null
            && !['modelProvider', 'modelProviders', 'modelCatalogJson'].every(key =>
              Object.hasOwn(requirements, key) && requirements[key] === null
            )
        ) return undefined
        startup ??= {
          nativeVersion,
          serverId,
          providerId: 'openai',
          providerKind: 'openai-compatible',
          catalogSha256: sha256,
          catalogBytes: bytes,
        }
        let model = typeof config.model === 'string' ? config.model : undefined
        if (params.model == null && !model) {
          const defaults = [], cursors = new Set()
          let cursor
          do {
            if (cursors.size >= 8 || cursor && cursors.has(cursor)) return undefined
            if (cursor) cursors.add(cursor)
            const page = await read('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
            if (!Array.isArray(page?.data)) return undefined
            defaults.push(...page.data.filter(row =>
              row?.hidden === false && row?.isDefault === true
              && typeof row.model === 'string' && row.model.length
            ))
            cursor = page.nextCursor ?? undefined
          } while (cursor)
          if (defaults.length !== 1) return undefined
          model = defaults[0].model
        }
        const candidate = params.model == null && model ? { ...params, model } : params
        return {
          startup,
          config,
          featureRequirements: requirementsValue === null ? null : requirements.featureRequirements,
          candidate,
        }
      } catch {
        return undefined
      }
    },
    bind(preflight, requestId, submitted) {
      if (!preflight) return undefined
      try {
        const prepared = prepareNativeContextCapture({
          startup: preflight.startup,
          preflight: {
            serverId,
            cwd: submitted.cwd,
            originator: 'cordisx-desktop',
            config: preflight.config,
            featureRequirements: preflight.featureRequirements,
          },
          request: { id: requestId, method: 'thread/start', params: preflight.candidate },
        })
        if (prepared.status !== 'ready') return undefined
        Object.assign(submitted, preflight.candidate)
        submitted.config = { ...object(submitted.config), ...prepared.configPatch }
        return prepared.handle
      } catch {
        return undefined
      }
    },
    async finish(handle, requestId, submitted, result) {
      if (!handle) return
      try {
        const receipt = finishNativeContextCapture(handle, {
          serverId,
          requestId,
          submittedParams: submitted,
          response: { id: requestId, result },
        }, (_startup, thread) => thread)
        if (receipt?.sessionId) {
          known.set(receipt.sessionId, receipt.responseModel)
          await emit('cordisx/context/captured', receipt)
        }
      } catch { /* Native effect already completed; observation is optional. */ }
    },
  }
}
