// fork_change - new file
type Info = {
  role?: unknown
  mode?: unknown
  summary?: unknown
}

export namespace KiloCompactionInternal {
  export function internal(info: Info) {
    return (
      info.role === "assistant" &&
      info.summary === true &&
      (info.mode === "compaction" || info.mode === "compaction-chunk")
    )
  }
}
