// fork_change - new file
import { batch, createContext, createSignal, onCleanup, onMount, useContext, type ParentComponent } from "solid-js"
import type { SessionTagAction, SessionTagError, SessionTagsState } from "../types/messages"
import { useVSCode } from "./vscode"

type Result = { ok: boolean; error?: SessionTagError }

const Context = createContext<{
  state: () => SessionTagsState
  ready: () => boolean
  forSession: (id: string) => SessionTagsState["tags"]
  mutate: (action: SessionTagAction) => Promise<Result>
}>()

export const SessionTagsProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const [state, setState] = createSignal<SessionTagsState>({ tags: [], sessions: {} })
  const [ready, setReady] = createSignal(false)
  const pending = new Map<string, (result: Result) => void>()
  const disposed = { value: false }

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type === "sessionTagsLoaded") {
      batch(() => {
        setState(message.state)
        setReady(true)
      })
      return
    }
    if (message.type !== "sessionTagResult") return
    const resolve = pending.get(message.requestID)
    if (!resolve) return
    pending.delete(message.requestID)
    resolve({ ok: message.ok, error: message.error })
  })

  onMount(() => vscode.postMessage({ type: "requestSessionTags" }))
  onCleanup(() => {
    disposed.value = true
    unsubscribe()
    pending.forEach((resolve) => resolve({ ok: false }))
    pending.clear()
  })

  const value = {
    state,
    ready,
    forSession: (id: string) => {
      const snapshot = state()
      return (snapshot.sessions[id] ?? []).flatMap((id) => {
        const tag = snapshot.tags.find((tag) => tag.id === id)
        return tag ? [tag] : []
      })
    },
    mutate: (action: SessionTagAction): Promise<Result> => {
      if (disposed.value || !ready()) return Promise.resolve({ ok: false })
      const request = Promise.withResolvers<Result>()
      const id = crypto.randomUUID()
      pending.set(id, request.resolve)
      vscode.postMessage({ type: "sessionTagAction", requestID: id, action })
      return request.promise
    },
  }

  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useSessionTags() {
  const context = useContext(Context)
  if (!context) throw new Error("useSessionTags must be used within a SessionTagsProvider")
  return context
}
