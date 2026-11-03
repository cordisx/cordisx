import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { nativeBrowserSessionTransforms } from '../packages/codex-adapter/src/native-browser-session-transform.js'

const source =
  `function integrate(scope,manager,dispatch){const capture=({conversationId:id})=>dispatch('browser-use-session-route-capture',{conversationId:id,browserConversationId:scope.resolve(id)});manager.addNotificationCallback('thread/started',({params:{thread}})=>capture({conversationId:thread.id}));manager.addStreamRoleStateCallback((id,state)=>{state?.role==='owner'&&capture({conversationId:id})})}`
const resource = { url: 'app://-/assets/browser-session.js', source }

describe('native browser session catch-up', () => {
  it('captures only authoritative owners when the browser module loads after resume', () => {
    const transform = nativeBrowserSessionTransforms([resource])[0]!
    const result = transform.transform(source)
    const callbacks: ((id: string, state: unknown) => void)[] = []
    const routes: unknown[] = []
    const roles = new Map([['owned', 'owner'], ['follower', 'follower']])
    const manager = {
      addNotificationCallback() {},
      addStreamRoleStateCallback() {},
      addConversationStateCallback(callback: (id: string, state: unknown) => void) {
        callbacks.push(callback)
      },
      getStreamRole(id: string) {
        return roles.has(id) ? { role: roles.get(id) } : null
      },
      getCachedConversations() {
        return [{ id: 'owned' }, { id: 'follower' }, { id: 'unknown' }]
      },
    }
    const context = {
      manager,
      scope: { resolve: (id: string) => `normalized:${id}` },
      dispatch: (_: string, value: unknown) => routes.push(value),
    }
    runInNewContext(`${result.source};integrate(scope,manager,dispatch)`, context)
    expect(routes).toEqual([{ conversationId: 'owned', browserConversationId: 'normalized:owned' }])
    callbacks[0]!('owned', { id: 'owned' })
    expect(routes).toHaveLength(1)
    roles.set('newly-resumed', 'owner')
    callbacks[0]!('newly-resumed', { id: 'newly-resumed' })
    expect(routes).toHaveLength(2)
    callbacks[0]!('owned', null)
    callbacks[0]!('owned', { id: 'owned' })
    expect(routes).toHaveLength(3)
    runInNewContext('globalThis.__cordisxNativeBrowserSessionCatchupV1={}', context)
    callbacks[0]!('after-dispose', { id: 'after-dispose' })
    expect(routes).toHaveLength(3)
    runInNewContext(result.fenceExpression, context)
    roles.set('after-dispose', 'owner')
    callbacks[0]!('after-dispose', { id: 'after-dispose' })
    expect(routes).toHaveLength(3)
    expect(transform.requiredForDocumentReady).toBe(false)
  })

  it('fails closed on absent, ambiguous or unguarded native capture structures', () => {
    expect(nativeBrowserSessionTransforms([])).toEqual([])
    expect(nativeBrowserSessionTransforms([resource, { ...resource, url: 'app://-/assets/duplicate.js' }])).toEqual([])
    expect(nativeBrowserSessionTransforms([{ ...resource, source: source.replace("state?.role==='owner'", 'true') }]))
      .toEqual([])
  })

  it('retains exact byte identity and validates replacement syntax', () => {
    const transform = nativeBrowserSessionTransforms([resource])[0]!
    expect(() => transform.transform(`${source};`)).toThrow('Native resource changed')
    expect(transform.transform(source).anchorMatches).toBe(1)
  })
})
