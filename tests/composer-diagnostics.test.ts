import { expect, it, vi } from 'vitest'
import { observeComposerDiagnostics } from '../packages/cli/src/launcher/composer-diagnostics.js'
import { withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { COMPOSER_DIAGNOSTIC_CHANNEL } from '../packages/cli/src/renderer/native-composer-diagnostics.js'

it('journals only allowlisted timing fields even when launcher stdout is discarded', () => {
  let receive!: (event: Record<string, unknown>) => void
  const emit = vi.fn()
  const close = vi.fn()
  const dispose = withDiagnostics({ emit }, () =>
    observeComposerDiagnostics({
      onEvent: (_, listener) => {
        receive = listener
        return close
      },
    }))
  const send = (value: unknown) =>
    receive({ args: [{ value: COMPOSER_DIAGNOSTIC_CHANNEL }, { value: JSON.stringify(value) }] })
  send({ phase: 'thread/read', state: 'timeout', elapsedMs: 30000, token: 'secret', params: 'private' })
  expect(emit).toHaveBeenCalledWith({
    event: 'composer-readiness',
    phase: 'thread/read',
    state: 'timeout',
    elapsedMs: 30000,
  })
  send({ phase: 'permissions/menu', state: 'timeout', elapsedMs: 2000, label: 'private', threadId: 'private' })
  expect(emit).toHaveBeenLastCalledWith({
    event: 'composer-readiness',
    phase: 'permissions/menu',
    state: 'timeout',
    elapsedMs: 2000,
  })
  send({ phase: 'secret', state: 'ready', elapsedMs: 5 })
  send({ phase: 'refresh', state: 'ready', elapsedMs: -1 })
  expect(emit).toHaveBeenCalledTimes(2)
  dispose()
  expect(close).toHaveBeenCalledOnce()
})
