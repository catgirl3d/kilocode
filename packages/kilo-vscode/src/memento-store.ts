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

  const write = (run: (current: T) => { next?: T } | undefined): Promise<void> => {
    const result = queue.then(async () => {
      const change = run(options.copy(state))
      if (!change || change.next === undefined) return
      if (!memento) throw new Error(`Memento store ${options.key} is not initialized`)
      const next = options.copy(change.next)
      await memento.update(options.key, next)
      state = options.copy(next)
      publish()
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

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

  return { init, snapshot, onChange, write }
}
