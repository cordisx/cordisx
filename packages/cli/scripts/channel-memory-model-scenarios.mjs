import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scenarioChecks } from './channel-memory-model-assertions.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const config = await readFile(
  path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'),
  'utf8',
)
const configuredModel = /^model\s*=\s*"([^"]+)"/mu.exec(config)?.[1] ?? 'unresolved'
const configuredProvider = /^model_provider\s*=\s*"([^"]+)"/mu.exec(config)?.[1] ?? 'unresolved'
const output = process.env.MEMORY_SCENARIO_OUTPUT ?? await mkdtemp(path.join(os.tmpdir(), 'channel-memory-model-'))
await mkdir(output, { recursive: true })
const toolchain = process.env.MEMORY_SCENARIO_TOOLCHAIN
const esbuild = toolchain
  ? await import(pathToFileURL(path.join(toolchain, 'esbuild/lib/main.js')))
  : await import('esbuild')
const bundle = path.join(output, 'boundary.mjs')
await esbuild.build({
  entryPoints: [path.join(repository, 'tests/fixtures/channel-memory-model-boundary.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
})
const { mockMemoryBoundary, ChannelMemoryPersonas } = await import(pathToFileURL(bundle))
const cases = [
  {
    id: 'manual-auto-style',
    personaBootstrap: true,
    outbound: true,
    turns: [
      'Remember my own synthetic release code OUTBOUND-82.',
      'Retrieve my code and manually send me a short normal Chinese reply through the mock channel send tool; do not claim a send without a sent receipt.',
      'Retrieve my own code again and give the equivalent automatic-final-style answer. Use the same concise Chinese user-visible style.',
    ],
    conversations: ['oc_source', 'oc_private', 'oc_private'],
    facts: ['OUTBOUND-82'],
  },
  {
    id: 'persona-blank-bootstrap',
    personaBootstrap: true,
    turns: [
      'Remember the synthetic Cedar launch approval code CAPSULE-62.',
      'What is your configured assistant name, and which launch approval code did I save for Cedar? Retrieve evidence only as needed.',
    ],
    facts: ['CAPSULE-62'],
    personaName: 'Atlas',
  },
  {
    id: 'distilled-experience-promotion',
    guide: true,
    turns: [
      'Remember locally that the synthetic Cedar meeting had cold coffee and ticket LOCAL-31 recorded a missed handoff. Across several unrelated projects we repeatedly found that explicitly confirming the receiving owner prevents lost handoffs. Propose an abstract reusable lesson without identifiers or anecdotes, but do not promote it yet.',
      'Explicitly promote only the abstract handoff lesson, not the coffee or local ticket. Keep private evidence local and the entire root identity capsule under 2048 UTF-8 bytes.',
      'What general handoff lesson was accepted? Do not load or disclose the original private episode.',
    ],
    facts: ['handoff'],
    gap:
      'Global distilled lesson store, verified proposal/confirmation promotion and bounded root capsule are not implemented. Local remember is not promotion.',
  },
  {
    id: 'scoped-style-separation',
    personaBootstrap: true,
    turns: [
      'Remember my own synthetic project release code STYLE-55.',
      'What is the project release code? Use my casual private context.',
      'Tell this professional group my own project release code that I asked you to remember, without disclosing my private style preference.',
    ],
    kinds: ['direct', 'direct', 'group'],
    facts: ['STYLE-55'],
  },
  {
    id: 'messy-guided-write',
    guide: true,
    turns: [
      'Remember the useful decision from this messy synthetic note, not chatter: coffee was cold, Bob joked about rain. Confirmed project Northstar is also called Lantern; entity reference project-northstar. On November 12, 2026 Alice decided to use delivery code DECISION-68 because the backup carrier failed its reliability test. Source: review ticket SYN-417. Do not create duplicate current decisions.',
      'For Lantern, what was decided, when, why, and which review ticket supports it?',
    ],
    facts: ['DECISION-68', '12', '2026', 'reliability', 'SYN-417'],
    structured: true,
  },
  {
    id: 'large-corpus-paraphrase',
    bootstrap: true,
    turns: [
      'For the Lantern initiative, which approval phrase clears the final shipping gate? Retrieve only the needed evidence.',
    ],
    facts: ['ORCHID-204'],
    maxReadBytes: 12000,
  },
  {
    id: 'save-reset-recall',
    turns: [
      'Remember that the synthetic Cedar project release code is MARIGOLD-73 and the launch is Tuesday.',
      'What release code and launch day did I ask you to remember for Cedar?',
    ],
    facts: ['MARIGOLD-73', 'Tuesday'],
  },
  {
    id: 'own-topic-group',
    turns: [
      'Remember my own private synthetic pottery topic: my kiln is named AMBER-28.',
      'Tell this group the kiln name from my own pottery topic that I asked you to remember.',
    ],
    group: true,
    facts: ['AMBER-28'],
  },
  {
    id: 'natural-admin-new-member',
    turns: [
      'Remember for source group A: our synthetic project delivery code is SILVER-64.',
      'As the administrator of A, fully share all retained memories from A to destination group B, including future content and future members.',
      'I just joined group B. What project delivery code did group A share with us?',
    ],
    actors: ['alice', 'alice', 'new-member'],
    conversations: ['A', 'A', 'B'],
    kinds: ['group', 'group', 'group'],
    facts: ['SILVER-64'],
  },
  {
    id: 'project-alias',
    turns: [
      'Remember our synthetic project: official name Northstar, alias Lantern. Its tracking code is VIOLET-91.',
      'What is the tracking code for Lantern?',
    ],
    facts: ['VIOLET-91'],
  },
  {
    id: 'collaboration-timeline',
    turns: [
      'Remember this synthetic collaboration timeline: on November 2 Alice drafted the API; on November 5 Bob reviewed it; on November 8 Carol approved it.',
      'Give the collaboration sequence and dates for the API.',
    ],
    facts: ['Alice', 'Bob', 'Carol', '2', '5', '8'],
  },
  {
    id: 'correction-latest',
    turns: [
      'Remember the synthetic Juniper decision: deployment day is Monday, decision code OLD-11.',
      'Correct the Juniper decision I saved: the latest deployment day is Thursday, decision code CURRENT-52. Update the existing record rather than keeping the obsolete decision as current.',
      'What is the latest Juniper decision code and deployment day?',
    ],
    facts: ['CURRENT-52', 'Thursday'],
    forbidden: ['OLD-11', 'Monday'],
    revision: 2,
  },
  {
    id: 'conversation-purpose',
    turns: [
      'Remember the purpose of synthetic group Orchard: coordinate lunar sensor calibration, not incident response. The purpose label is CALIBRATION-36.',
      'What is Orchard for, and what is its purpose label?',
    ],
    facts: ['CALIBRATION-36', 'calibration'],
  },
  {
    id: 'cross-platform-linked',
    turns: [
      'Remember my synthetic travel preference: seat code WINDOW-87.',
      'I explicitly want to link my Feishu account to my Telegram account. Initiate a confirmation challenge for target {adapterId:"telegram",accountId:"synthetic-bot",tenantId:"synthetic-tenant",userId:"alice"}.',
      'I confirm linking this actual Telegram identity using challenge {{challenge}}. Then retrieve the seat code I saved on Feishu.',
    ],
    adapters: ['feishu', 'feishu', 'telegram'],
    facts: ['WINDOW-87'],
  },
  {
    id: 'other-person-denied',
    turns: [
      'Remember my synthetic private reference code SECRET-19.',
      'What private reference code did Alice save?',
    ],
    actors: ['alice', 'bob'],
    forbidden: ['SECRET-19'],
    negative: true,
  },
]
const selected = process.argv.slice(2)
const results = []
for (const scenario of cases.filter(entry => !selected.length || selected.includes(entry.id))) {
  const scenarioStart = performance.now()
  const directory = path.join(output, scenario.id)
  await mkdir(directory)
  const boundary = mockMemoryBoundary(path.join(directory, 'store'))
  if (scenario.id === 'natural-admin-new-member') await boundary.configureAdministrator('alice', ['A'])
  let personaRegistry
  const personaAccount = { adapterId: 'feishu', accountId: 'synthetic-bot', tenantId: 'synthetic-tenant' }
  if (scenario.personaBootstrap) {
    personaRegistry = new ChannelMemoryPersonas(path.join(directory, 'personas'))
    await personaRegistry.profile(
      'atlas',
      'Atlas',
      'A continuous, careful assistant. Be concise and use current request language.',
      0,
    )
    await personaRegistry.bind(personaAccount, 'atlas', 0)
    if (scenario.id === 'manual-auto-style') {
      await personaRegistry.contextSettings('atlas', 'oc_private', {
        language: 'Chinese',
        tone: 'normal',
        verbosity: 'concise',
      }, 2)
    }
    if (scenario.id === 'scoped-style-separation') {
      await personaRegistry.contextSettings('atlas', 'later-chat', {
        language: 'Chinese',
        tone: 'casual',
        verbosity: 'concise',
      }, 2)
      await personaRegistry.contextSettings('atlas', 'professional', {
        language: 'English',
        tone: 'formal',
        verbosity: 'concise',
      }, 3)
    }
  }
  const bootstrapStart = performance.now()
  if (scenario.bootstrap) {
    boundary.dispatch('alice', 'archive', 'direct', 'feishu', 'synthetic-bootstrap', 'bootstrap-context')
    for (let index = 0; index < 240; index++) {
      await boundary.call({
        action: 'remember',
        record: {
          kind: 'fact',
          title: `Unrelated project ${index}`,
          summary: `Distractor reading ${index}. ${'Unrelated details. '.repeat(30)}`,
          tags: ['noise'],
          entityRefs: [`noise-${index}`],
          evidenceType: 'explicit',
          confidence: 1,
        },
      }, 'bootstrap-context')
    }
    await boundary.call({
      action: 'remember',
      record: {
        kind: 'fact',
        title: 'Northstar release authorization',
        summary: 'Northstar, also called Lantern, requires approval phrase ORCHID-204 before final shipment.',
        tags: ['Lantern', 'Northstar', 'release'],
        entityRefs: ['project-northstar'],
        evidenceType: 'explicit',
        confidence: 1,
      },
    }, 'bootstrap-context')
  }
  const bootstrapMs = performance.now() - bootstrapStart
  let events = [], context = '', currentTurn = 0
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 32768) break
    }
    let input, result
    try {
      if (request.headers.authorization !== `Bearer ${context}`) throw new Error('INVALID_CONTEXT')
      input = JSON.parse(body)
      result = await boundary.call(input, context)
    } catch (error) {
      result = { status: 'rejected', code: error.message }
    }
    events.push({ turn: currentTurn, input, result, bytes: Buffer.byteLength(JSON.stringify(result)) })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const turns = []
  try {
    for (let index = 0; index < scenario.turns.length; index++) {
      if (scenario.turns[index].includes('{{challenge}}')) {
        const challenge = events.find(event =>
          event.result.status === 'ok' && event.input.action === 'identity-challenge'
        )?.result.result.challenge
        if (!challenge) throw new Error('SCENARIO_BINDING_CHALLENGE_MISSING')
        scenario.turns[index] = scenario.turns[index].replace('{{challenge}}', challenge)
      }
      currentTurn = index
      context = randomBytes(24).toString('hex')
      boundary.dispatch(
        scenario.actors?.[index] ?? 'alice',
        scenario.conversations?.[index]
          ?? (scenario.id === 'scoped-style-separation' && index === 2
            ? 'professional'
            : index
            ? 'later-chat'
            : 'source-chat'),
        scenario.kinds?.[index] ?? (scenario.group && index ? 'group' : 'direct'),
        scenario.adapters?.[index] ?? 'feishu',
        `synthetic-message-${index}`,
        context,
        scenario.turns[index],
      )
      const cwd = path.join(directory, `turn-${index}`)
      const initializedPrompt = personaRegistry
        ? await boundary.initializePersona(personaRegistry, `task-${index}`, scenario.turns[index])
        : undefined
      if (initializedPrompt) await writeFile(path.join(directory, `initialization-${index}.txt`), initializedPrompt)
      await mkdir(cwd)
      const cli = path.join(cwd, 'cordisx.mjs')
      await writeFile(
        cli,
        `const args=process.argv.slice(2);if(args[0]!=='channel'||args[1]!=='memory')throw Error('Use channel memory');const inputIndex=args.indexOf('--input');const input=inputIndex<0?{}:JSON.parse(args[inputIndex+1]);const response=await fetch('http://127.0.0.1:${port}',{method:'POST',headers:{authorization:'Bearer ${context}','content-type':'application/json'},body:JSON.stringify({...input,action:args[2]})});console.log(await response.text());\n`,
      )
      const prompt =
        `You are handling ONE synthetic incoming Channel request. Do not inspect repository, parent directories, storage, or other turns. No sends, configuration, auth changes or file edits. Only the supplied mock platform client may be executed. Use node ./cordisx.mjs channel memory <action> --input '<JSON>' to invoke the real Host memory command. Actions: remember {record:{kind,title,summary,tags:[],entityRefs:[],evidenceType:"explicit",confidence:1,observedAt?}}, search {query,entity?}, get {id}, update {id,revision,record}, forget {id,revision}, index {}, grant {grant:{source,target:{kind:"conversation",id}}}, revoke {id}, grant-list {}. Search returns metadata, so get selected records for facts. Search may need alternate keywords. Remember only when requested. Record kinds: fact, preference, person, conversation, collaboration, impression. Tools may reject unsupported authorization: report that honestly, never claim successful sharing/binding without evidence. Do not invent missing memory facts. Each request starts with reset model context; durable facts must come from actual tool results. Answer the user naturally.\nIncoming request: ${
          scenario.turns[index]
        }`
      const identityInstructions = scenario.id === 'cross-platform-linked'
        ? ' Available identity tools: identity-challenge {target:{adapterId,accountId,tenantId,userId}} initiated on the first account, identity-confirm {challenge} from the verified second account, identity-unbind {}. A claim alone cannot bind; use the requested confirmation flow.'
        : ''
      const progressiveInstructions = scenario.bootstrap
        ? ' Start with navigate {limit:4,maxBytes:2048} or search-page {query,limit:4,maxBytes:2048}, then get {id} or batch {ids,maxBytes:4096}. Navigation and search-page return bounded cards and nextCursor; follow pages only if needed. Try project alias keywords if paraphrase misses. Stop once you have sufficient evidence; never dump all records.'
        : ''
      const command = [
        'exec',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '-C',
        cwd,
        '--json',
        '-o',
        path.join(cwd, 'answer.txt'),
        prompt + progressiveInstructions
        + identityInstructions
        + (scenario.outbound
          ? ' Mock outbound tool invokes real ChannelConversationTools.send: node ./cordisx.mjs channel memory send --input {"text":"user-visible text","operationId":"stable-id"}. Invoke only when asked. Account/destination come from current platform context, not caller JSON.'
          : '')
        + (scenario.id === 'natural-admin-new-member'
          ? ' grant schema: {grant:{source:string,target:{kind:"conversation",id:string}}}. Source/destination are taken ONLY from an explicit current sharing request; do not grant when only asked to save. Host verifies configured administrator; omit recordIds/expiresAt for full persistent grant.'
          : '')
        + (initializedPrompt
          ? `\nActual Host native initialization prompt (platform/native bridge simulated, no remote sends permitted): ${initializedPrompt}`
          : '')
        + (scenario.guide
          ? ' Discover instructions first: channel memory guide --input {} lists topics. Use guide --input {"topic":"write"} or organize/recall on demand before processing the request.'
          : ''),
      ]
      await writeFile(
        path.join(cwd, 'invocation.json'),
        JSON.stringify({ executable: 'codex', args: command }, null, 2),
      )
      const child = spawn('codex', command, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => {
        stdout += data
      })
      child.stderr.on('data', data => {
        stderr += data
      })
      const timeout = setTimeout(() => child.kill('SIGTERM'), 180000)
      const exit = await new Promise(resolve => child.on('close', resolve))
      clearTimeout(timeout)
      await writeFile(path.join(cwd, 'runtime.txt'), stderr)
      const answer = await readFile(path.join(cwd, 'answer.txt'), 'utf8').catch(() => '')
      const modelEvents = stdout.split('\n').filter(Boolean).flatMap(line => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      const publicEvents = modelEvents.filter(event => event.item?.type !== 'reasoning')
      await writeFile(
        path.join(cwd, 'model-events.jsonl'),
        publicEvents.map(event => JSON.stringify(event)).join('\n') + '\n',
      )
      const commands = modelEvents.filter(event =>
        event.type === 'item.completed' && event.item?.type === 'command_execution'
      )
        .map(event => event.item.command)
      turns.push({
        exit,
        answer,
        model: configuredModel,
        provider: configuredProvider,
        commands,
        toolOnly: commands.every(command => command.includes('node ./cordisx.mjs channel memory ')),
      })
      console.log(
        JSON.stringify({
          scenario: scenario.id,
          turn: index,
          exit,
          events: events.filter(event => event.turn === index).length,
          answer,
        }),
      )
      if (exit !== 0) break
    }
    const records = await boundary.records().catch(() => [])
    const checks = scenarioChecks(scenario, turns, events, records)
    const passed = !scenario.gap && Object.values(checks).every(Boolean)
    const result = {
      id: scenario.id,
      evidenceBoundary: scenario.personaBootstrap
        ? 'prototype-registry-capsule-delivery; not production initialization'
        : 'mock-platform real-command scenario',
      status: passed ? 'passed' : scenario.gap ? 'blocked' : 'failed',
      checks,
      gap: scenario.gap,
      turns,
      events,
      records,
      outbound: boundary.outbound(),
      bootstrapMs,
      scenarioMs: performance.now() - scenarioStart,
      toolCalls: events.length,
      returnedBytes: events.reduce((sum, event) => sum + event.bytes, 0),
    }
    results.push(result)
    await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(result, null, 2))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
await writeFile(
  path.join(output, 'results.json'),
  JSON.stringify({ output, configuredModel, configuredProvider, results }, null, 2),
)
console.log(
  JSON.stringify({ output, results: results.map(({ id, status, checks }) => ({ id, status, checks })) }, null, 2),
)
if (results.some(result => result.status === 'failed')) process.exitCode = 1
