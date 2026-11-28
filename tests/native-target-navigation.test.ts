import { expect, it } from 'vitest'
import type { CdpTarget } from '../packages/cli/src/launcher/cdp-session.js'
import { NativeTargetNavigationGrace } from '../packages/cli/src/launcher/native-target-navigation.js'

it('retains only an existing same-socket native target for a bounded empty-URL reload', () => {
  const target: CdpTarget = {
    id: 'workspace',
    type: 'page',
    title: 'Codex',
    url: 'app://-/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1/workspace',
  }
  let closed = false
  const installed = new Map([[target.id, { target, session: { isClosed: () => closed } }]])
  const grace = new NativeTargetNavigationGrace(1_000)
  const blank = { ...target, url: '' }
  expect([...grace.retain([blank], installed, 0)]).toEqual(['workspace'])
  expect([...grace.retain([{ ...blank, url: 'about:blank' }], installed, 999)]).toEqual(['workspace'])
  expect([...grace.retain([blank], installed, 1_000)]).toEqual([])
  expect([...grace.retain([target], installed, 1_001)]).toEqual([])
  expect([...grace.retain([blank], installed, 1_002)]).toEqual(['workspace'])
  expect([...grace.retain([{ ...blank, webSocketDebuggerUrl: 'ws://127.0.0.1/other' }], installed, 1_003)])
    .toEqual([])
  expect([...grace.retain([{ ...blank, url: 'https://chatgpt.com/' }], installed, 1_004)]).toEqual([])
  closed = true
  expect([...grace.retain([blank], installed, 1_005)]).toEqual([])
})
