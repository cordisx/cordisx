export interface UserMemoryRecall {
  identity?: true
  topics?: readonly string[]
}

/** The incoming user can request their own facts for this audience; a model query cannot grant this scope. */
export function channelUserMemoryRequest(request: string | undefined): UserMemoryRecall | undefined {
  if (!request || request.length > 4096 || /["“”「」『』`\n\r<>]/u.test(request)) return undefined
  const text = request.trim().replace(/[。.!！?？]+$/u, '').trim()
  if (
    /@|不要|别查|别读|别说|别告诉|他(?:的|是谁)|她(?:的|是谁)|别人|其他人|do not|don't|someone|their|his |her /iu.test(
      text,
    )
  ) return undefined
  if (
    /^(?:你(?:还)?(?:知道|记得|认识))?(?:我的|我自己的)(?:名字|姓名|称呼)(?:是|叫)?(?:什么|啥)(?:吗|呢)?$/u.test(text)
  ) return { identity: true, topics: ['name'] }
  if (
    /^(?:你?(?:还)?(?:知道|记得|认识)(?:我是谁|我叫什么|我的名字|我的称呼|我们的关系)(?:吗|呢)?|你?认识我(?:吗|是谁)?|我是谁|我叫什么|who am i|do you (?:remember|know|recognize) me|what is my name)$/iu
      .test(text)
  ) {
    return { identity: true, ...(/名字|称呼|叫什么|my name/iu.test(text) ? { topics: ['name'] } : {}) }
  }
  if (
    !/(?:我的|我自己的|\bmy\b)/iu.test(text)
    || !/什么|哪|如何|怎样|记得|知道|回忆|告诉|\b(?:what|recall|remember|tell|know)\b/iu.test(text)
  ) return undefined
  const chinese = [
    ...text.matchAll(
      /(?:我自己的|我的)([\p{L}\p{N}_-]{1,40}?)(?=是|有|叫|为|怎么样|是什么|如何|怎样|你|吗|呢|[，,？? ]|$)/gu,
    ),
  ]
    .map(match => match[1]!)
  const english = [...text.matchAll(/\bmy ([\p{L}\p{N}_ -]{1,64}?)(?=\?|$| is | are | was | were )/giu)]
    .map(match => match[1]!.trim().toLowerCase())
  const topics = [...new Set([...chinese, ...english])].filter(topic =>
    !/全部|所有|隐私|信息|记录|记忆|\b(?:all|private|information|memory)\b/iu.test(topic)
  )
  return topics.length ? { topics: topics.slice(0, 8) } : undefined
}

export function userMemoryMatches(
  record: {
    kind?: string
    title?: string
    tags?: string[]
    summary?: string
    keywords?: string
    userMemory?: { key: string; category: string }
  },
  recall: UserMemoryRecall,
): boolean {
  const text = [record.title, record.summary, record.keywords, ...(record.tags ?? [])].join(' ').toLowerCase()
  if (recall.identity) {
    if (recall.topics?.includes('name')) {
      return record.userMemory?.category === 'name'
        || record.kind === 'person' && /名字|姓名|称呼|\bname\b/iu.test(record.title ?? '')
    }
    return record.userMemory
      ? ['name', 'relationship'].includes(record.userMemory.category)
      : record.kind === 'person'
        && /身份|名字|姓名|称呼|关系|\b(?:identity|name|relationship)\b/iu.test(record.title ?? '')
  }
  return recall.topics?.some(topic => text.includes(topic.toLowerCase())) === true
}
