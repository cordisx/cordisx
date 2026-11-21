export function scenarioChecks(scenario, turns, events, records) {
  const last = turns.at(-1)?.answer ?? ''
  const successful = events.filter(event => event.result.status === 'ok')
  const reads = successful.filter(event =>
    event.turn === scenario.turns.length - 1
    && ['get', 'batch'].includes(event.input.action)
  )
  return {
    noPrematureGrant: scenario.id !== 'natural-admin-new-member'
      || !successful.some(event => event.turn === 0 && event.input.action === 'grant'),
    personaRecognized: !scenario.personaName || last.includes(scenario.personaName),
    outboundGenerated: !scenario.outbound
      || events.some(event =>
          event.input.action === 'send' && event.result.status === 'ok'
          && event.result.deliveryState === 'sent'
          && event.input.text.includes('OUTBOUND-82') && /[\u4e00-\u9fff]/u.test(event.input.text)
        )
        && /[\u4e00-\u9fff]/u.test(last),
    profileNotFabricated: scenario.id !== 'scoped-style-separation'
      || records.every(record => !/professional|casual|response.?style|中文|英文|风格/iu.test(record.summary)),
    toolOnly: turns.every(turn => turn.toolOnly !== false),
    modelCompleted: turns.length === scenario.turns.length && turns.every(turn => turn.exit === 0),
    actualSave: (scenario.bootstrap || successful.some(event => event.input.action === 'remember'))
      && records.length > 0,
    incrementalBudget: !scenario.maxReadBytes
      || events.reduce((sum, event) => sum + (event.bytes ?? 0), 0) <= scenario.maxReadBytes,
    factsFromRead: scenario.negative
      ? reads.length === 0
      : reads.length > 0
        && scenario.facts.every(fact =>
          reads.some(event => JSON.stringify(event.result).toLowerCase().includes(fact.toLowerCase()))
        ),
    answerFacts: (scenario.facts ?? []).every(fact => last.toLowerCase().includes(fact.toLowerCase())),
    noObsoleteFacts: (scenario.forbidden ?? []).every(fact => !last.toLowerCase().includes(fact.toLowerCase())),
    revision: !scenario.revision || records.some(record => record.revision >= scenario.revision),
    guidanceUsed: !scenario.guide
      || successful.some(event => event.input.action === 'guide' && event.input.topic === 'write'),
    structuredRecord: !scenario.structured
      || records.length === 1 && records[0].entityRefs.includes('project-northstar')
        && ['DECISION-68', '2026', '12', 'reliability', 'SYN-417'].every(fact => records[0].summary.includes(fact))
        && !/coffee|joked/iu.test(records[0].summary),
    searchBeforeWrite: !scenario.structured
      || events.findIndex(event => ['search', 'search-page'].includes(event.input.action)) >= 0
        && events.findIndex(event => ['search', 'search-page'].includes(event.input.action))
          < events.findIndex(event => event.input.action === 'remember'),
    styleSeparation: scenario.id !== 'scoped-style-separation' || turns.length === 3
        && turns[1].answer.includes('STYLE-55') && /[\u4e00-\u9fff]/u.test(turns[1].answer)
        && turns[2].answer.includes('STYLE-55')
        && !/[\u4e00-\u9fff]|casual Chinese|private responses.*Chinese/iu.test(turns[2].answer),
  }
}
