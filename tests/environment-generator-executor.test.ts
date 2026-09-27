import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  EnvironmentGeneratorError,
  EnvironmentGeneratorExecutor,
  environmentGeneratorSupported,
} from '../packages/cli/src/launcher/model-catalog/environment-generator-executor.js'

const supported = environmentGeneratorSupported() ? it : it.skip

describe('environment variable shell generator', () => {
  supported('returns strict UTF-8 stdout and removes exactly one trailing newline', async () => {
    const executor = new EnvironmentGeneratorExecutor()
    try {
      await expect(executor.run('first', "printf 'value\\n\\n'")).resolves.toBe('value\n')
      await expect(executor.run('second', "printf 'literal $(ordinary data)'"))
        .resolves.toBe('literal $(ordinary data)')
    } finally {
      executor.close()
    }
  })

  supported('rejects empty, invalid, failed, and oversized output without returning stderr', async () => {
    const executor = new EnvironmentGeneratorExecutor()
    try {
      await expect(executor.run('empty', "printf '\\n'"))
        .rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'empty' })
      await expect(executor.run('nul', "printf 'a\\000b'"))
        .rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'failed' })
      await expect(executor.run('utf8', "printf '\\377'"))
        .rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'failed' })
      await expect(executor.run('exit', "printf 'private diagnostic' >&2; exit 7"))
        .rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'failed' })
      await expect(executor.run('large', "head -c 17000 /dev/zero | tr '\\000' x"))
        .rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'too-large' })
    } finally {
      executor.close()
    }
  })

  supported('allows one active run and cancels it by exact run ID', async () => {
    const executor = new EnvironmentGeneratorExecutor()
    try {
      const pending = executor.run('waiting', 'sleep 30; printf late')
      await expect(executor.run('second', 'printf second'))
        .rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'busy' })
      expect(executor.cancel('other')).toBe(false)
      expect(executor.cancel('waiting')).toBe(true)
      await expect(pending).rejects.toMatchObject<EnvironmentGeneratorError>({ code: 'cancelled' })
    } finally {
      executor.close()
    }
  })

  supported('uses only the fixed environment and root working directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-generator-env-'))
    const command = path.join(directory, 'probe')
    await writeFile(command, '#!/bin/sh\nprintf inherited', { mode: 0o755 })
    const executor = new EnvironmentGeneratorExecutor()
    const previous = process.env.PATH
    process.env.PATH = `${directory}:${previous ?? ''}`
    try {
      await expect(executor.run('environment', 'printf "%s|%s|%s" "$PWD" "$LANG" "$(command -v probe || true)"'))
        .resolves.toBe('/|C|')
    } finally {
      process.env.PATH = previous
      executor.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
