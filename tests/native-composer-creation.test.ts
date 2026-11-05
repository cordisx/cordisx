import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { locateNativeComposerCreationSelection } from '../packages/cli/src/renderer/adapter/native-composer-creation.js'
import { composer } from './fixtures/native-model-provider-composer.js'
import { attachNativeCreation } from './fixtures/native-composer-creation.js'

function fixture() {
  const dom = new JSDOM('<body></body>')
  composer(dom.window.document, null)
  const root = dom.window.document.querySelector<HTMLElement>('[data-codex-composer-root]')!
  return { dom, root, ...attachNativeCreation(root) }
}

describe('pending native Composer selection', () => {
  it.each(['queued', 'creating', 'setting-up', 'worktree-ready'])(
    'reads captured creation choices in %s without borrowing config defaults',
    phase => {
      const h = fixture()
      try {
        h.pending.phase = phase
        expect(locateNativeComposerCreationSelection(h.root)).toEqual({
          clientThreadId: 'own-client-thread',
          model: 'model-b',
          reasoningEffort: 'low',
        })
      } finally {
        h.dom.window.close()
      }
    },
  )

  it.each(['cancel', 'failed', 'settled', 'unrelated', 'remote', 'missing-model'])(
    'does not retain creation labels after %s',
    change => {
      const h = fixture()
      try {
        if (change === 'cancel') h.owner.child.sibling = null as never
        if (change === 'failed') h.pending.phase = 'failed'
        if (change === 'settled') h.owner.memoizedProps.conversationId = 'created' as never
        if (change === 'unrelated') h.owner.memoizedProps.pendingClientThreadId = 'different'
        if (change === 'remote') h.pending.hostId = 'remote'
        if (change === 'missing-model') h.pending.startConversationParamsInput.collaborationMode.settings.model = ''
        expect(locateNativeComposerCreationSelection(h.root)).toBeUndefined()
      } finally {
        h.dom.window.close()
      }
    },
  )

  it('rejects conflicting creation tuples and respects the nearest conversation owner', () => {
    const h = fixture()
    try {
      ;(h.progress as any).sibling = {
        memoizedProps: {
          pendingWorktree: {
            ...h.pending,
            startConversationParamsInput: {
              collaborationMode: { settings: { model: 'conflicting', reasoning_effort: 'high' } },
            },
          },
        },
      }
      expect(locateNativeComposerCreationSelection(h.root)).toBeUndefined()
      delete (h.progress as any).sibling
      h.fiber.return = {
        memoizedProps: {
          pendingClientThreadId: null,
          conversationId: 'side-chat',
          hostId: 'local',
        },
        return: h.owner,
      }
      expect(locateNativeComposerCreationSelection(h.root)).toBeUndefined()
    } finally {
      h.dom.window.close()
    }
  })

  it('reads the committed React branch instead of a retained canceled alternate', () => {
    const h = fixture()
    try {
      const committedRoot = {}
      ;(h.owner as any).return = { stateNode: { current: committedRoot } }
      ;(h.fiber as any).alternate = {
        memoizedProps: {},
        return: { memoizedProps: { pendingClientThreadId: null, conversationId: 'created', hostId: 'local' } },
      }
      expect(locateNativeComposerCreationSelection(h.root)).toBeUndefined()
    } finally {
      h.dom.window.close()
    }
  })

  it('joins the exact committed client route before the shell receives its pending ID', () => {
    const h = fixture()
    try {
      h.pending.clientThreadId = 'client-new-thread:early-creation'
      h.owner.memoizedProps.pendingClientThreadId = null as never
      ;(h.owner as any).return = {
        memoizedProps: { clientThreadId: h.pending.clientThreadId, conversationId: undefined, hostId: 'local' },
      }
      expect(locateNativeComposerCreationSelection(h.root)).toEqual({
        clientThreadId: h.pending.clientThreadId,
        model: 'model-b',
        reasoningEffort: 'low',
      })
      ;(h.owner as any).return.memoizedProps.conversationId = 'unrelated-thread'
      expect(locateNativeComposerCreationSelection(h.root)).toBeUndefined()
    } finally {
      h.dom.window.close()
    }
  })
})
