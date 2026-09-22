// Synthetic protocol examples from the official Responses/Codex guides, reviewed 2026-09-22.
// These are offline compatibility fixtures, not captured provider traffic or an HTTP client.
export const responsesBaseUrl = 'https://api.deepseek.com/'
export const responsesOperationUrl = 'https://api.deepseek.com/responses'
export const userInput = [{ role: 'user', content: [{ type: 'input_text', text: 'Update the fixture.' }] }]
export const functionCall = {
  type: 'function_call',
  id: 'fc_fixture',
  call_id: 'call_fixture',
  name: 'read_file',
  arguments: '{"path":"fixture.txt"}',
}
export const patchCall = {
  type: 'custom_tool_call',
  id: 'ct_fixture',
  call_id: 'patch_fixture',
  name: 'apply_patch',
  input: '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-old\n+new\n*** End Patch',
}
export const firstOutput = [functionCall, patchCall]
export const toolResults = [
  { type: 'function_call_output', call_id: functionCall.call_id, output: 'old' },
  { type: 'custom_tool_call_output', call_id: patchCall.call_id, output: 'Success' },
]
export const nextInput = [...userInput, ...firstOutput, ...toolResults, {
  role: 'user',
  content: [{ type: 'input_text', text: 'Summarize the update.' }],
}]
export const request = (input = userInput) => ({
  model: 'deepseek-flash',
  input,
  stream: true,
  store: false,
  tools: [
    { type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { type: 'custom', name: 'apply_patch' },
  ],
})
export const responseEvents = [
  { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
  { type: 'response.in_progress', response: { id: 'resp_fixture', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { ...functionCall, arguments: '' } },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: functionCall.id,
    delta: functionCall.arguments,
  },
  {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: functionCall.id,
    arguments: functionCall.arguments,
  },
  { type: 'response.output_item.done', output_index: 0, item: functionCall },
  { type: 'response.output_item.added', output_index: 1, item: { ...patchCall, input: '' } },
  { type: 'response.custom_tool_call_input.delta', output_index: 1, item_id: patchCall.id, delta: patchCall.input },
  { type: 'response.custom_tool_call_input.done', output_index: 1, item_id: patchCall.id, input: patchCall.input },
  { type: 'response.output_item.done', output_index: 1, item: patchCall },
  {
    type: 'response.completed',
    response: {
      id: 'resp_fixture',
      status: 'completed',
      store: false,
      previous_response_id: null,
      output: firstOutput,
      usage: {
        input_tokens: 20,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  },
].map((event, sequence_number) => ({ ...event, sequence_number }))
export const responseSse = responseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(
  '',
)
