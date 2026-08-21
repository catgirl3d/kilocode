#!/usr/bin/env bun
// fork_change - new file

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const VSCODE_DIR = path.resolve(import.meta.dir, "..")
const UI_DIR = path.resolve(VSCODE_DIR, "../kilo-ui")
const SELF_FILE = path.resolve(import.meta.dir, "check-kilocode-change.ts")

const TARGET_DIRS = [VSCODE_DIR, UI_DIR]

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "storybook-static",
  "bin",
  ".cache",
  ".turbo",
  ".vscode-test",
  ".git",
])
const IGNORED_EXTS = new Set([".md", ".json", ".lock", ".png", ".jpg", ".svg", ".ico", ".wav", ".map", ".d.ts"])

function findFiles(dir: string): string[] {
  const result: string[] = []

  function walk(current: string) {
    let entries: string[] = []
    try {
      entries = readdirSync(current)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue
      const fullPath = path.join(current, entry)
      if (fullPath === SELF_FILE) continue

      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (stat.isFile()) {
        const ext = path.extname(entry)
        if (IGNORED_EXTS.has(ext)) continue
        if (entry === "package.json") continue
        result.push(fullPath)
      }
    }
  }

  walk(dir)
  return result
}

function checkFile(filePath: string): { line: number; text: string }[] {
  const content = readFileSync(filePath, "utf8")
  const lines = content.split(/\r?\n/)
  const violations: { line: number; text: string }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    // Ignore markdown or code doc comments with backticked `kilocode_change`
    if (line.includes("`kilocode_change`")) continue

    if (line.includes("kilocode_change")) {
      violations.push({ line: i + 1, text: line.trim() })
    }
  }

  return violations
}

function main() {
  console.log("🔍 Checking for forbidden 'kilocode_change' in kilo-vscode and kilo-ui...\n")

  let totalFiles = 0
  let totalViolations = 0
  const filesWithViolations: { file: string; violations: { line: number; text: string }[] }[] = []

  for (const dir of TARGET_DIRS) {
    const files = findFiles(dir)
    totalFiles += files.length

    for (const file of files) {
      const violations = checkFile(file)
      if (violations.length > 0) {
        totalViolations += violations.length
        filesWithViolations.push({ file, violations })
      }
    }
  }

  if (filesWithViolations.length > 0) {
    console.error(
      `❌ Found ${totalViolations} forbidden 'kilocode_change' occurrences in ${filesWithViolations.length} files:\n`,
    )
    for (const { file, violations } of filesWithViolations) {
      const relPath = path.relative(path.resolve(VSCODE_DIR, "../.."), file).replaceAll("\\", "/")
      console.error(`📁 ${relPath}:`)
      for (const v of violations) {
        console.error(`   L${v.line}: ${v.text}`)
      }
      console.error("")
    }
    console.error("💡 In kilo-vscode and kilo-ui, use 'fork_change' instead of 'kilocode_change'.\n")
    process.exit(1)
  }

  console.log(`✅ Clean! Scanned ${totalFiles} files in kilo-vscode and kilo-ui: 0 forbidden markers found.\n`)
  process.exit(0)
}

main()
