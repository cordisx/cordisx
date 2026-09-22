import { runInNewContext } from 'node:vm'
import { discoverNativeSubmissionTransforms } from '../../packages/cli/src/launcher/native-submission-structure.js'
import { resources } from './native-submission-structure.js'

export const firstTurnToken = 'first-turn-baseline-operation'
export const collaborationMode = (model: string) => ({
  mode: 'default',
  settings: { model, reasoning_effort: 'medium', developer_instructions: 'preserved' },
})

export function firstTurnRuntime(createNativeThread: (input: unknown) => Promise<unknown>) {
  const source = resources()
  const sandbox: Record<string, any> = { createNativeThread, updateModel: () => {} }
  for (const transform of discoverNativeSubmissionTransforms(source)) {
    runInNewContext(transform.transform(source.find(item => item.url === transform.url)!.source).source, sandbox)
  }
  return sandbox
}

// Semantic Host fixture: setting notifications compare the UI mode, not a wire log.
export function nativeModelChangeState(initialModel: string) {
  let model = initialModel
  let previousTurnModel: string | null = null
  let turnCount = 0
  return {
    beginTurn(nextModel = model) {
      const items = previousTurnModel !== null && previousTurnModel !== model
        ? [{ type: 'modelChanged', fromModel: previousTurnModel, toModel: model }]
        : []
      previousTurnModel = null
      turnCount++
      model = nextModel
      return items
    },
    applySettings(nextModel: string) {
      if (turnCount > 0 && model !== '' && nextModel !== model) {
        if (previousTurnModel === null) previousTurnModel = model
        else if (nextModel === previousTurnModel) previousTurnModel = null
      }
      model = nextModel
    },
    get model() {
      return model
    },
  }
}
