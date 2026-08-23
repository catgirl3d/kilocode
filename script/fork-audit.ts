#!/usr/bin/env bun
/**
 * ==============================================================================
 * 🔍 FORK AUDIT SCANNER (script/fork-audit.ts)
 * ==============================================================================
 *
 * Automated verification tool for Kilo Code personal fork annotations.
 * Compares repository modifications against upstream and ensures marker
 * coverage, balance, and layer compliance with zero false positives.
 *
 * 📌 USAGE:
 *   bun run script/fork-audit.ts [options] [paths...]
 *
 * 🎯 EXAMPLES:
 *   bun run script/fork-audit.ts                       # Audit committed history (upstream/main...HEAD)
 *   bun run script/fork-audit.ts --worktree            # Audit current uncommitted / staged working tree
 *   bun run script/fork-audit.ts path/to/file.ts       # Audit specific file in committed history
 *   bun run script/fork-audit.ts --worktree packages/  # Audit specific folder on working tree
 *   bun run script/fork-audit.ts --base=origin/main    # Audit against custom base branch
 *
 * 🛡️ LAYER RULES:
 *   1. Kilo-Exclusive Layer (packages/kilo-vscode, packages/kilo-ui):
 *      - MUST use `// fork_change` (or `// fork_change - new file` on Line 1 of new files)
 *      - NEVER use `// kilocode_change` (forbidden by CI check-kilocode-change)
 *   2. Shared OpenCode Layer (packages/core, packages/tui, packages/opencode/src outside kilocode/):
 *      - MUST use `// kilocode_change` (or `// kilocode_change - new file` on Line 1 of new files)
 *      - NEVER use `// fork_change`
 *   3. Kilo Backend (packages/opencode/src/kilocode, packages/kilo-gateway, packages/kilo-memory):
 *      - Both `fork_change` and historical `kilocode_change` are permitted.
 *      - New files use `// fork_change - new file` (or `// kilocode_change - new file`).
 *   4. Tests (test/, tests/, *.test.ts, *.spec.ts) & Docs/Configs:
 *      - Exempt from inner markers per repository cleanliness conventions (AGENTS.md:221).
 *
 * 🚦 EXIT CODES:
 *   0 = Clean, all changes annotated and valid.
 *   1 = Missing annotations or marker errors detected.
 * ==============================================================================
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
🔍 KILO CODE FORK AUDIT TOOL

Usage:
  bun run script/fork-audit.ts [options] [paths...]

Options:
  --worktree           Audit dirty working tree + uncommitted/staged files against base
  --base=<ref>         Target upstream base reference (default: 'upstream/main')
  --help, -h           Show this help message

Examples:
  bun run script/fork-audit.ts
  bun run script/fork-audit.ts --worktree
  bun run script/fork-audit.ts packages/kilo-vscode/src/KiloProvider.ts
  bun run script/fork-audit.ts --worktree packages/kilo-vscode/webview-ui/src/
`)
  process.exit(0)
}

const baseArg = args.find((a) => a.startsWith("--base="))
const base: string = (baseArg ? baseArg.split("=")[1] : undefined) || "upstream/main"
const worktree = args.includes("--worktree")
const targetRef = worktree ? base : `${base}...HEAD`
const fileArgs = args.filter((a) => !a.startsWith("--"))

function runGit(cmdArgs: string[]): string {
  const res = spawnSync("git", cmdArgs, { cwd: ROOT, encoding: "utf8" })
  if (res.status !== 0) {
    const err = res.stderr?.trim() || res.stdout?.trim() || `Exit status ${res.status}`
    console.error(`❌ Fatal Git error (git ${cmdArgs.join(" ")}): ${err}`)
    process.exit(1)
  }
  return res.stdout?.trim() ?? ""
}

// Specialized helper for reading file snapshots from Git without trimming content
function runGitShow(ref: string, file: string): string | null {
  const target = `${ref}:${file}`
  const res = spawnSync("git", ["show", target], { cwd: ROOT, encoding: "utf8" })
  if (res.status !== 0) {
    const err = res.stderr?.trim() || ""
    // Path legitimately not found in the given commit snapshot
    if (err.includes("does not exist in") || err.includes("exists on disk, but not in")) {
      return null
    }
    console.error(`❌ Fatal Git error (git show ${target}): ${err || `Exit status ${res.status}`}`)
    process.exit(1)
  }
  return res.stdout ?? ""
}

// Validate base reference
const verify = spawnSync("git", ["rev-parse", "--verify", base], { cwd: ROOT, encoding: "utf8" })
if (verify.status !== 0) {
  if (process.env.CI || !baseArg) {
    console.warn(`⚠️ Base reference '${base}' not found in Git repository. Skipping fork audit.`)
    process.exit(0)
  }
  console.error(`❌ Base reference '${base}' not found in Git repository. Check remotes or use --base=<ref>.`)
  process.exit(1)
}

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh", ".bash", ".yml", ".yaml", ".toml"])

function isIgnored(file: string): boolean {
  const norm = file.replaceAll("\\", "/")
  const basename = path.basename(norm)

  // Direct ignored filenames
  if (
    basename.endsWith(".md") ||
    basename.endsWith(".json") ||
    basename.endsWith(".lock") ||
    basename.endsWith(".lockb")
  )
    return true
  if (basename.endsWith(".css") || basename.endsWith(".scss") || basename.endsWith(".less")) return true
  if (
    basename.endsWith(".png") ||
    basename.endsWith(".jpg") ||
    basename.endsWith(".svg") ||
    basename.endsWith(".ico") ||
    basename.endsWith(".wav")
  )
    return true

  // Ignored directory paths
  if (
    norm.startsWith(".changeset/") ||
    norm.startsWith(".husky/") ||
    norm.startsWith(".github/") ||
    norm.startsWith(".vscode/")
  )
    return true
  if (norm.startsWith(".turbo/") || norm.startsWith(".artifacts/")) return true
  if (norm.startsWith("script/")) return true
  if (norm.startsWith("packages/kilo-docs/")) return true
  if (
    norm.includes("/dist/") ||
    norm.startsWith("dist/") ||
    norm.includes("/out/") ||
    norm.startsWith("out/") ||
    norm.includes("/gen/")
  )
    return true
  if (norm.includes("i18n/")) return true
  if (norm.includes(".stories.") || norm.includes(".test.") || norm.includes(".spec.")) return true
  if (
    norm.includes("/test/") ||
    norm.includes("/tests/") ||
    norm.includes("/fixture/") ||
    norm.includes("__snapshots__/")
  )
    return true

  const ext = path.extname(norm)
  if (ext && !SOURCE_EXTS.has(ext)) return true

  return false
}

type FileZone = "kilo_exclusive" | "shared_opencode" | "kilo_backend"

function getFileZone(file: string): FileZone {
  const norm = file.replaceAll("\\", "/")

  // Zone 1: Kilo-Exclusive packages (VS Code extension and Kilo Solid UI library)
  // CI runs check-kilocode-change here: kilocode_change is strictly FORBIDDEN.
  if (norm.startsWith("packages/kilo-vscode/") || norm.startsWith("packages/kilo-ui/")) {
    return "kilo_exclusive"
  }

  // Zone 3: Kilo backend / tooling additions (any folder starting with "kilo-" or containing "kilocode")
  // e.g. kilo-gateway, kilo-memory, kilo-jetbrains, kilo-i18n, kilo-telemetry, kilo-sandbox, opencode/src/kilocode
  const parts = norm.split("/")
  if (parts.some((p) => p.startsWith("kilo-") || p.includes("kilocode"))) {
    return "kilo_backend"
  }

  // Zone 2: Shared OpenCode packages (upstream engine: core, opencode/src, tui, sdk, schema, util, etc.)
  // CI runs check-opencode-annotations here: kilocode_change is REQUIRED, fork_change is forbidden.
  return "shared_opencode"
}

type StackEntry = {
  type: "fork" | "kilo"
  line: number
}

// Regex definitions supporting //, /* ... */, and # comment styles
const FORK_INLINE = /(?:\/\/|\{?\s*\/\*|#)\s*fork_change(?!\s*(?:start|end|-))\b/
const FORK_START = /(?:\/\/|\{?\s*\/\*|#)\s*fork_change\s+start\b/
const FORK_END = /(?:\/\/|\{?\s*\/\*|#)\s*fork_change\s+end\b/
const FORK_NEW_FILE = /(?:\/\/|\{?\s*\/\*|#)\s*fork_change\s*-\s*new\s*file\b/

const KILO_INLINE = /(?:\/\/|\{?\s*\/\*|#)\s*kilocode_change(?!\s*(?:start|end|-))\b/
const KILO_START = /(?:\/\/|\{?\s*\/\*|#)\s*kilocode_change\s+start\b/
const KILO_END = /(?:\/\/|\{?\s*\/\*|#)\s*kilocode_change\s+end\b/
const KILO_NEW_FILE = /(?:\/\/|\{?\s*\/\*|#)\s*kilocode_change\s*-\s*new\s*file\b/

type MarkerBlock = {
  type: "inline" | "block" | "whole_file"
  startLine: number
  endLine: number
  markerType: "fork" | "kilo"
}

function parseCoveredRanges(
  fileLines: string[],
  zone: FileZone,
): {
  coveredLines: Set<number>
  markers: MarkerBlock[]
  errors: string[]
  wholeFileMarkerLine: number
} {
  const coveredLines = new Set<number>()
  const markers: MarkerBlock[] = []
  const errors: string[] = []

  let wholeFileMarkerLine = -1

  // Check whole-file annotation
  const firstNonEmptyIdx = fileLines.findIndex((l) => l.trim() !== "" && !l.startsWith("#!"))
  if (firstNonEmptyIdx !== -1) {
    const firstLine = fileLines[firstNonEmptyIdx] ?? ""
    const lineNum = firstNonEmptyIdx + 1

    if (FORK_NEW_FILE.test(firstLine)) {
      wholeFileMarkerLine = lineNum
      markers.push({ type: "whole_file", startLine: lineNum, endLine: fileLines.length, markerType: "fork" })
      if (zone === "shared_opencode") {
        errors.push(
          `Line ${lineNum}: forbidden 'fork_change - new file' in shared OpenCode file (must use 'kilocode_change - new file')`,
        )
      } else {
        for (let i = 1; i <= fileLines.length; i++) coveredLines.add(i)
      }
    } else if (KILO_NEW_FILE.test(firstLine)) {
      wholeFileMarkerLine = lineNum
      markers.push({ type: "whole_file", startLine: lineNum, endLine: fileLines.length, markerType: "kilo" })
      if (zone === "kilo_exclusive") {
        errors.push(
          `Line ${lineNum}: forbidden 'kilocode_change - new file' in Kilo-exclusive layer (must use 'fork_change - new file')`,
        )
      } else {
        for (let i = 1; i <= fileLines.length; i++) coveredLines.add(i)
      }
    }
  }

  const stack: StackEntry[] = []

  for (let i = 0; i < fileLines.length; i++) {
    const lineNum = i + 1
    if (lineNum === wholeFileMarkerLine) continue

    const line = fileLines[i] ?? ""

    // Rule 1: Kilo-exclusive layer (kilo-vscode, kilo-ui) must NEVER contain kilocode_change
    if (zone === "kilo_exclusive" && /(?:\/\/|\{?\s*\/\*|#)\s*kilocode_change\b/.test(line)) {
      errors.push(`Line ${lineNum}: forbidden 'kilocode_change' in Kilo-exclusive layer (must use 'fork_change')`)
    }

    // Rule 2: Shared OpenCode files must NEVER contain fork_change
    if (zone === "shared_opencode" && /(?:\/\/|\{?\s*\/\*|#)\s*fork_change\b/.test(line)) {
      errors.push(`Line ${lineNum}: forbidden 'fork_change' in shared OpenCode file (must use 'kilocode_change')`)
    }

    // Inline marker check
    const isForkInline = FORK_INLINE.test(line)
    const isKiloInline = KILO_INLINE.test(line)

    if (isForkInline || isKiloInline) {
      const markerType = isForkInline ? "fork" : "kilo"
      markers.push({ type: "inline", startLine: lineNum, endLine: lineNum, markerType })
    }

    if (zone === "kilo_exclusive" && isForkInline) coveredLines.add(lineNum)
    if (zone === "shared_opencode" && isKiloInline) coveredLines.add(lineNum)
    if (zone === "kilo_backend" && (isForkInline || isKiloInline)) coveredLines.add(lineNum)

    // Block start check (nested blocks of the same/active type are valid)
    const isForkStart = FORK_START.test(line)
    const isKiloStart = KILO_START.test(line)

    if (isForkStart || isKiloStart) {
      const type = isForkStart ? "fork" : "kilo"
      stack.push({ type, line: lineNum })
      coveredLines.add(lineNum)
      continue
    }

    // Block end check
    const isForkEnd = FORK_END.test(line)
    const isKiloEnd = KILO_END.test(line)

    if (isForkEnd || isKiloEnd) {
      const endType = isForkEnd ? "fork" : "kilo"
      const endLabel = endType === "fork" ? "fork_change end" : "kilocode_change end"

      if (stack.length === 0) {
        errors.push(`Line ${lineNum}: '${endLabel}' without an active start block`)
      } else {
        const top = stack.pop()!
        const topLabel = top.type === "fork" ? "fork_change start" : "kilocode_change start"
        if (top.type !== endType) {
          errors.push(
            `Line ${lineNum}: marker type mismatch: '${endLabel}' closed a '${topLabel}' block (from line ${top.line})`,
          )
        }
        markers.push({ type: "block", startLine: top.line, endLine: lineNum, markerType: endType })
        coveredLines.add(lineNum)
      }
      continue
    }

    if (stack.length > 0) {
      coveredLines.add(lineNum)
    }
  }

  // Check unclosed blocks
  while (stack.length > 0) {
    const unclosed = stack.pop()!
    const label = unclosed.type === "fork" ? "fork_change start" : "kilocode_change start"
    errors.push(`Line ${unclosed.line}: unclosed '${label}' block at end of file`)
  }

  return { coveredLines, markers, errors, wholeFileMarkerLine }
}

type HunkBlock = {
  startLine: number
  endLine: number
  lines: string[]
  isCovered: boolean
}

type RedundantMarker = {
  startLine: number
  endLine: number
  lines: string[]
}

type FileAudit = {
  file: string
  totalAddedLines: number
  coveredAddedLines: number
  blocks: HunkBlock[]
  redundantMarkers: RedundantMarker[]
  errors: string[]
}

function auditFile(file: string, isNew: boolean): FileAudit | null {
  const absPath = path.join(ROOT, file)
  const zone = getFileZone(file)

  let content: string | null = ""
  if (worktree) {
    if (!existsSync(absPath)) return null
    content = readFileSync(absPath, "utf8")
  } else {
    content = runGitShow("HEAD", file)
  }

  if (!content) return null

  const rawLines = content.split(/\r?\n/)
  // Trim trailing empty line to avoid 0/N+1 line drift
  const fileLines = content.endsWith("\n") ? rawLines.slice(0, -1) : rawLines

  const { coveredLines, markers, errors } = parseCoveredRanges(fileLines, zone)

  const diffOut = !isNew ? runGit(["diff", "--unified=0", "--diff-filter=AMRT", targetRef, "--", file]) : ""
  if (!diffOut && !isNew && errors.length === 0) return null

  const addedLines: number[] = []

  if (isNew) {
    for (let i = 1; i <= fileLines.length; i++) addedLines.push(i)
  } else if (diffOut) {
    const diffLines = diffOut.split("\n")
    let i = 0
    while (i < diffLines.length) {
      const header = diffLines[i] ?? ""
      const m = header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      if (!m) {
        i++
        continue
      }

      const start = Number(m[1] ?? 0)
      let pos = 0
      let j = i + 1
      while (j < diffLines.length) {
        const hl = diffLines[j] ?? ""
        if (hl.startsWith("@@") || hl.startsWith("diff ")) break
        if (hl.startsWith("+") && !hl.startsWith("+++")) {
          addedLines.push(start + pos)
          pos++
        }
        j++
      }
      i = j
    }
  }

  if (addedLines.length === 0 && errors.length === 0 && markers.length === 0) return null

  // Check redundant markers (markers covering code identical to upstream)
  const addedLinesSet = new Set(addedLines)
  const redundantMarkers: RedundantMarker[] = []

  if (!isNew) {
    for (const m of markers) {
      if (m.type === "whole_file") {
        // A historical whole-file marker that is unchanged from the selected
        // base belongs to the upstream Kilo layer, not to this fork.
        if (!addedLinesSet.has(m.startLine)) continue
        errors.push(`Line ${m.startLine}: whole-file marker added to an existing upstream file`)
        continue
      }

      // Only fork_change markers represent our personal fork's deltas against Kilo Code.
      // (kilocode_change markers belong to Kilo Code upstream against OpenCode).
      if (m.markerType !== "fork") continue

      let hasSubstantiveChange = false
      for (let ln = m.startLine; ln <= m.endLine; ln++) {
        if (addedLinesSet.has(ln)) {
          const lineStr = fileLines[ln - 1] ?? ""
          const isMarkerCommentOnly =
            FORK_START.test(lineStr) ||
            FORK_END.test(lineStr) ||
            (m.type === "inline" && FORK_INLINE.test(lineStr) && lineStr.replace(FORK_INLINE, "").trim() === "")

          if (!isMarkerCommentOnly) {
            hasSubstantiveChange = true
            break
          }
        }
      }

      if (!hasSubstantiveChange) {
        redundantMarkers.push({
          startLine: m.startLine,
          endLine: m.endLine,
          lines: fileLines.slice(m.startLine - 1, m.endLine),
        })
      }
    }
  }

  // Group contiguous added lines into blocks
  const blocks: HunkBlock[] = []
  let currentGroup: number[] = []

  for (const lineNum of addedLines) {
    if (currentGroup.length === 0) {
      currentGroup.push(lineNum)
    } else {
      const last = currentGroup[currentGroup.length - 1] ?? 0
      if (lineNum === last + 1) {
        currentGroup.push(lineNum)
      } else {
        const startLine = currentGroup[0] ?? 0
        const endLine = currentGroup[currentGroup.length - 1] ?? 0
        const isCovered = currentGroup.every((ln) => coveredLines.has(ln))
        blocks.push({
          startLine,
          endLine,
          lines: fileLines.slice(startLine - 1, endLine),
          isCovered,
        })
        currentGroup = [lineNum]
      }
    }
  }

  if (currentGroup.length > 0) {
    const startLine = currentGroup[0] ?? 0
    const endLine = currentGroup[currentGroup.length - 1] ?? 0
    const isCovered = currentGroup.every((ln) => coveredLines.has(ln))
    blocks.push({
      startLine,
      endLine,
      lines: fileLines.slice(startLine - 1, endLine),
      isCovered,
    })
  }

  const totalAddedLines = addedLines.length
  const coveredAddedLines = addedLines.filter((ln) => coveredLines.has(ln)).length

  return {
    file,
    totalAddedLines,
    coveredAddedLines,
    blocks,
    redundantMarkers,
    errors,
  }
}

function main() {
  const modeLabel = worktree ? `working tree & uncommitted changes (${targetRef})` : `committed history (${targetRef})`
  console.log(`🔍 Scanning fork modifications against: ${modeLabel}...\n`)

  const diffFilesOut = runGit(["diff", "--name-only", "--diff-filter=AMRT", targetRef])
  const diffFilesList = diffFilesOut.split("\n").filter(Boolean)
  const untrackedOut = worktree ? runGit(["ls-files", "--others", "--exclude-standard"]) : ""

  let forkMarkerFiles: string[] = []
  if (base !== "HEAD" && !targetRef.endsWith("HEAD...HEAD")) {
    try {
      const grepRes = spawnSync("git", ["grep", "-l", "fork_change"], { cwd: ROOT, encoding: "utf8" })
      if (grepRes.status === 0) {
        forkMarkerFiles = (grepRes.stdout?.trim() ?? "").split("\n").filter(Boolean)
      }
    } catch {
      // fallback
    }
  }

  const allFiles = [...new Set([...diffFilesList, ...forkMarkerFiles, ...untrackedOut.split("\n")])].filter(Boolean)
  let targetFiles = allFiles.filter((f) => !isIgnored(f))

  if (fileArgs.length > 0) {
    const normalizedArgs = fileArgs.map((f) => path.relative(ROOT, path.resolve(ROOT, f)).replaceAll("\\", "/"))
    targetFiles = targetFiles.filter(
      (f) => normalizedArgs.includes(f) || normalizedArgs.some((arg) => f.startsWith(arg)),
    )

    if (targetFiles.length === 0) {
      console.log(`✨ No fork modifications found in specified path(s) against ${modeLabel}.\n`)
      process.exit(0)
    }
  }

  const newFilesOut = runGit(["diff", "--name-only", "--diff-filter=A", targetRef])
  const newFilesSet = new Set([...newFilesOut.split("\n"), ...untrackedOut.split("\n")].filter(Boolean))

  const results: FileAudit[] = []

  for (const file of targetFiles) {
    const isNew = newFilesSet.has(file)
    const audit = auditFile(file, isNew)
    if (audit) {
      results.push(audit)
    }
  }

  let totalBlocks = 0
  let coveredBlocks = 0
  let missingBlocks = 0
  let totalRedundant = 0
  let totalErrors = 0
  const filesNeedingAttention: string[] = []

  for (const res of results) {
    const fileHasMissing = res.blocks.some((b) => !b.isCovered)
    const fileHasRedundant = res.redundantMarkers.length > 0
    const hasErr = res.errors.length > 0
    if (hasErr) totalErrors += res.errors.length
    if (fileHasRedundant) totalRedundant += res.redundantMarkers.length

    const icon = hasErr ? "❌" : fileHasMissing || fileHasRedundant ? "⚠️ " : "✅"
    console.log(`${icon} ${res.file} (${res.coveredAddedLines}/${res.totalAddedLines} lines covered)`)

    for (const err of res.errors) {
      console.log(`   ❌ ERROR: ${err}`)
    }

    for (const b of res.blocks) {
      totalBlocks++
      if (b.isCovered) {
        coveredBlocks++
      } else {
        missingBlocks++
        console.log(`   [MISSING] L${b.startLine}-L${b.endLine}`)
        const preview = b.lines
          .slice(0, 3)
          .map((l) => `     + ${l}`)
          .join("\n")
        console.log(preview)
        if (b.lines.length > 3) {
          console.log(`     + ... (${b.lines.length - 3} more lines)`)
        }
      }
    }

    for (const r of res.redundantMarkers) {
      console.log(`   [REDUNDANT] L${r.startLine}-L${r.endLine}: marker wraps code identical to upstream`)
      const preview = r.lines
        .slice(0, 3)
        .map((l) => `     - ${l}`)
        .join("\n")
      console.log(preview)
      if (r.lines.length > 3) {
        console.log(`     - ... (${r.lines.length - 3} more lines)`)
      }
    }

    if (fileHasMissing || fileHasRedundant || hasErr) {
      filesNeedingAttention.push(res.file)
    }
    console.log("")
  }

  console.log("==========================================")
  console.log(`📊 FORK AUDIT SUMMARY:`)
  console.log(`- Mode: ${worktree ? "Worktree (dirty / uncommitted)" : "Committed History (base...HEAD)"}`)
  console.log(`- Files audited: ${results.length}`)
  console.log(`- Total change blocks: ${totalBlocks}`)
  console.log(
    `- Annotated blocks: ${coveredBlocks} (${totalBlocks ? Math.round((coveredBlocks / totalBlocks) * 100) : 100}%)`,
  )
  console.log(`- Missing annotation blocks: ${missingBlocks}`)
  console.log(`- Redundant / stale markers: ${totalRedundant}`)
  console.log(`- Marker syntax / illegal errors: ${totalErrors}`)

  if (filesNeedingAttention.length > 0 || totalErrors > 0) {
    console.log(`\n📌 Files needing attention (${filesNeedingAttention.length}):`)
    for (const f of filesNeedingAttention) {
      console.log(`  - ${f}`)
    }
    console.log("==========================================\n")
    process.exit(1)
  } else {
    console.log("\n🎉 All fork modifications in specified files are 100% annotated and valid!")
    console.log("==========================================\n")
    process.exit(0)
  }
}

main()
