import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { NativeComposerCreationHandoff } from '../packages/cli/src/renderer/native-composer-creation-handoff.js'
import { attachNativeCreatedRoute, attachNativeCreation } from './fixtures/native-composer-creation.js'

const renderer = { targetId: 'target', rendererGeneration: 'document-generation' }
const scope = { ...renderer, composerId: 'draft', navigationGeneration: 2 }
const token = 'exact-operation-token-a'
const clientThreadId = 'client-new-thread:own-a'
const selected = { providerId: 'aiden', model: 'model-b' }

function fixture() {
  const dom = new JSDOM('<body><main></main><aside></aside></body>')
  const root = dom.window.document.querySelector('main')!
  const side = dom.window.document.querySelector('aside')!
  const creation = attachNativeCreation(root, { clientThreadId, operationToken: token })
  let now = 0
  const store = new NativeComposerCreationHandoff(renderer, () => now)
  store.admit(scope, token, selected, 'low')
  return {
    dom,
    root,
    side,
    store,
    ...creation,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe('native creation display handoff', () => {
  it('joins the admitted tuple to an exact pending token and the native committed client route', () => {
    const h = fixture()
    try {
      const pending = h.store.read(h.root, undefined)
      expect(pending).toEqual({ clientThreadId, ...selected, reasoningEffort: 'low' })
      expect(JSON.stringify(pending)).not.toContain(token)
      h.root.remove()
      attachNativeCreatedRoute(h.side, clientThreadId, 'created')
      expect(h.store.read(h.side, 'created')).toEqual({
        clientThreadId,
        ...selected,
        reasoningEffort: 'low',
        threadId: 'created',
      })
      h.store.acknowledge(h.side, 'created')
      expect(h.store.read(h.side, 'created')).toBeUndefined()
    } finally {
      h.store.dispose()
      h.dom.window.close()
    }
  })

  it.each(['token', 'model', 'effort', 'unrelated', 'side', 'wrong-thread'])(
    'does not display another selection through %s',
    mismatch => {
      const h = fixture()
      try {
        if (mismatch === 'token') {
          h.pending.startConversationParamsInput.configOverrides!['cordisx.operation_token'] =
            'unrelated-operation-token'
        }
        if (mismatch === 'model') h.pending.startConversationParamsInput.collaborationMode.settings.model = 'other'
        if (mismatch === 'effort') {
          h.pending.startConversationParamsInput.collaborationMode.settings.reasoning_effort = 'high'
        }
        if (mismatch === 'unrelated') h.owner.memoizedProps.pendingClientThreadId = 'other-client'
        if (mismatch === 'side') {
          h.fiber.return = {
            memoizedProps: { conversationId: 'side-chat', pendingClientThreadId: null, hostId: 'local' },
            return: h.owner,
          }
        }
        expect(h.store.read(h.root, mismatch === 'wrong-thread' ? 'unrelated-thread' : undefined)).toBeUndefined()
      } finally {
        h.store.dispose()
        h.dom.window.close()
      }
    },
  )

  it.each(['cancel', 'failure', 'navigation'])(
    'retires observed creation labels after %s instead of reviving the old token',
    reason => {
      const h = fixture()
      try {
        expect(h.store.read(h.root, undefined)).toBeDefined()
        if (reason === 'cancel') h.owner.child.sibling = null as never
        if (reason === 'failure') h.pending.phase = 'failed'
        if (reason === 'navigation') h.owner.memoizedProps.pendingClientThreadId = 'other'
        expect(h.store.read(h.root, undefined)).toBeUndefined()
        attachNativeCreation(h.root, { clientThreadId, operationToken: token })
        h.store.admit(scope, token, selected, 'low')
        expect(h.store.read(h.root, undefined)).toBeUndefined()
      } finally {
        h.store.dispose()
        h.dom.window.close()
      }
    },
  )

  it('keeps concurrent composers and document generations independent', () => {
    const h = fixture()
    try {
      h.store.admit({ ...scope, composerId: 'side' }, 'exact-operation-token-b', {
        providerId: 'traex',
        model: 'model-c',
      }, 'high')
      attachNativeCreation(h.side, {
        clientThreadId: 'client-new-thread:own-b',
        operationToken: 'exact-operation-token-b',
        model: 'model-c',
        effort: 'high',
      })
      expect(h.store.read(h.root, undefined)?.providerId).toBe('aiden')
      expect(h.store.read(h.side, undefined)?.providerId).toBe('traex')
      const otherDocument = new NativeComposerCreationHandoff({ ...renderer, rendererGeneration: 'other' })
      otherDocument.admit(scope, token, selected, 'low')
      expect(otherDocument.read(h.root, undefined)).toBeUndefined()
      otherDocument.dispose()
      h.store.dispose()
      expect(h.store.read(h.root, undefined)).toBeUndefined()
    } finally {
      h.store.dispose()
      h.dom.window.close()
    }
  })

  it('keeps the handoff after the real thread marker appears on the pending Composer', () => {
    const h = fixture()
    try {
      expect(h.store.read(h.root, undefined)).toBeDefined()
      h.root.setAttribute('data-codex-composer-root', '')
      const marker = h.dom.window.document.createElement('i')
      marker.setAttribute('data-above-composer-conversation-id', 'created')
      h.root.append(marker)
      expect(h.store.read(h.root, 'created')?.threadId).toBe('created')
      h.store.acknowledge(h.root, 'created')
      h.root.remove()
      attachNativeCreatedRoute(h.side, clientThreadId, 'created')
      expect(h.store.read(h.side, 'created')?.model).toBe('model-b')
    } finally {
      h.store.dispose()
      h.dom.window.close()
    }
  })

  it('rejects a reused ambiguous admission and expires retained display', () => {
    const h = fixture()
    try {
      h.store.admit({ ...scope, composerId: 'other' }, token, selected, 'low')
      expect(h.store.read(h.root, undefined)).toBeUndefined()
      h.store.admit(scope, 'exact-operation-token-b', selected, 'low')
      attachNativeCreation(h.root, { clientThreadId, operationToken: 'exact-operation-token-b' })
      expect(h.store.read(h.root, undefined)).toBeDefined()
      h.setNow(600_000)
      expect(h.store.read(h.root, undefined)).toBeUndefined()
    } finally {
      h.store.dispose()
      h.dom.window.close()
    }
  })
})
