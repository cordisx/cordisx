import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'

import { CORDISX_OWNER_DOCUMENT_SERVICE_V1, type CordisXOwnerDocumentsV1 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import {
  createOwnerDocumentBridgeHandler,
  parseOwnerDocumentBindingRequest,
} from '../packages/cli/src/launcher/owner-document-rpc.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true })))
})

describe('owner documents production renderer composition', () => {
  it('keeps one owner-scoped document consistent across two renderer windows and plugin generations', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'tests/fixtures/owner-documents-runtime-plugin.ts')
    const source = pathToFileURL(entry).href
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owner-documents-integration-'))
    temporary.push(home)
    const secret = 'owner-documents-production-secret'
    let generation = 'owner-documents-generation-1'
    const store = new OwnerDocumentStore(home)
    const handlerFor = (activeGeneration: string) =>
      createOwnerDocumentBridgeHandler({
        secret,
        profileId: 'work',
        generation: activeGeneration,
        store,
        principalAllowed: principal =>
          principal.identity.source === source && principal.identity.pluginId === 'owner-documents-runtime',
      })
    let handler = handlerFor(generation)
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'owner-documents-runtime', entry, enabled: true, config: { pluginRevision: 1 } }],
    }
    const authority = () => ({ secret, profileId: 'work', generation })
    const bundle = await buildRendererBundle(config, {
      profileId: 'work',
      generation,
      ownerDocumentAuthority: authority(),
    })

    const boot = async (): Promise<{ dom: JSDOM; client: CordisXOwnerDocumentsV1 }> => {
      const dom = new JSDOM(
        '<html lang="en"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
        {
          runScripts: 'dangerously',
          url: 'https://codex.local/',
        },
      )
      Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
      Object.defineProperty(dom.window, 'structuredClone', { value: globalThis.structuredClone })
      Object.defineProperty(dom.window, 'TextEncoder', { value: TextEncoder })
      Object.defineProperty(dom.window, 'TextDecoder', { value: TextDecoder })
      Object.defineProperty(dom.window, '__cordisxOwnerDocumentRequestV1', {
        configurable: true,
        value: (payload: string) => {
          void (async () => {
            const request = parseOwnerDocumentBindingRequest(JSON.parse(payload))
            const value = request.operation === 'load' ? await handler.load(request) : await handler.replace(request)
            queueMicrotask(() =>
              (dom.window as unknown as { __cordisxOwnerDocumentReceiveV1?: (response: string) => void })
                .__cordisxOwnerDocumentReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
            )
          })()
        },
      })
      dom.window.eval(bundle)
      await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
      const client = (dom.window as unknown as { __cordisxOwnerDocumentsFixture?: { client: CordisXOwnerDocumentsV1 } })
        .__cordisxOwnerDocumentsFixture?.client
      if (client === undefined) throw new Error('owner document plugin did not mount')
      return { dom, client }
    }

    const [left, right] = await Promise.all([boot(), boot()])
    const create = (client: CordisXOwnerDocumentsV1, windowId: string) =>
      client.replace({
        contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
        documentId: 'room-registry',
        expectedRevision: 0,
        schemaVersion: 1,
        value: { operationId: `create-${windowId}`, state: 'planned' },
      })
    const results = await Promise.all([create(left.client, 'left'), create(right.client, 'right')])
    expect(results.map(result => result.status).sort()).toEqual(['accepted', 'conflict'])

    const observed: string[] = []
    const unsubscribe = right.client.subscribe('room-registry', result => {
      if (result.status === 'loaded') {
        observed.push(`${result.snapshot.revision}:${String((result.snapshot.value as { state?: unknown }).state)}`)
      }
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    const loaded = await left.client.load('room-registry')
    if (loaded.status !== 'loaded') throw new Error('room registry was not loaded')
    await left.client.replace({
      contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
      documentId: 'room-registry',
      expectedRevision: loaded.snapshot.revision,
      schemaVersion: 2,
      value: { operationId: 'send-stable-1', state: 'committed' },
    })
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(observed.at(-1)).toBe('2:committed')
    unsubscribe()

    await left.dom.window.__cordisxRuntime?.dispose()
    left.dom.window.close()
    const replacementBundle = await buildRendererBundle({
      ...config,
      plugins: [{ ...config.plugins[0]!, config: { pluginRevision: 2 } }],
    }, {
      profileId: 'work',
      generation: generation = 'owner-documents-generation-2',
      ownerDocumentAuthority: authority(),
    })
    handler = handlerFor(generation)
    right.dom.window.eval(replacementBundle)
    await (right.dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    const replacement =
      (right.dom.window as unknown as { __cordisxOwnerDocumentsFixture?: { client: CordisXOwnerDocumentsV1 } })
        .__cordisxOwnerDocumentsFixture?.client
    await expect(replacement?.load('room-registry')).resolves.toMatchObject({
      status: 'loaded',
      snapshot: { revision: 2, schemaVersion: 2, value: { operationId: 'send-stable-1', state: 'committed' } },
    })
    const disabledBundle = await buildRendererBundle({
      ...config,
      plugins: [{ ...config.plugins[0]!, enabled: false }],
    }, {
      profileId: 'work',
      generation: generation = 'owner-documents-generation-3',
      ownerDocumentAuthority: authority(),
    })
    handler = handlerFor(generation)
    right.dom.window.eval(disabledBundle)
    await (right.dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    expect((right.dom.window as unknown as { __cordisxOwnerDocumentsFixture?: unknown }).__cordisxOwnerDocumentsFixture)
      .toBeUndefined()
    const uninstalledBundle = await buildRendererBundle({ ...config, plugins: [] }, {
      profileId: 'work',
      generation: generation = 'owner-documents-generation-4',
      ownerDocumentAuthority: authority(),
    })
    handler = handlerFor(generation)
    right.dom.window.eval(uninstalledBundle)
    await (right.dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    expect((right.dom.window as unknown as { __cordisxOwnerDocumentsFixture?: unknown }).__cordisxOwnerDocumentsFixture)
      .toBeUndefined()
    const reenabledBundle = await buildRendererBundle({
      ...config,
      plugins: [{ ...config.plugins[0]!, config: { pluginRevision: 3 } }],
    }, {
      profileId: 'work',
      generation: generation = 'owner-documents-generation-5',
      ownerDocumentAuthority: authority(),
    })
    handler = handlerFor(generation)
    right.dom.window.eval(reenabledBundle)
    await (right.dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    const reenabled =
      (right.dom.window as unknown as { __cordisxOwnerDocumentsFixture?: { client: CordisXOwnerDocumentsV1 } })
        .__cordisxOwnerDocumentsFixture?.client
    await expect(reenabled?.load('room-registry')).resolves.toMatchObject({
      status: 'loaded',
      snapshot: { revision: 2, schemaVersion: 2, value: { operationId: 'send-stable-1', state: 'committed' } },
    })
    await right.dom.window.__cordisxRuntime?.dispose()
    right.dom.window.close()
  }, 30_000)
})
