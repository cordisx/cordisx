import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createPlaygroundSession, type PlaygroundFixtureInfo } from './session.js'

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

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.byteLength
    if (size > 1_048_576) throw new Error('request is too large')
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function page(fixture: PlaygroundFixtureInfo): string {
  return `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CordisX UI Playground</title><style>
*{box-sizing:border-box}body{margin:0;background:#11161d;color:#e8edf4;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.pg-shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}.pg-sidebar{padding:18px 12px;border-right:1px solid #2c3440;background:#171d25}.pg-sidebar h1{margin:0 0 4px;font-size:15px}.pg-sidebar p{margin:0 0 18px;color:#aab5c2;font-size:12px}.pg-seat{padding:8px;margin:7px 0;border:1px dashed #455264;border-radius:8px;color:#b7c2cf;background:#1b222c;font-size:12px}.pg-seat button{font:inherit}.pg-fixture{display:grid;gap:5px;margin:12px 0;padding:10px;border:1px solid #2c3440;border-radius:8px;background:#1b222c;font-size:12px}.pg-fixture strong{font-size:12px}.pg-fixture small{color:#aab5c2}.pg-plugin-list{display:flex;flex-wrap:wrap;gap:5px}.pg-plugin{padding:2px 6px;border:1px solid #455264;border-radius:999px;color:#c6d1de;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}.pg-main{padding:18px;min-width:0}.pg-toolbar{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #2c3440;border-radius:10px;background:#171d25}.pg-toolbar button{border:1px solid #526173;border-radius:7px;background:#242d39;color:inherit;padding:6px 10px;font:inherit;cursor:pointer}.pg-status{color:#aab5c2;font-size:12px}.pg-stage{position:relative;min-height:640px;margin-top:14px;border:1px solid #2c3440;border-radius:12px;background:#141a22;overflow:hidden}.pg-main-seat,.pg-app-seat,.pg-session-seat{min-height:180px;padding:18px;border-bottom:1px solid #2c3440}.pg-hint{margin:0;color:#aab5c2}.pg-unavailable{margin:12px 0;padding:10px 12px;border-inline-start:3px solid #6b7c90;color:#b9c4d0;background:#1a222d;font-size:12px}html[data-theme=light] body{background:#edf1f6;color:#172131}html[data-theme=light] .pg-sidebar,html[data-theme=light] .pg-toolbar{background:#fff;border-color:#cad3de}html[data-theme=light] .pg-stage{background:#f8fafc;border-color:#cad3de}html[data-theme=light] .pg-seat,html[data-theme=light] .pg-fixture{background:#f5f8fb;border-color:#aebdcd;color:#425166}html[data-theme=light] .pg-toolbar button{background:#fff;color:#172131;border-color:#9dabbc}html[data-theme=light] .pg-main-seat,html[data-theme=light] .pg-app-seat,html[data-theme=light] .pg-session-seat{border-color:#d7dfe8}html[data-theme=light] .pg-plugin{border-color:#aebdcd;color:#425166}@media(max-width:720px){.pg-shell{grid-template-columns:1fr}.pg-sidebar{border-right:0;border-bottom:1px solid #2c3440}.pg-stage{min-height:520px}}</style></head><body><div class="pg-shell"><aside class="pg-sidebar"><h1>CordisX UI Playground</h1><p>本地 Host 模拟席位，不连接 Codex。</p><div class="pg-fixture"><strong data-pg-fixture-name>${escapeHtml(fixture.name)}</strong><small>Fixture · ${escapeHtml(fixture.source)}</small><small>使用 <code>npm run dev:ui -- --config /path/to/cordisx.config.json</code> 切换组合。</small><span data-pg-plugin-count>正在读取激活插件…</span><div class="pg-plugin-list" data-pg-plugin-list></div></div><div class="pg-seat">Manager<br><button type="button" data-cordisx-playground-manager-trigger>打开插件 Manager</button></div><div class="pg-seat">Host-only capability<br><span data-pg-capability>unavailable · no Codex connection</span></div><div class="pg-unavailable">这里的标准席位用于预览。Codex native anchor、真实会话与当前连接均不挂载。</div></aside><main class="pg-main"><div class="pg-toolbar"><strong>独立 Cordis runtime</strong><span class="pg-status" data-pg-status>starting…</span><span><button type="button" data-pg-theme>亮/暗</button><button type="button" data-pg-locale>中文/EN</button><button type="button" data-pg-reload>重载插件</button><button type="button" data-pg-reset>重置 fixture</button></span></div><section class="pg-stage"><div class="pg-app-seat" data-cordisx-playground-seat="app"><p class="pg-hint">App content seat</p></div><div class="pg-main-seat" data-cordisx-playground-seat="main"><p class="pg-hint">Main content seat</p></div><div class="pg-session-seat" data-cordisx-playground-seat="session.content"><p class="pg-hint">Session content seat (fixture only)</p></div></section></main></div><script>
const status=document.querySelector('[data-pg-status]'),pluginCount=document.querySelector('[data-pg-plugin-count]'),pluginList=document.querySelector('[data-pg-plugin-list]');let revision=0;
window.__cordisxConfigRequestV1=(payload)=>fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:payload}).then(r=>r.text()).then(value=>window.__cordisxConfigReceiveV1?.(value)).catch(error=>window.__cordisxConfigReceiveV1?.(JSON.stringify({requestId:JSON.parse(payload).requestId,ok:false,error:String(error)})));
window.__cordisxServiceConfigRequestV1=(payload)=>fetch('/api/service-config',{method:'POST',headers:{'content-type':'application/json'},body:payload}).then(r=>r.text()).then(value=>window.__cordisxServiceConfigReceiveV1?.(value)).catch(error=>window.__cordisxServiceConfigReceiveV1?.(JSON.stringify({requestId:JSON.parse(payload).requestId,ok:false,error:String(error)})));
window.__cordisxChannelCredentialRequestV1=(payload)=>fetch('/api/channel-credential',{method:'POST',headers:{'content-type':'application/json'},body:payload}).then(r=>r.text()).then(value=>window.__cordisxChannelCredentialReceiveV1?.(value)).catch(error=>window.__cordisxChannelCredentialReceiveV1?.(JSON.stringify({requestId:JSON.parse(payload).requestId,ok:false,error:String(error)})));
function renderSnapshot(snapshot){const plugins=snapshot?.plugins||[],active=plugins.filter(plugin=>plugin.status==='active');pluginCount.textContent=active.length+' / '+plugins.length+' 个插件已激活';pluginList.replaceChildren(...plugins.map(plugin=>{const item=document.createElement('span');item.className='pg-plugin';item.textContent=plugin.id+' · '+plugin.status;return item}))}
async function boot(reason){status.textContent='building '+reason+'…';const source=await fetch('/api/bundle?revision='+revision,{cache:'no-store'}).then(r=>r.text());(0,eval)(source);for(let i=0;i<100&&document.documentElement.dataset.cordisxReady!=='true';i++)await new Promise(r=>setTimeout(r,20));const runtime=window.__cordisxRuntime;renderSnapshot(runtime?.snapshot?.());status.textContent=runtime?'active · generation '+revision:'boot failed'}
document.querySelector('[data-pg-theme]').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'};
document.querySelector('[data-pg-locale]').onclick=()=>{document.documentElement.lang=document.documentElement.lang==='zh-CN'?'en':'zh-CN';document.documentElement.dir='ltr';window.__cordisxRuntime?.snapshot?.()};
document.querySelector('[data-pg-reload]').onclick=async()=>{revision++;await boot('reload')};
document.querySelector('[data-pg-reset]').onclick=async()=>{await fetch('/api/reset',{method:'POST'});localStorage.clear();revision++;await boot('reset')};
boot('initial');</script></body></html>`
}

/** Production-bundle Playground retained for renderer parity tests. */
export async function startUiPlayground(options: UiPlaygroundOptions): Promise<UiPlaygroundHandle> {
  const session = await createPlaygroundSession(options.configPath)
  let activeSource: string | undefined
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(page(session.fixture))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/bundle') {
        activeSource = (await session.buildBundle()).source
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        response.end(activeSource)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        json(response, 200, await session.handleConfigRequest(await body(request)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/service-config') {
        json(response, 200, await session.handleServiceConfigRequest(await body(request)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/channel-credential') {
        json(response, 200, await session.handleChannelCredentialRequest(await body(request)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        await session.reset()
        activeSource = undefined
        json(response, 200, { ok: true })
        return
      }
      json(response, 404, { error: 'not found' })
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Playground server did not expose a TCP address')
  return {
    url: `http://${host}:${address.port}/`,
    homeDir: session.homeDir,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      await session.close()
    },
  }
}
