/**
 * Sidebar selection actions with per-project tab memory.
 *
 * Extracted from AgentManagerApp (file-size cap): selecting Local or a
 * worktree restores the last active tab of that context (session, pending
 * draft, terminal, or review) and falls back to the first available session.
 */

import { batch } from "solid-js"
// fork_change start - local session routing does not control sidebar visibility
import type { WebviewMessage } from "../src/types/messages"
import { canOpenRootSession, LOCAL } from "./navigate"
// fork_change end

interface TermState {
  forSelection: (sel: string) => { id: string }[]
  hasRemembered: (sel: string, remembered: string | undefined) => boolean
  setActiveId: (id: string | undefined) => void
}

interface SessionLike {
  id: string
}

export function rememberSelectionTab(
  set: (selection: string, tab: string) => void,
  selection: string | null,
  tab: string,
) {
  if (selection !== null) set(selection === LOCAL ? LOCAL : selection, tab)
}

export function createTabMemory(opts: {
  selection: () => string | null
  tab: () => string | undefined
  applied: () => string | undefined
  active: () => string | undefined
  owns: (selection: string) => boolean
  locals: () => string[]
  localTab?: (id: string) => boolean
  session?: () => string | undefined
  rememberSession?: (selection: string, id: string) => void
  set: (selection: string, tab: string) => void
}) {
  return (switching = false) => {
    const sel = opts.selection()
    const tab = opts.tab()
    if (sel === null || !tab) return
    if (!switching && opts.applied() !== opts.active()) return
    if (!(sel === LOCAL ? opts.localTab?.(tab) || opts.locals().includes(tab) : opts.owns(sel))) return
    rememberSelectionTab(opts.set, sel, tab)
    const session = opts.session?.()
    if (session) opts.rememberSession?.(sel, session)
  }
}

export interface SelectionActionDeps<T extends SessionLike> {
  saveTabMemory: () => void
  setReviewActive: (open: boolean) => void
  setSelection: (id: string) => void
  post: (msg: unknown) => void
  tabMemory: () => Record<string, string>
  sessionMemory?: (selection: string) => string | undefined
  terms: TermState
  /** Terminal state is keyed by project-namespaced context; map a plain
   *  selection ("local" or a worktree id) to its terminal-state key. */
  nsKey: (sel: string) => string
  activateTerminal: (id: string) => void
  setActivePendingId: (id: string | undefined) => void
  focusLocal: (id: string) => void
  selectSession: (id: string) => void
  clearSession: () => void
  resetSession: () => void
  isPending: (id: string) => boolean
  isReviewTab: (remembered: string | undefined, sel: string) => boolean
}

export function restoreSessionAfterTerminal<T extends SessionLike>(input: {
  terminal: string | undefined
  remembered: string | undefined
  sessions: T[]
  isPending: (id: string) => boolean
  select: (id: string, pending: boolean) => void
  create: () => "ready" | "pending"
}): "none" | "ready" | "pending" {
  if (!input.terminal) return "none"
  const target = input.sessions.find((item) => item.id === input.remembered) ?? input.sessions[0]
  if (target) input.select(target.id, input.isPending(target.id))
  else return input.create()
  return "ready"
}

export function createSessionRestore<T extends SessionLike>(deps: {
  terminal: () => string | undefined
  selection: () => string | null
  remembered: (selection: string) => string | undefined
  sessions: () => T[]
  current: () => string | undefined
  pending: () => string | undefined
  isPending: (id: string) => boolean
  select: (id: string, pending: boolean) => void
  create: () => "ready" | "pending"
  remember: (selection: string, id: string) => void
}) {
  return {
    remember: () => {
      const selection = deps.selection()
      const id = deps.current() ?? deps.pending()
      if (selection !== null && id && deps.sessions().some((item) => item.id === id)) deps.remember(selection, id)
    },
    restore: () => {
      const selection = deps.selection()
      return restoreSessionAfterTerminal({
        terminal: deps.terminal(),
        remembered: selection === null ? undefined : deps.remembered(selection),
        sessions: deps.sessions(),
        isPending: deps.isPending,
        select: deps.select,
        create: deps.create,
      })
    },
  }
}

function terminal(
  deps: SelectionActionDeps<SessionLike>,
  selection: string,
  remembered: string | undefined,
  empty: boolean,
): string | undefined {
  const key = deps.nsKey(selection)
  const known = deps.terms.hasRemembered(key, remembered)
  if (!known && (!empty || deps.isReviewTab(remembered, selection))) return
  return known ? remembered : deps.terms.forSelection(key).at(0)?.id
}

// fork_change start - preserve the session-list routing used by the Agent Manager
export function createChatSessionSelector(deps: {
  addSessionToCurrentWorktree: (id: string) => boolean
  localSessionIDs: () => string[]
  selection: () => string | null
  setSelection: (id: string) => void
  selectSession: (id: string) => void
  requestChatFocus: () => void
  worktreeSessionIds: () => Set<string>
  managedSessions: () => { id: string; worktreeId?: string | null }[]
  selectWorktree: (id: string) => void
  setReviewActive: (active: boolean) => void
  openLocally: (id: string) => void
}) {
  return (id: string) => {
    if (deps.addSessionToCurrentWorktree(id)) return
    if (deps.localSessionIDs().includes(id)) {
      deps.selectSession(id)
      if (deps.selection() === null) deps.setSelection(LOCAL)
      deps.requestChatFocus()
      return
    }
    if (!deps.worktreeSessionIds().has(id)) return deps.openLocally(id)
    const worktree = deps.managedSessions().find((item) => item.id === id)?.worktreeId
    if (!worktree) return deps.openLocally(id)
    deps.selectWorktree(worktree)
    deps.selectSession(id)
    deps.setReviewActive(false)
    deps.requestChatFocus()
  }
}
// fork_change end

// fork_change start - open a root session locally without expanding the sidebar
export function openLocalSession(input: {
  id: string
  sessions: Parameters<typeof canOpenRootSession>[1]
  saveTabMemory: () => void
  activePendingId: () => string | undefined
  currentSessionID: () => string | undefined
  placeLocal: (id: string, pending: string | undefined, active: string | undefined) => void
  setSelection: (id: typeof LOCAL) => void
  setReviewActive: (active: boolean) => void
  selectSession: (id: string) => void
  requestChatFocus: () => void
  post: (msg: WebviewMessage) => void
}): void {
  if (!canOpenRootSession(input.id, input.sessions)) return
  input.saveTabMemory()
  const pending = input.activePendingId()
  input.placeLocal(input.id, pending, pending ?? input.currentSessionID())
  input.setSelection(LOCAL)
  input.setReviewActive(false)
  input.selectSession(input.id)
  input.requestChatFocus()
  input.post({ type: "agentManager.openLocally", sessionId: input.id })
}
// fork_change end

/** Select the Local context: restore its remembered tab or fall back to the first session/draft. */
export function selectLocalAction<T extends SessionLike>(
  deps: SelectionActionDeps<T>,
  locals: T[],
  ids: string[] = [],
): void {
  deps.saveTabMemory()
  deps.post({ type: "agentManager.requestRepoInfo" })
  const remembered = deps.tabMemory()[LOCAL]
  const backing = deps.isReviewTab(remembered, LOCAL) ? deps.sessionMemory?.(LOCAL) : remembered
  batch(() => {
    deps.setReviewActive(false)
    deps.setSelection(LOCAL)
    const id = terminal(deps, LOCAL, remembered, locals.length === 0 && ids.length === 0)
    if (id) {
      deps.activateTerminal(id)
      return
    }
    deps.terms.setActiveId(undefined)
    const real = locals.filter((item) => !deps.isPending(item.id))
    const target = backing ? real.find((s) => s.id === backing) : undefined
    const draft = locals.find((item) => item.id === backing && deps.isPending(item.id))?.id
    const fallback =
      target?.id ??
      draft ??
      (backing && ids.includes(backing) ? backing : undefined) ??
      real[0]?.id ??
      ids[0] ??
      locals.find((item) => deps.isPending(item.id))?.id
    if (fallback && !deps.isPending(fallback)) {
      deps.setActivePendingId(undefined)
      deps.focusLocal(fallback)
    } else {
      deps.setActivePendingId(fallback && deps.isPending(fallback) ? fallback : undefined)
      deps.clearSession()
      deps.post({ type: "agentManager.showExistingLocalTerminal" })
    }
    deps.setReviewActive(deps.isReviewTab(remembered, LOCAL))
  })
}

/** Select a worktree: restore its remembered tab or fall back to its first session. */
export function selectWorktreeAction<T extends SessionLike>(
  deps: SelectionActionDeps<T>,
  worktreeId: string,
  sessions: T[],
  ids: string[] = [],
): void {
  deps.saveTabMemory()
  const remembered = deps.tabMemory()[worktreeId]
  batch(() => {
    deps.setSelection(worktreeId)
    const id = terminal(deps, worktreeId, remembered, sessions.length === 0 && ids.length === 0)
    if (id) {
      deps.activateTerminal(id)
      return
    }
    deps.terms.setActiveId(undefined)
    const backing = deps.isReviewTab(remembered, worktreeId) ? deps.sessionMemory?.(worktreeId) : remembered
    const target = backing ? sessions.find((s) => s.id === backing) : undefined
    const fallback = target?.id ?? (backing && ids.includes(backing) ? backing : undefined) ?? sessions[0]?.id ?? ids[0]
    if (fallback) deps.selectSession(fallback)
    else deps.resetSession()
    deps.setReviewActive(deps.isReviewTab(remembered, worktreeId))
  })
}
