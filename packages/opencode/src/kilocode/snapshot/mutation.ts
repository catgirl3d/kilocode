// kilocode_change - new file
export namespace KiloSnapshotMutation {
  export type Input = {
    tool: string
    args: Record<string, unknown>
    shell?: "read" | "unknown"
  }

  const reads = new Set([
    "read",
    "glob",
    "grep",
    "lsp",
    "webfetch",
    "websearch",
    "codebase_search",
    "semantic_search",
    "repo_overview",
    "kilo_local_recall",
    "kilo_memory_recall",
    "notebook_read",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
  ])
  const writes = new Set(["edit", "write", "apply_patch", "interactive_terminal", "notebook_edit", "notebook_execute"])
  // These actions only inspect or manage the tracked process; start/restart and
  // task execution are intentionally not allowlisted because they can run code.
  const backgroundReads = new Set(["list", "status", "logs", "stop"])

  export function mayMutate(input: Input) {
    if (writes.has(input.tool)) return true
    if (input.tool === "background_process") {
      return typeof input.args.action !== "string" || !backgroundReads.has(input.args.action)
    }
    // A detached background task may outlive the parent turn's terminal track;
    // protecting its launch is the narrow guarantee available without a new process architecture.
    if (input.tool === "task") return true
    if (input.tool === "bash") return input.shell !== "read"
    return !reads.has(input.tool)
  }
}
