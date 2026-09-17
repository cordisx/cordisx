import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('IconButton tooltip', () => {
  it('does not repeat identical labels and descriptions', async () => {
    const source = await readFile(path.join(projectRoot, 'packages/cli/src/renderer/host-ui/IconButton.tsx'), 'utf8')
    expect(source).toContain('description === undefined || description === label')
    expect(source).toContain('title={title}')
  })
})
