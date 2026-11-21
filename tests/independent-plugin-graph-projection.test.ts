import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fixture, projection, target } from './fixtures/independent-plugin-graph.js'
import {
  createSessionPluginGraphProjection,
  MAX_SESSION_PLUGIN_GRAPH_GENERATIONS,
} from '../packages/cli/src/independent-manager/plugin-graph-projection.js'
import {
  MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES,
  type PluginGenerationGraphLease,
} from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'

afterEach(cleanup)

describe('independent renderer plugin graph projection', () => {
  it('projects verified JS, relative lazy imports, CSS and images into distinct non-cacheable sessions', async () => {
    const input = await fixture()
    const first = projection(input.server)
    const second = projection(input.server)
    const graph = first.project(input.lease, () => true)
    const otherGraph = second.project(input.lease, () => true)
    expect(first.project(input.lease, () => true)).toBe(graph)
    expect(otherGraph.baseUrl).not.toBe(graph.baseUrl)
    expect(graph.importSource).toContain(graph.entryUrl)
    expect(graph.importSource).toContain(graph.initialStyleUrls[0])
    expect(graph.importSource).not.toContain(input.lease.baseUrl)
    expect(graph.publishSource).toBe(input.lease.publishSource)
    expect(graph.retireSource).toBe(input.lease.retireSource)

    const expected = [
      [graph.entryUrl, input.module, 'text/javascript'],
      [new URL('./chunks/lazy.js', graph.entryUrl).href, input.chunk, 'text/javascript'],
      [graph.initialStyleUrls[0]!, input.style, 'text/css'],
      [new URL('./pixel.svg', graph.initialStyleUrls[0]).href, input.image, 'image/svg+xml'],
    ] as const
    for (const [url, value, media] of expected) {
      const response = await first.resolve({ method: 'GET', target: target(url) })
      expect(response.status).toBe(200)
      expect(new TextDecoder().decode(response.body)).toBe(value)
      expect(response.headers).toMatchObject({
        'content-type': media,
        'cache-control': 'private, no-store, max-age=0',
        'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      })
      expect(response.headers).not.toHaveProperty('etag')
      expect((await second.resolve({ method: 'GET', target: target(url) })).status).toBe(404)
    }
    const head = await first.resolve({ method: 'HEAD', target: target(graph.entryUrl) })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(input.module)))
    expect(head.body).toBeUndefined()
  })

  it('rejects path normalization, encoded traversal, absolute URLs, unknown files and methods before proxying', async () => {
    const input = await fixture()
    const session = projection(input.server)
    const graph = session.project(input.lease, () => true)
    const base = target(graph.baseUrl)
    const cases = [
      `${base}../module.js`,
      `${base}a/../module.js`,
      `${base}%2e%2e/module.js`,
      `${base}%252e%252e/module.js`,
      `${base}a%2fmodule.js`,
      `${base}a\\module.js`,
      `${base}//module.js`,
      `${base}module.js?x=1`,
      `${base}module.js#x`,
      `${base}.hidden.js`,
      `${base}module.json`,
      graph.entryUrl,
      '//example.com/module.js',
    ]
    for (const candidate of cases) {
      expect((await session.resolve({ method: 'GET', target: candidate })).status, candidate).toBe(404)
    }
    expect((await session.resolve({ method: 'POST', target: target(graph.entryUrl) })).status).toBe(405)
    expect(input.server.requestTrace()).toEqual([])
  })

  it('rejects addresses outside the configured artifact server and invalid lease source layouts', async () => {
    const input = await fixture()
    const session = projection(input.server)
    expect(() =>
      session.project({
        ...input.lease,
        baseUrl: input.lease.baseUrl.replace(input.server.origin, 'http://127.0.0.1:1'),
      }, () => true)
    ).toThrow('plugin-graph-lease-invalid')
    expect(() =>
      session.project({
        ...input.lease,
        entryUrl: `${input.lease.baseUrl}%2e%2e/module.js`,
      }, () => true)
    ).toThrow('plugin-graph-lease-invalid')
    expect(() =>
      session.project({
        ...input.lease,
        importSource: 'not a valid lease expression',
      }, () => true)
    ).toThrow('plugin-graph-lease-invalid')
    expect(() =>
      createSessionPluginGraphProjection({
        managerOrigin: 'http://example.com:8000',
        artifactServer: input.server,
      })
    ).toThrow('plugin-graph-origin-invalid')
    expect(input.server.requestTrace()).toEqual([])
  })

  it('does not follow redirects or accept incorrect MIME and unbounded bodies', async () => {
    const input = await fixture()
    const responders = [
      () => new Response(null, { status: 302, headers: { location: 'http://example.com/' } }),
      () => new Response('bad', { headers: { 'content-type': 'text/html', 'content-length': '3' } }),
      () => new Response('bad', { headers: { 'content-type': 'text/javascript' } }),
      () =>
        new Response('bad', {
          headers: {
            'content-type': 'text/javascript',
            'content-length': String(MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES + 1),
          },
        }),
      () => new Response('bad', { headers: { 'content-type': 'text/javascript', 'content-length': '1' } }),
    ]
    for (const responder of responders) {
      const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
        expect(options?.redirect).toBe('error')
        expect(options?.credentials).toBe('omit')
        return responder()
      }) as typeof fetch
      const session = projection(input.server, fetcher)
      const graph = session.project(input.lease, () => true)
      const response = await session.resolve({ method: 'GET', target: target(graph.entryUrl) })
      expect(response.status).toBe(404)
      expect(response.headers).not.toHaveProperty('location')
      expect(fetcher).toHaveBeenCalledOnce()
    }
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
      },
    })
    const fetcher = vi.fn(async () =>
      new Response(stream, {
        headers: { 'content-type': 'text/html', 'content-length': '100' },
      })
    ) as typeof fetch
    const session = projection(input.server, fetcher)
    const graph = session.project(input.lease, () => true)
    expect((await session.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    expect(cancelled).toBe(true)
  })

  it('revokes one projection without retiring a shared lease, and rejects closed or stale sessions', async () => {
    const input = await fixture()
    const first = projection(input.server)
    const second = projection(input.server)
    let current = true
    const graph = first.project(input.lease, () => current)
    const other = second.project(input.lease, () => true)
    current = false
    expect((await first.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    current = true
    expect((await first.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    expect(() => first.project(input.lease, () => true)).toThrow('plugin-graph-lease-stale')
    graph.retire()
    expect((await first.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    expect((await second.resolve({ method: 'GET', target: target(other.entryUrl) })).status).toBe(200)
    second.close()
    expect((await second.resolve({ method: 'GET', target: target(other.entryUrl) })).status).toBe(404)
    expect(() => second.project(input.lease, () => true)).toThrow('plugin-graph-session-closed')
  })

  it('bounds active graphs and retired generation tombstones together', async () => {
    const input = await fixture()
    const session = projection(input.server)
    const generatedLease = (number: number): PluginGenerationGraphLease => {
      const id = number.toString(16).padStart(64, '0')
      const change = (value: string) => value.replaceAll(input.lease.leaseId, id)
      return {
        ...input.lease,
        leaseId: id,
        baseUrl: change(input.lease.baseUrl),
        entryUrl: change(input.lease.entryUrl),
        initialStyleUrls: input.lease.initialStyleUrls.map(change),
        importSource: change(input.lease.importSource),
      }
    }
    for (let number = 0; number < MAX_SESSION_PLUGIN_GRAPH_GENERATIONS; number++) {
      // This tests bookkeeping only: no fabricated lease is ever fetched.
      const graph = session.project(generatedLease(number), () => true)
      if (number % 2 === 0) graph.retire()
    }
    expect(() => session.project(generatedLease(MAX_SESSION_PLUGIN_GRAPH_GENERATIONS), () => true))
      .toThrow('plugin-graph-session-limit')
    expect(input.server.requestTrace()).toEqual([])
  })

  it('aborts an in-flight fetch and never returns bytes after the session is revoked', async () => {
    const input = await fixture()
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => release = resolve)
    const began = new Promise<void>(resolve => started = resolve)
    let signal: AbortSignal | null | undefined
    const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      signal = options?.signal
      started()
      await waiting // Deliberately ignore cancellation as an adversarial transport.
      return new Response('data', { headers: { 'content-type': 'text/javascript', 'content-length': '4' } })
    }) as typeof fetch
    const session = projection(input.server, fetcher)
    const graph = session.project(input.lease, () => true)
    const pending = session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    await began
    graph.retire()
    expect(signal?.aborted).toBe(true)
    release()
    expect((await pending).status).toBe(404)
  })

  it('honors the artifact server integrity check after a verified file changes', async () => {
    const input = await fixture()
    const session = projection(input.server)
    const graph = session.project(input.lease, () => true)
    await writeFile(path.join(input.directory, 'module.js'), 'export const modified = true\n')
    const result = await session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    expect(result.status).toBe(404)
    expect(result.body).toBeUndefined()
    expect(input.server.requestTrace().at(-1)?.status).toBe(409)
  })

  it('discards a partially read body if the owner revokes the generation', async () => {
    const input = await fixture()
    let continueStream!: () => void
    let firstChunk!: () => void
    const firstRead = new Promise<void>(resolve => firstChunk = resolve)
    const resume = new Promise<void>(resolve => continueStream = resolve)
    const fetcher = vi.fn(async () => {
      let chunk = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (chunk++ === 0) {
            controller.enqueue(new TextEncoder().encode('aa'))
            firstChunk()
          } else {
            await resume
            controller.enqueue(new TextEncoder().encode('bb'))
            controller.close()
          }
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/javascript', 'content-length': '4' } })
    }) as typeof fetch
    const session = projection(input.server, fetcher)
    let current = true
    const graph = session.project(input.lease, () => current)
    const pending = session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    await firstRead
    current = false
    continueStream()
    const result = await pending
    expect(result.status).toBe(404)
    expect(result.body).toBeUndefined()
  })

  it('actively cancels a blocked response reader on projection retirement', async () => {
    const input = await fixture()
    let readingNext!: () => void
    let cancelled!: () => void
    const blocked = new Promise<void>(resolve => readingNext = resolve)
    const didCancel = new Promise<void>(resolve => cancelled = resolve)
    const fetcher = vi.fn(async () => {
      let chunk = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (chunk++ === 0) controller.enqueue(new TextEncoder().encode('aa'))
            else {
              readingNext()
              await new Promise<void>(() => undefined)
            }
          },
          cancel() {
            cancelled()
          },
        }),
        { headers: { 'content-type': 'text/javascript', 'content-length': '4' } },
      )
    }) as typeof fetch
    const session = projection(input.server, fetcher)
    const graph = session.project(input.lease, () => true)
    const pending = session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    await blocked
    graph.retire()
    await didCancel
    expect((await pending).status).toBe(404)
  })
})
