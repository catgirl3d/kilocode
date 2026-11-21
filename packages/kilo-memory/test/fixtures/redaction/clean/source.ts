// Clean corpus: values mode must return every file in this directory byte-for-byte unchanged.
// Ordinary code talks about keys, tokens, secrets, and hashes without containing a credential.

import { createHash } from "node:crypto"

export const CACHE_TTL_SECONDS = 120

export interface CacheOptions {
  token_type: "access" | "refresh"
  secret_name: string
  api_key_env: string
  max_tokens: number
}

export function cacheKey(id: string) {
  return `users:${id}`
}

export function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function describe(options: CacheOptions) {
  return { ttl: CACHE_TTL_SECONDS, scope: options.secret_name, env: options.api_key_env }
}

// tokenize keeps multi-word identifiers together; monkey patching is out of scope.
export function tokenize(input: string) {
  return input.split(/\s+/)
}
