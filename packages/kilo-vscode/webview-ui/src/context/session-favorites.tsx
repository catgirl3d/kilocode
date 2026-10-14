// fork_change - new file
import { batch, createContext, createSignal, onCleanup, onMount, useContext, type ParentComponent } from "solid-js"
import type { SessionFavoriteAction, SessionFavoriteError, SessionFavoritesState } from "../types/messages"
import { requestSnapshot } from "./host-snapshot"
import { useVSCode } from "./vscode"

type Result = { ok: boolean; error?: SessionFavoriteError }

const Context = createContext<{
  state: () => SessionFavoritesState
  ready: () => boolean
  isFavorite: (id: string) => boolean
  mutate: (action: SessionFavoriteAction) => Promise<Result>
}>()

export const SessionFavoritesProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const [state, setState] = createSignal<SessionFavoritesState>({ sessions: [] })
  const [ready, setReady] = createSignal(false)
  const pending = new Map<string, (result: Result) => void>()
  const disposed = { value: false }

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type === "sessionFavoritesLoaded") {
      batch(() => {
        setState(message.state)
        setReady(true)
      })
      return
    }
    if (message.type !== "sessionFavoriteResult") return
    const resolve = pending.get(message.requestID)
    if (!resolve) return
    pending.delete(message.requestID)
    resolve({ ok: message.ok, error: message.error })
  })

  onMount(() =>
    requestSnapshot({
      request: () => vscode.postMessage({ type: "requestSessionFavorites" }),
      ready,
      onMessage: vscode.onMessage,
    }),
  )
  onCleanup(() => {
    disposed.value = true
    unsubscribe()
    pending.forEach((resolve) => resolve({ ok: false }))
    pending.clear()
  })

  const value = {
    state,
    ready,
    isFavorite: (id: string) => state().sessions.includes(id),
    mutate: (action: SessionFavoriteAction): Promise<Result> => {
      if (disposed.value || !ready()) return Promise.resolve({ ok: false })
      const request = Promise.withResolvers<Result>()
      const id = crypto.randomUUID()
      pending.set(id, request.resolve)
      vscode.postMessage({ type: "sessionFavoriteAction", requestID: id, action })
      return request.promise
    },
  }

  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useSessionFavorites() {
  const context = useContext(Context)
  if (!context) throw new Error("useSessionFavorites must be used within a SessionFavoritesProvider")
  return context
}
