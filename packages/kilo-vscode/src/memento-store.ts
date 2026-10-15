// fork_change - new file
import type { Memento } from "vscode"

type Options<T> = {
  key: string
  empty: T
  sanitize: (value: unknown) => T
  copy: (value: T) => T
}

export function createMementoStore<T>(options: Options<T>) {
  let memento: Memento | undefined
  let state = options.copy(options.empty)
  let queue = Promise.resolve()
  const listeners = new Set<(value: T) => void>()

  const init = (value: Memento): void => {
    memento = value
    state = options.sanitize(value.get(options.key))
  }

  const snapshot = (): T => options.copy(state)

  const onChange = (listener: (value: T) => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // fork_change start - read fresh Memento state before queued writes
  const write = (run: (current: T) => { next?: T } | undefined): Promise<void> => {
    const result = queue.then(async () => {
      const current = memento
      if (!current) {
        const change = run(options.copy(state))
        if (!change || change.next === undefined) return
        throw new Error(`Memento store ${options.key} is not initialized`)
      }
      const fresh = options.sanitize(current.get(options.key))
      const change = run(options.copy(fresh))
      if (!change || change.next === undefined) {
        if (JSON.stringify(fresh) === JSON.stringify(state)) return
        state = options.copy(fresh)
        publish()
        return
      }
      const next = options.copy(change.next)
      await current.update(options.key, next)
      state = options.copy(next)
      publish()
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const refresh = (): void => {
    const current = memento
    if (!current) return
    const fresh = options.sanitize(current.get(options.key))
    if (JSON.stringify(fresh) === JSON.stringify(state)) return
    state = options.copy(fresh)
    publish()
  }
  // fork_change end

  const publish = (): void => {
    for (const listener of listeners) {
      try {
        listener(snapshot())
      } catch (error) {
        // Listener failures must not affect the store or later writes.
        void error
      }
    }
  }

  return { init, snapshot, onChange, write, refresh }
}
