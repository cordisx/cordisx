import { createInterface } from 'node:readline'

const root = process.env.CORDISX_PROJECT_FIXTURE_ROOT
let membership
let thread = {
  id: 'seed',
  status: { type: 'idle' },
  modelProvider: 'openai',
  model: 'fixture-model',
  cwd: root,
  serviceTier: null,
  sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
}
const requests = []
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), params = message.params ?? {}
  if (message.method === 'initialized' || !message.method) return
  let result = {}
  if (message.method === 'mcpServer/tool/call') {
    requests.push({ method: message.method, params })
    const value = params.tool === 'list_projects'
      ? { projects: [{ projectId: 'repo', label: 'Repository', projectKind: 'local', hostId: 'local', path: root }] }
      : params.tool === 'list_threads'
      ? { threads: [{ id: thread.id, hostId: 'local', projectId: membership }] }
      : { status: 'moved' }
    if (params.tool === 'move_thread_to_project') membership = params.arguments.projectId
    result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
  } else if (message.method === 'thread/list') result = { data: [{ id: thread.id }] }
  else if (message.method === 'thread/read') result = { thread: { ...thread }, requests }
  else if (message.method === 'thread/start') {
    requests.push({ method: message.method, params })
    thread = {
      ...thread,
      id: 'project-chat',
      cwd: params.cwd,
      serviceTier: params.serviceTier,
      sandbox: {
        type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite',
        writableRoots: params.config?.['sandbox_workspace_write.writable_roots'] ?? [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }
    result = { ...thread, thread: { ...thread } }
  } else if (message.method === 'thread/settings/update') {
    requests.push({ method: message.method, params })
    thread = { ...thread, ...params, ...(params.sandboxPolicy ? { sandbox: params.sandboxPolicy } : {}) }
    emit({
      method: 'thread/settings/updated',
      params: { threadId: thread.id, threadSettings: { ...thread, sandboxPolicy: thread.sandbox } },
    })
  } else if (message.method === 'turn/start') {
    requests.push({ method: message.method, params })
    result = { turn: { id: 'project-turn' } }
  }
  emit({ id: message.id, result })
})
