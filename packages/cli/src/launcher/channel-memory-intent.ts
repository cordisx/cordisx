function chineseOwnedTopics(request: string): string[] {
  const topics: string[] = []
  const owned =
    /(?:我(?:自己)?的|我(?:之前|以前|曾经)?(?:让|叫)?你?(?:记住|保存)(?:过)?的?)\s*[「“"《]?([\p{L}\p{N}_ -]{2,64})/gu
  const generic = new Set([
    '项目',
    '任务',
    '主题',
    '进度',
    '进展',
    '状态',
    '内容',
    '记录',
    '记忆',
    '对话',
    '群聊',
    '其他对话',
  ])
  for (const match of request.matchAll(owned)) {
    const subject = match[1]!
      .replace(/^(?:之前|以前)?(?:让|叫)你(?:记住|保存)(?:过)?的/u, '')
      .replace(/(?:项目|任务|主题)(?:的|现在|目前|当前|进度|进展|状态|怎么样|如何|什么|$).*$/u, '')
      .replace(/(?:的)?(?:现在|目前|当前)?(?:进度|进展|状态|怎么样|如何|是什么|叫什么|叫啥).*$/u, '')
      .trim().toLowerCase()
    if (subject.length >= 2 && subject.length <= 64 && !generic.has(subject)) topics.push(subject)
  }
  return topics
}

export function ownMemoryTopic(request: string | undefined): string[] | undefined {
  if (!request || request.length > 16384) return undefined
  const explicit = /\b(?:my|I (?:asked|saved)|I.*remember)\b/iu.test(request)
    || /(?:我自己的|我的|我.*记住|我.*保存)/u.test(request)
  const recall = /\b(?:tell|recall|remember|saved|name|code|what)\b/iu.test(request)
    || /(?:告诉|回忆|记得|什么|叫|进度|进展|状态|怎么样|如何)/u.test(request)
  if (!explicit || !recall) return undefined
  const stop = new Set(
    'tell this group the from my own private topic that i asked you to remember what is name code saved for of and a me professional without disclosing preference style request please previously project task progress status current now'
      .split(' '),
  )
  const words = request.toLowerCase().match(/[\p{L}\p{N}_-]{3,64}/gu) ?? []
  return [
    ...new Set([
      ...chineseOwnedTopics(request),
      ...words.filter(word => !/\p{Script=Han}/u.test(word) && !stop.has(word)),
    ]),
  ].slice(0, 16)
}
