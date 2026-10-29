import { createInterface } from 'node:readline'
import type { ModelExportInvocation } from './model-export-parse.js'
import type { CordisXCliRuntime } from './run-runtime.js'

export class ModelExportChoiceError extends Error {
  readonly exitCode = 2
  constructor(
    readonly code: 'choice-required' | 'cancelled' | 'invalid-choice',
    message: string,
    readonly reported = false,
  ) {
    super(message)
  }
}

/** Decide before the authority generates final portable text or the CLI publishes a file. */
export async function chooseModelExportValues(
  variables: readonly string[],
  profileId: string,
  invocation: ModelExportInvocation,
  runtime: CordisXCliRuntime,
): Promise<boolean> {
  const input = runtime.stdin ?? process.stdin
  const output = runtime.stderr ?? process.stderr
  const choices = [
    {
      key: 'A',
      flag: '--include-values',
      description:
        'Include saved, enabled, referenced user values in UNENCRYPTED portable text; unavailable values still need completing on the target.',
    },
    {
      key: 'B',
      flag: '--exclude-values',
      description: 'Omit values; complete them on the target before using dependent services.',
    },
  ]
  const stdoutIsTTY = runtime.internalModelExportStdoutIsTTY
    ?? (runtime.stdout === undefined && process.stdout.isTTY === true)
  if (input.isTTY !== true || !stdoutIsTTY) {
    output.write(`${
      JSON.stringify({
        status: 'choice-required',
        code: 'model-export-variable-choice-required',
        profileId,
        variables,
        choices,
        selection: {
          all: invocation.all,
          services: invocation.services,
          modelIds: invocation.modelIds,
          output: invocation.output ?? '-',
        },
        message:
          'No export was generated or written. Ask the user A/B, then run the same selection with --include-values or --exclude-values. Honor an explicit choice already made in this session.',
      })
    }\n`)
    throw new ModelExportChoiceError('choice-required', 'Variable-value choice required before export', true)
  }
  if (input.readableEnded || input.destroyed) {
    throw new ModelExportChoiceError('cancelled', 'Export cancelled before output (EOF)')
  }
  output.write(
    `Variable dependencies: ${variables.join(', ')}\n${
      choices.map(choice => `${choice.key}) ${choice.description}`).join('\n')
    }\nChoose A or B (Q to cancel): `,
  )
  const reader = createInterface({ input, terminal: false })
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      reader.once('line', resolve)
      reader.once(
        'close',
        () => reject(new ModelExportChoiceError('cancelled', 'Export cancelled before output (EOF)')),
      )
      reader.once('SIGINT', () => reject(new ModelExportChoiceError('cancelled', 'Export cancelled before output')))
      reader.once('error', reject)
    })
    const choice = answer.trim().toUpperCase()
    if (choice === 'A') return true
    if (choice === 'B') return false
    if (choice === 'Q' || choice === 'CANCEL') {
      throw new ModelExportChoiceError('cancelled', 'Export cancelled before output')
    }
    throw new ModelExportChoiceError('invalid-choice', 'Choose A or B; no export was generated or written')
  } finally {
    reader.close()
  }
}
