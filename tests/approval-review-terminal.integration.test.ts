import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'

it('projects review configuration through the CLI launcher and cleans its private snapshot after exit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-review-terminal-'))
  const native = path.join(root, 'codex'), catalog = path.join(root, 'models.json')
  const model = {
    slug: 'work',
    display_name: 'Work',
    supported_in_api: true,
    supported_reasoning_levels: [],
    shell_type: 'shell_command',
    visibility: 'list',
    priority: 1,
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 },
    experimental_supported_tools: [],
    model_messages: { auto_review: { policy_template: 'Original template', policy: 'Original policy' } },
  }
  let snapshot: string | undefined
  try {
    await writeFile(native, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.149.1"; fi\n', {
      mode: 0o700,
    })
    await writeFile(catalog, JSON.stringify({ models: [model, { ...model, slug: 'review' }] }))
    const config = createDefaultHomeConfig()
    config.providers = [{
      id: 'gateway',
      kind: 'model-service',
      displayName: 'Gateway',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'KEY',
      protocols: ['openai-responses'],
      models: { codex: ['work', 'review'] },
    }]
    config.apps.codex!.profiles.default!.approvalReview = {
      revision: 1,
      settings: { providerId: 'gateway', catalogPath: 'models.json', models: { work: 'review' } },
    }
    await writeFile(path.join(root, 'config.json'), JSON.stringify(config))
    const env = { CORDISX_HOME: root, CODEX_HOME: root, KEY: 'fixture-key' }
    const run = (extra: string[] = []) =>
      runCordisXCli([
        'start',
        '--mode',
        'cli',
        'codex',
        '-s',
        'gateway',
        '-m',
        'work',
        '--executable',
        native,
        '--',
        ...extra,
      ], {
        env,
        internalCheckTerminalClient: async executable => executable,
        internalSpawnTerminal: ((executable, args, options) => {
          expect(executable).toBe(native)
          expect(args).toContain('model_provider="gateway"')
          expect(args.join(' ')).not.toContain('fixture-key')
          snapshot = JSON.parse(
            args.find(arg => arg.startsWith('model_catalog_json='))!.slice('model_catalog_json='.length),
          )
          return spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),20)'], options)
        }) as typeof spawn,
      })
    await run()
    expect(snapshot).toBeTruthy()
    await expect(stat(snapshot!)).rejects.toThrow()
    expect(JSON.parse(await readFile(catalog, 'utf8')).models[0].auto_review_model_override).toBeUndefined()
    for (const args of [['-pother'], ['--config=model_catalog_json="/other"'], ['-cmodel_provider="other"']]) {
      await expect(run(args)).rejects.toThrow()
    }
    expect(
      JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).apps.codex.profiles.default.approvalReview
        .revision,
    ).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
