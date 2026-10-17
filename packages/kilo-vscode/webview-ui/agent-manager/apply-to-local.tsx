/** @jsxImportSource solid-js */

/**
 * Apply-to-local workflow for Agent Manager.
 *
 * Owns everything about applying a selected worktree's diff into the local
 * repo: the per-worktree apply status, the dialog's file selection state, the
 * derived memos that drive `ApplyDialog`, and the result/toast handling for
 * the backend's `applyWorktreeDiffResult` message. Extracted from
 * `AgentManagerApp.tsx` so the app component only wires the workflow in.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js" // fork_change
import { showToast } from "@kilocode/kilo-ui/toast"
import { groupApplyConflicts } from "./apply-conflicts"
import { ApplyDialog } from "./ApplyDialog"
import { composeDiffId } from "./diff-scope-state"
import { diffDataKey } from "./worktree-diffs"
import type { tracker } from "./telemetry"
import type { useDialog } from "@kilocode/kilo-ui/context/dialog"
import type { useLanguage } from "../src/context/language"
import type { useVSCode } from "../src/context/vscode"
// fork_change start - changed-files apply state and messages
import type {
  AgentManagerApplyWorktreeDiffResultMessage,
  AgentManagerSessionFilesMessage,
  WorktreeFileDiff,
} from "../src/types/messages"

type ApplyMode = "branch" | "files"
// fork_change end

interface ApplyState {
  status: AgentManagerApplyWorktreeDiffResultMessage["status"]
  message: string
  conflicts: NonNullable<AgentManagerApplyWorktreeDiffResultMessage["conflicts"]>
}

interface ApplyToLocalOptions {
  vscode: ReturnType<typeof useVSCode>
  dialog: ReturnType<typeof useDialog>
  t: ReturnType<typeof useLanguage>["t"]
  /** Current sidebar selection (LOCAL, a worktree id, or null). */
  selection: Accessor<string | null>
  /** Sentinel id for the local repo selection. */
  local: string
  worktrees: Accessor<{ id: string }[]>
  diffDatas: Accessor<Record<string, WorktreeFileDiff[]>>
  diffLoading: Accessor<boolean>
  /** Telemetry: metrics.track(name, surface, data). */
  track: ReturnType<typeof tracker>["track"]
  projectId?: Accessor<string | undefined>
}

export function createApplyToLocal(opts: ApplyToLocalOptions) {
  const { vscode, dialog, t, selection, local, worktrees, diffDatas, diffLoading } = opts

  const [applyStates, setApplyStates] = createSignal<Record<string, ApplyState>>({})
  const [applyTarget, setApplyTarget] = createSignal<string | undefined>()
  const [applySelectedFiles, setApplySelectedFiles] = createSignal<string[]>([])
  const [applySelectionTouched, setApplySelectionTouched] = createSignal(false)
  // fork_change start - changed-files apply state
  const [applyMode, setApplyMode] = createSignal<ApplyMode>("branch")
  const [applyForce, setApplyForce] = createSignal(false)
  const [sessionFiles, setSessionFiles] = createSignal<Record<string, string[]>>({})
  const [sessionLoading, setSessionLoading] = createSignal<Record<string, boolean>>({})
  const [sessionErrors, setSessionErrors] = createSignal<Record<string, string | undefined>>({})
  const requested = new Set<string>()
  // fork_change end

  const applyStateForSelection = createMemo(() => {
    const sel = selection()
    if (!sel || sel === local) return undefined
    return applyStates()[sel]
  })

  const applyBusyForSelection = createMemo(() => {
    const state = applyStateForSelection()
    if (!state) return false
    return state.status === "checking" || state.status === "applying"
  })

  // Apply diffs come from the branch-scoped diff data of the target worktree
  // (keyed by `worktreeId#branch`, matching the review surfaces).
  const applyDiffKey = createMemo(() => {
    const target = applyTarget()
    if (!target) return undefined
    return composeDiffId(target, "branch")
  })

  const applyDiffs = createMemo(() => {
    const key = applyDiffKey()
    if (!key) return [] as WorktreeFileDiff[]
    return diffDatas()[diffDataKey(opts.projectId?.(), key)] ?? ([] as WorktreeFileDiff[])
  })

  // fork_change start - changed-files list and fetch state
  const applyFiles = createMemo(() => {
    const target = applyTarget()
    if (!target) return [] as WorktreeFileDiff[]
    return (sessionFiles()[target] ?? []).map((file) => ({
      file,
      before: "",
      after: "",
      additions: 0,
      deletions: 0,
    }))
  })

  const applyItems = createMemo(() => (applyMode() === "files" ? applyFiles() : applyDiffs()))

  const applyLoading = createMemo(() => {
    if (applyMode() === "branch") return diffLoading()
    const target = applyTarget()
    return target ? (sessionLoading()[target] ?? false) : false
  })

  const applyFetchError = createMemo(() => {
    if (applyMode() === "branch") return undefined
    const target = applyTarget()
    return target ? sessionErrors()[target] : undefined
  })
  // fork_change end

  const applyStateForTarget = createMemo(() => {
    const target = applyTarget()
    if (!target) return undefined
    return applyStates()[target]
  })

  const applyBusyForTarget = createMemo(() => {
    const state = applyStateForTarget()
    if (!state) return false
    return state.status === "checking" || state.status === "applying"
  })

  const applySelectedSet = createMemo(() => new Set(applySelectedFiles()))

  const applySelectionStats = createMemo(() => {
    const set = applySelectedSet()
    const selected = applyItems().filter((diff) => set.has(diff.file)) // fork_change
    const additions = selected.reduce((sum, diff) => sum + diff.additions, 0)
    const deletions = selected.reduce((sum, diff) => sum + diff.deletions, 0)
    return {
      total: applyItems().length, // fork_change
      selected: selected.length,
      additions,
      deletions,
    }
  })

  const applyHasSelection = createMemo(() => applySelectionStats().selected > 0)

  const applyConflictRows = createMemo(() => groupApplyConflicts(applyStateForTarget()?.conflicts ?? []))

  // fork_change start - changed-files clear action
  const clearApplyResult = () => {
    const target = applyTarget()
    setApplyForce(false)
    if (!target) return
    setApplyStates((prev) => {
      if (!prev[target]) return prev
      const next = { ...prev }
      delete next[target]
      return next
    })
  }
  // fork_change end

  // fork_change start - changed-files request action
  const requestSessionFiles = (worktreeId: string) => {
    if (requested.has(worktreeId)) return
    requested.add(worktreeId)
    setSessionLoading((prev) => ({ ...prev, [worktreeId]: true }))
    setSessionErrors((prev) => ({ ...prev, [worktreeId]: undefined }))
    vscode.postMessage({ type: "agentManager.requestSessionFiles", projectId: opts.projectId?.(), worktreeId })
  }
  // fork_change end

  // fork_change start - apply mode signature
  const applyToLocal = (worktreeId: string, selectedFiles: string[], mode: ApplyMode, force: boolean) => {
    // fork_change end
    setApplyStates((prev) => ({
      ...prev,
      [worktreeId]: {
        status: "checking",
        message: t("agentManager.apply.checking"),
        conflicts: [],
      },
    }))
    // fork_change start - changed-files apply request
    if (mode === "files") {
      vscode.postMessage({
        type: "agentManager.copySessionFiles",
        projectId: opts.projectId?.(),
        worktreeId,
        files: selectedFiles,
        force,
      })
      return
    }
    // fork_change end
    vscode.postMessage({
      type: "agentManager.applyWorktreeDiff",
      projectId: opts.projectId?.(),
      worktreeId,
      selectedFiles,
    })
  }

  const resetApplyDialog = () => {
    setApplyTarget(undefined)
    setApplySelectedFiles([])
    setApplySelectionTouched(false)
    // fork_change start - reset changed-files mode
    setApplyMode("branch")
    setApplyForce(false)
    // fork_change end
  }

  const closeApplyDialog = () => {
    resetApplyDialog()
    dialog.close()
  }

  const applySelectAll = () => {
    clearApplyResult() // fork_change
    setApplySelectionTouched(true)
    setApplySelectedFiles(applyItems().map((diff) => diff.file)) // fork_change
  }

  const applySelectNone = () => {
    clearApplyResult() // fork_change
    setApplySelectionTouched(true)
    setApplySelectedFiles([])
  }

  const applyToggleFile = (file: string, checked: boolean) => {
    clearApplyResult() // fork_change
    setApplySelectionTouched(true)
    setApplySelectedFiles((prev) => {
      if (checked) {
        if (prev.includes(file)) return prev
        const set = new Set(prev)
        set.add(file)
        // fork_change start - keep file selection in current mode
        return applyItems()
          .map((diff) => diff.file)
          .filter((path) => set.has(path))
        // fork_change end
      }
      if (!prev.includes(file)) return prev
      return prev.filter((path) => path !== file)
    })
  }

  const triggerApply = () => {
    const target = applyTarget()
    if (!target) return
    if (!applyHasSelection()) return
    if (applyBusyForTarget()) return
    // fork_change start - changed-files apply mode
    const mode = applyMode()
    const force = mode === "files" && applyForce()
    opts.track("apply_to_local", "apply_dialog", { fileCount: applySelectedFiles().length, mode })
    applyToLocal(target, applySelectedFiles(), mode, force)
    // fork_change end
  } // fork_change

  // fork_change start - changed-files mode selection
  const changeMode = (mode: ApplyMode) => {
    if (mode === applyMode()) return
    clearApplyResult()
    setApplyMode(mode)
    setApplySelectionTouched(false)
    setApplySelectedFiles([])
    const target = applyTarget()
    if (mode === "files" && target) requestSessionFiles(target)
  }
  // fork_change end

  const openApplyDialog = () => {
    const sel = selection()
    if (!sel || sel === local) return
    setApplyStates((prev) => {
      if (!prev[sel]) return prev
      const next = { ...prev }
      delete next[sel]
      return next
    })
    setApplyTarget(sel)
    // fork_change start - branch diff remains the default mode
    setApplyMode("branch")
    setApplyForce(false)
    // fork_change end
    setApplySelectionTouched(false)
    setApplySelectedFiles([])
    requested.delete(sel) // fork_change
    vscode.postMessage({ type: "agentManager.requestWorktreeDiff", projectId: opts.projectId?.(), sessionId: sel })

    dialog.show(
      () => (
        <ApplyDialog
          diffs={applyItems() /* fork_change */}
          loading={applyLoading() /* fork_change */}
          fetchError={applyFetchError() /* fork_change */}
          mode={applyMode() /* fork_change */}
          force={applyForce() /* fork_change */}
          selectedFiles={applySelectedSet()}
          selectedCount={applySelectionStats().selected}
          additions={applySelectionStats().additions}
          deletions={applySelectionStats().deletions}
          busy={applyBusyForTarget()}
          hasSelection={applyHasSelection()}
          status={applyStateForTarget()?.status}
          message={applyStateForTarget()?.message}
          conflictRows={applyConflictRows()}
          onModeChange={changeMode /* fork_change */}
          onSelectAll={applySelectAll}
          onSelectNone={applySelectNone}
          onToggleFile={applyToggleFile}
          onApply={triggerApply}
          onClose={closeApplyDialog}
        />
      ),
      resetApplyDialog,
    )
  }

  // Keep the dialog selection in step with the diff set: select everything on
  // first load, then drop files that disappear from the diff without clobbering
  // a selection the user has already made.
  createEffect(
    on(
      () => [applyTarget(), applyItems(), applySelectionTouched()] as const, // fork_change
      ([target, diffs, touched]) => {
        if (!target) return
        const files = diffs.map((diff) => diff.file)
        if (files.length === 0) {
          if (!touched) setApplySelectedFiles([])
          return
        }

        if (!touched) {
          setApplySelectedFiles(files)
          return
        }

        const current = applySelectedFiles()
        const set = new Set(current)
        const next = files.filter((file) => set.has(file))
        const same = next.length === current.length && next.every((file, index) => file === current[index])
        if (!same) setApplySelectedFiles(next)
      },
    ),
  )

  // Drop apply state for worktrees that no longer exist, and close a dialog
  // whose target disappeared.
  createEffect(() => {
    const ids = new Set(worktrees().map((wt) => wt.id))
    setApplyStates((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)))
      if (Object.keys(next).length === Object.keys(prev).length) return prev
      return next
    })

    const target = applyTarget()
    if (target && !ids.has(target)) closeApplyDialog()
  })

  // Backend `applyWorktreeDiffResult` message: record the new status and toast.
  const onApplyResult = (ev: AgentManagerApplyWorktreeDiffResultMessage) => {
    const files = new Set((ev.conflicts ?? []).map((entry) => entry.file).filter(Boolean)).size
    const count = ev.conflicts?.length ?? 0
    setApplyStates((prev) => ({
      ...prev,
      [ev.worktreeId]: {
        status: ev.status,
        message: ev.message,
        conflicts: ev.conflicts ?? [],
      },
    }))
    if (ev.status === "conflict" && applyMode() === "files" && applyTarget() === ev.worktreeId) setApplyForce(true) // fork_change

    if (ev.status === "success") {
      showToast({ variant: "success", title: t("agentManager.apply.success"), description: ev.message })
      if (applyTarget() === ev.worktreeId) closeApplyDialog()
    }
    if (ev.status === "conflict") {
      const summary =
        count > 0 ? t("agentManager.apply.conflictToast", { count, files: Math.max(files, 1) }) : ev.message
      showToast({ variant: "error", title: t("agentManager.apply.conflict"), description: summary })
    }
    if (ev.status === "error") {
      showToast({ variant: "error", title: t("agentManager.apply.error"), description: ev.message })
    }
  }

  // fork_change start - changed-files response subscription
  const onSessionFiles = (ev: AgentManagerSessionFilesMessage) => {
    if (ev.projectId !== opts.projectId?.() || ev.worktreeId !== applyTarget()) return
    setSessionLoading((prev) => ({ ...prev, [ev.worktreeId]: false }))
    setSessionErrors((prev) => ({ ...prev, [ev.worktreeId]: ev.error }))
    setSessionFiles((prev) => ({ ...prev, [ev.worktreeId]: ev.files }))
    if (ev.error) requested.delete(ev.worktreeId)
  }

  onCleanup(
    vscode.onMessage((message) => {
      if (message.type === "agentManager.sessionFiles") onSessionFiles(message)
    }),
  )
  // fork_change end

  return {
    applyStateForSelection,
    applyBusyForSelection,
    openApplyDialog,
    onApplyResult,
  }
}
