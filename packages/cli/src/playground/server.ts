import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRendererBundle } from '../launcher/bundle.js'
import { loadConfig, type CordisXConfig } from '../launcher/config.js'
import { configBridgeError, createConfigBridgeHandler, parseConfigBindingRequest, type ConfigBridgeHandler } from '../launcher/config-rpc.js'

export interface UiPlaygroundOptions {
  readonly configPath: string
  readonly port?: number
  readonly host?: '127.0.0.1' | '::1'
}

export interface UiPlaygroundHandle {
  readonly url: string
  readonly homeDir: string
  close(): Promise<void>
}

interface RuntimeState {
  readonly generation: string
  readonly bridge: ConfigBridgeHandler
  readonly source: string
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (Buffer.concat(chunks).byteLength > 1_048_576) throw new Error('request is too large')
  }
  return Buffer.concat(chunks).toString('utf8')
}

function page(): string {
  return `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CordisX UI Playground</title><style>
*{box-sizing:border-box}body{margin:0;background:#11161d;color:#e8edf4;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.pg-shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}.pg-sidebar{padding:18px 12px;border-right:1px solid #2c3440;background:#171d25}.pg-sidebar h1{margin:0 0 4px;font-size:15px}.pg-sidebar p{margin:0 0 18px;color:#aab5c2;font-size:12px}.pg-seat{padding:8px;margin:7px 0;border:1px dashed #455264;border-radius:8px;color:#b7c2cf;background:#1b222c;font-size:12px}.pg-seat button{font:inherit}.pg-main{padding:18px;min-width:0}.pg-toolbar{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #2c3440;border-radius:10px;background:#171d25}.pg-toolbar button{border:1px solid #526173;border-radius:7px;background:#242d39;color:inherit;padding:6px 10px;font:inherit;cursor:pointer}.pg-status{color:#aab5c2;font-size:12px}.pg-stage{position:relative;min-height:640px;margin-top:14px;border:1px solid #2c3440;border-radius:12px;background:#141a22;overflow:hidden}.pg-main-seat,.pg-app-seat,.pg-session-seat{min-height:180px;padding:18px;border-bottom:1px solid #2c3440}.pg-hint{margin:0;color:#aab5c2}.pg-unavailable{margin:12px 0;padding:10px 12px;border-inline-start:3px solid #6b7c90;color:#b9c4d0;background:#1a222d;font-size:12px}html[data-theme=light] body{background:#edf1f6;color:#172131}html[data-theme=light] .pg-sidebar,html[data-theme=light] .pg-toolbar{background:#fff;border-color:#cad3de}html[data-theme=light] .pg-stage{background:#f8fafc;border-color:#cad3de}html[data-theme=light] .pg-seat{background:#f5f8fb;border-color:#aebdcd;color:#425166}html[data-theme=light] .pg-toolbar button{background:#fff;color:#172131;border-color:#9dabbc}html[data-theme=light] .pg-main-seat,html[data-theme=light] .pg-app-seat,html[data-theme=light] .pg-session-seat{border-color:#d7dfe8}@media(max-width:720px){.pg-shell{grid-template-columns:1fr}.pg-sidebar{border-right:0;border-bottom:1px solid #2c3440}.pg-stage{min-height:520px}}</style></head><body><div class="pg-shell"><aside class="pg-sidebar"><h1>CordisX UI Playground</h1><p>本地 Host 模拟席位，不连接 Codex。</p><div class="pg-seat">Manager<br><button type="button" data-cordisx-playground-manager-trigger>打开插件 Manager</button></div><div class="pg-seat">Host-only capability<br><span data-pg-capability>unavailable · no Codex connection</span></div><div class="pg-unavailable">这里的标准席位用于预览。Codex native anchor、真实会话与当前连接均不挂载。</div></aside><main class="pg-main"><div class="pg-toolbar"><strong>独立 Cordis runtime</strong><span class="pg-status" data-pg-status>starting…</span><span><button type="button" data-pg-theme>亮/暗</button><button type="button" data-pg-locale>中文/EN</button><button type="button" data-pg-reload>重载插件</button><button type="button" data-pg-reset>重置 fixture</button></span></div><section class="pg-stage"><div class="pg-app-seat" data-cordisx-playground-seat="app"><p class="pg-hint">App content seat</p></div><div class="pg-main-seat" data-cordisx-playground-seat="main"><p class="pg-hint">Main content seat</p></div><div class="pg-session-seat" data-cordisx-playground-seat="session.content"><p class="pg-hint">Session content seat (fixture only)</p></div></section></main></div><script>
const status=document.querySelector('[data-pg-status]');let revision=0;
window.__cordisxConfigRequestV1=(payload)=>fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:payload}).then(r=>r.text()).then(value=>window.__cordisxConfigReceiveV1?.(value)).catch(error=>window.__cordisxConfigReceiveV1?.(JSON.stringify({requestId:JSON.parse(payload).requestId,ok:false,error:String(error)})));
async function boot(reason){status.textContent='building '+reason+'…';const source=await fetch('/api/bundle?revision='+revision,{cache:'no-store'}).then(r=>r.text());(0,eval)(source);for(let i=0;i<100&&document.documentElement.dataset.cordisxReady!=='true';i++)await new Promise(r=>setTimeout(r,20));const runtime=window.__cordisxRuntime;const snapshot=runtime?.snapshot?.();status.textContent=runtime?'active · generation '+revision+' · '+(snapshot?.plugins?.map(p=>p.id).join(', ')||'no plugins'):'boot failed'}
document.querySelector('[data-pg-theme]').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'};
document.querySelector('[data-pg-locale]').onclick=()=>{document.documentElement.lang=document.documentElement.lang==='zh-CN'?'en':'zh-CN';document.documentElement.dir='ltr';window.__cordisxRuntime?.snapshot?.();};
document.querySelector('[data-pg-reload]').onclick=async()=>{revision++;await boot('reload')};
document.querySelector('[data-pg-reset]').onclick=async()=>{await fetch('/api/reset',{method:'POST'});localStorage.clear();revision++;await boot('reset')};
boot('initial');</script></body></html>`
}

/** Starts a browser-only local Playground. All writable files live below a fresh temporary CORDISX_HOME. */
export async function startUiPlayground(options: UiPlaygroundOptions): Promise<UiPlaygroundHandle> {
  const sourcePath = path.resolve(options.configPath)
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as { version?: unknown; plugins?: unknown }
  if (source.version !== 1 || !Array.isArray(source.plugins)) throw new Error('Playground config must be a CordisX version-1 composition')
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-ui-playground-'))
  const stateRoot = path.join(homeDir, 'state')
  const configPath = path.join(homeDir, 'config', 'playground.config.json')
  const rootDir = path.dirname(sourcePath)
  const materialized = {
    ...source,
    plugins: source.plugins.map((item: unknown) => {
      const plugin = item as Record<string, unknown>
      return { ...plugin, entry: typeof plugin.entry === 'string' ? path.resolve(rootDir, plugin.entry) : plugin.entry }
    }),
  }
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  await mkdir(path.join(homeDir, 'cache'), { recursive: true, mode: 0o700 })
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await writeFile(configPath, `${JSON.stringify(materialized, null, 2)}\n`, { mode: 0o600 })
  let state: RuntimeState | undefined
  const rebuild = async (): Promise<RuntimeState> => {
    const generation = `playground-${randomBytes(12).toString('hex')}`
    const token = randomBytes(32).toString('hex')
    const config = await loadConfig(configPath, { profileId: 'playground' })
    const bridge = createConfigBridgeHandler({ token, profileId: 'playground', generation, configPath, composition: config })
    const bundle = await buildRendererBundle(config, { playground: true, generation, configBridgeToken: token, profileId: 'playground' })
    return { generation, bridge, source: bundle }
  }
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(page()); return
      }
      if (request.method === 'GET' && url.pathname === '/api/bundle') {
        state = await rebuild(); response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); response.end(state.source); return
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        if (state === undefined) throw new Error('Playground has no active generation')
        const raw = await body(request)
        const parsed = parseConfigBindingRequest(JSON.parse(raw), state.bridge.token, state.bridge.profileId, state.generation)
        try { json(response, 200, { requestId: parsed.requestId, ok: true, value: await state.bridge.handle(parsed) }) }
        catch (error) { json(response, 200, { requestId: parsed.requestId, ok: false, ...configBridgeError(error) }) }
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        await writeFile(configPath, `${JSON.stringify(materialized, null, 2)}\n`, { mode: 0o600 }); await rm(stateRoot, { recursive: true, force: true }); await mkdir(stateRoot, { recursive: true, mode: 0o700 }); state = undefined; json(response, 200, { ok: true }); return
      }
      json(response, 404, { error: 'not found' })
    } catch (error) { json(response, 500, { error: error instanceof Error ? error.message : String(error) }) }
  })
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, () => { server.off('error', reject); resolve() }) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Playground server did not expose a TCP address')
  return { url: `http://${host}:${address.port}/`, homeDir, async close() { await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))); await rm(homeDir, { recursive: true, force: true }) } }
}
