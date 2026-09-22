import { expect, it } from 'vitest'
import { nativeSubmissionCredentialBroker } from '../packages/cli/src/launcher/native-submission-credentials.js'
import {
  firstOutput,
  functionCall,
  nextInput,
  patchCall,
  request,
  responseEvents,
  responsesBaseUrl,
  responsesOperationUrl,
  responseSse,
  toolResults,
  userInput,
} from './fixtures/deepseek-responses.js'

it('projects the Responses base path without pre-appending the operation path', async () => {
  for (const [apiPath, baseUrl] of [['/', responsesBaseUrl], ['/v1', 'https://fixture.invalid/v1']]) {
    const origin = new URL(baseUrl!).origin
    const broker = nativeSubmissionCredentialBroker({
      credentials: {
        prepare: async () => ({ scheme: 'none', serviceGeneration: 'fixture', dispose() {} }),
        close: async () => {},
      },
      resolveEndpoint: () => ({
        value: {
          service: { pluginId: 'fixture', serviceId: 'fixture', generation: 'fixture' },
          endpoint: { origin, apiPath: apiPath as `/${string}`, auth: { scheme: 'none' } },
          models: { generation: 'fixture', defaultAlias: '', aliases: [] },
          cleanup: { authorityId: 'fixture' },
        },
        dispose() {},
      }),
    })
    const prepared = await broker.prepare('fixture')
    expect(prepared.endpoint).toEqual({ baseUrl, wireApi: 'responses' })
    // Matches upstream Provider::url_for_path; no HTTP request is issued here.
    expect(`${prepared.endpoint.baseUrl.replace(/\/+$/, '')}/responses`)
      .toBe(apiPath === '/' ? responsesOperationUrl : 'https://fixture.invalid/v1/responses')
    await prepared.dispose()
  }
})

it('records semantic SSE completion without DONE and complete stateless tool round trips', () => {
  expect(responseEvents.map(event => event.sequence_number)).toEqual(responseEvents.map((_, index) => index))
  expect(responseEvents.at(-1)).toMatchObject({
    type: 'response.completed',
    response: { store: false, output: firstOutput },
  })
  expect(responseSse).not.toContain('[DONE]')
  expect(responseEvents.filter(event => event.type.endsWith('.delta')).map(event => event.delta))
    .toEqual([functionCall.arguments, patchCall.input])
  expect(toolResults.map(result => result.call_id)).toEqual(firstOutput.map(call => call.call_id))
  const followup = request(nextInput)
  expect(followup.input).toEqual([...userInput, ...firstOutput, ...toolResults, nextInput.at(-1)])
  expect(followup).not.toHaveProperty('previous_response_id')
  expect(followup).not.toHaveProperty('conversation')
})
