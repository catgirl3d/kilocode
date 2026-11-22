// fork_change - new file
/**
 * Coalesce concurrent provider catalog fetches for the same client and directory
 * across KiloProvider instances. The result is not retained after the request
 * settles, so API keys carried in the response are never kept in a shared cache.
 */
export function createProviderFetch() {
  const inflight = new Map<string, { owner: unknown; epoch: number; request: Promise<unknown> }>()
  let epoch = 0

  async function read<T>(owner: unknown, dir: string, load: () => Promise<T>): Promise<T> {
    const current = inflight.get(dir)
    if (current && current.owner === owner && current.epoch === epoch) return current.request as Promise<T>
    const request = load().finally(() => {
      if (inflight.get(dir)?.request === request) inflight.delete(dir)
    })
    inflight.set(dir, { owner, epoch, request })
    return request
  }

  /** Make later reads start a new request instead of joining one that began before a catalog change. */
  function reset() {
    epoch += 1
  }

  return { read, reset }
}
