export function ownMemoryTopic(request: string | undefined): string[] | undefined {
  if (!request || request.length > 16384) return undefined
  const explicit = /\b(?:my own|my private|my.*topic|I (?:asked|saved)|I.*remember)\b/iu.test(request)
    || /(?:我自己的|我的|我.*记住|我.*保存)/u.test(request)
  const recall = /\b(?:tell|recall|remember|saved|name|code|what)\b/iu.test(request)
    || /(?:告诉|回忆|记得|什么|叫)/u.test(request)
  if (!explicit || !recall) return undefined
  const stop = new Set(
    'tell this group the from my own private topic that i asked you to remember what is name code saved for of and a me professional without disclosing preference style request please previously'
      .split(' '),
  )
  const words = request.toLowerCase().match(/[\p{L}\p{N}_-]{3,64}/gu) ?? []
  return [...new Set(words.filter(word => !stop.has(word)))].slice(0, 16)
}
