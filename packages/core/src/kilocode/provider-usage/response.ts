// fork_change - new file
export async function read(response: Response, limit: number, fail: () => Error): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    response.body?.cancel().catch(() => undefined)
    throw fail()
  }
  if (!response.body) {
    const value = await response.arrayBuffer()
    if (value.byteLength > limit) throw fail()
    return new TextDecoder().decode(value)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (!chunk.value) continue
    size += chunk.value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw fail()
    }
    chunks.push(chunk.value)
  }
  const value = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(value)
}
