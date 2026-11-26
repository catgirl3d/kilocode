import friendlyWords from "friendly-words"
import { sanitizeBranchName } from "../shared/branch-slug"

export { sanitizeBranchName }

const MAX_ATTEMPTS = 10
const FALLBACK_MAX_SUFFIX = 100

// fork_change start - trim generated names on a word boundary
function trim(value: string, limit: number) {
  if (value.length <= limit) return value
  const cut = value.slice(0, Math.max(0, limit))
  const at = cut.lastIndexOf("-")
  return (at > 0 ? cut.slice(0, at) : cut).replace(/-+$/g, "")
}
// fork_change end

export function semanticBranchName(title: string, prefix = "", maxLength = 50): string {
  // fork_change start - reject a pasted link
  if (title.includes("://") || /^(?:https?|ftp)[-:]/.test(title) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(title))
    return ""
  // fork_change end
  const parts = prefix
    .split("/")
    .map((part) => sanitizeBranchName(part))
    .filter(Boolean)
  const head = parts.length > 0 ? `${parts.join("/")}/` : ""
  // fork_change start - keep the generated type and let a configured prefix replace it
  const at = title.indexOf("/")
  const typed = at > 0 && at === title.lastIndexOf("/")
  const type = typed ? sanitizeBranchName(title.slice(0, at)) : ""
  const body = typed ? title.slice(at + 1) : title
  const lead = head || (type ? `${type}/` : "")
  const slug = trim(sanitizeBranchName(body, body.length), Math.max(0, maxLength - lead.length))
  return slug ? `${lead}${slug}` : ""
  // fork_change end
}

/**
 * Generate a natural two-word branch name (e.g. "ambitious-keyboard") using
 * the friendly-words package.  Checks `existingBranches` to avoid collisions,
 * falling back to a numeric suffix and ultimately a timestamp.
 */
export function generateBranchName(_prompt: string, existingBranches: string[] = []): string {
  const predicates = friendlyWords.predicates as string[]
  const objects = friendlyWords.objects as string[]
  const existing = new Set(existingBranches.map((b) => b.toLowerCase()))

  const random = () => {
    const predicate = predicates[Math.floor(Math.random() * predicates.length)]
    const object = objects[Math.floor(Math.random() * objects.length)]
    return `${predicate}-${object}`
  }

  // Try up to MAX_ATTEMPTS unique two-word combos
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = random()
    if (!existing.has(candidate)) return candidate
  }

  // Append numeric suffix 0–99
  const base = random()
  for (let n = 0; n < FALLBACK_MAX_SUFFIX; n++) {
    const candidate = `${base}-${n}`
    if (!existing.has(candidate)) return candidate
  }

  // Last resort: timestamp
  return `${base}-${Date.now()}`
}

/**
 * Compute the branch name and display label for a version in a multi-version group.
 * Returns undefined values when no custom name is provided (falls back to auto-generated).
 */
export function versionedName(
  base: string | undefined,
  index: number,
  total: number,
): { branch: string | undefined; label: string | undefined } {
  if (!base) return { branch: undefined, label: undefined }
  if (total > 1 && index > 0) {
    return {
      branch: `${base}_v${index + 1}`,
      label: `${base} v${index + 1}`,
    }
  }
  return { branch: base, label: base }
}
