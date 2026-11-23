export namespace MemoryRedact {
  const keys = new Set([
    "accesskey",
    "apikey",
    "auth",
    "authorization",
    "bearer",
    "clientsecret",
    "credential",
    "passphrase",
    "password",
    "privatekey",
    "secret",
    "token",
  ])
  const secret = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9_]{20,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /xox[baprs]-[A-Za-z0-9-]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
    // Assignment secrets. Shared guard: keyword boundaries (`(?<![a-z0-9])keywords?(?![a-z0-9])`) so a
    // keyword is a whole word-part — "author" no longer matches "auth", "tokenize" no longer matches
    // "token" — while `_`/`-`/`.` still act as separators so `refresh_token`/`client_secret` still match.
    //
    // (a) Any keyword (incl. ambiguous auth/authorization) with a secret-SHAPED value: quoted, or an
    //     unquoted spaceless run with entropy (>=6 chars with a digit/special, or >=16 letters). This
    //     keeps prose clean — `auth_mode=none`, "token expiry is 1h" don't trip it (see (b) for the
    //     stricter low-entropy check on the strong keyword subset).
    /["']?[\w.-]*(?<![a-z0-9])(?:password|passphrase|api[_ -]?key|secret|token|credential|authorization|auth|private[_ -]?key|access[_ -]?key)s?(?![a-z0-9])[\w.-]*["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?=[^\s,}\r\n]{6})[^\s,}\r\n]*[^A-Za-z\s,}\r\n][^\s,}\r\n]*|[A-Za-z]{16,}[^\s,}\r\n]*)/i,
    // (b) A STRONG keyword assigned with `:` or `=` redacts ANY non-empty value, catching low-entropy
    //     secrets like `password=hunterx` / `password: hunterx`. This deliberately also redacts prose
    //     like `secret: enabled` / `password: required` — favoring catching a real low-entropy
    //     colon-separated secret over avoiding that false positive. `auth` stays excluded as too
    //     ambiguous (would trip on ordinary "auth: none"-style config far more often).
    /["']?[\w.-]*(?<![a-z0-9])(?:password|passphrase|api[_ -]?key|secret|token|credential|private[_ -]?key|access[_ -]?key)s?(?![a-z0-9])[\w.-]*["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/i,
  ]
  // Loosely find URL-like spans; the parser (not this pattern) decides whether they carry credentials.
  const candidate = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

  // fork_change start - Values-mode key detection for outbound sends; the legacy rules above stay unchanged.
  /** Send-mode options. Without them the legacy memory/export rules below are unchanged. */
  export type Options = { values?: boolean }

  const MARKER = "[redacted]"
  const FAILURE_MESSAGE =
    'A secret was found in the outgoing context where it cannot be hidden safely, so the request was not sent. Roll back to a message before the key entered the context, or turn off "Redact recognizable secrets before sending" in Experimental.'

  /** A recognized key that cannot be hidden in a copy that has to keep its shape. Carries no value. */
  export class Failure extends Error {
    constructor() {
      super(FAILURE_MESSAGE)
      this.name = "MemoryRedactFailure"
    }
  }

  // Values mode is a single left-to-right scan with no greedy prefix regex, so it stays linear on a
  // solid word run. Legacy `secret` above is unchanged and may stay slow for memory/export.
  const NAME_LIMIT = 128

  function isAlnum(code: number) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  }

  function isKeyChar(code: number) {
    return isAlnum(code) || code === 95 /* _ */ || code === 45 /* - */
  }

  function isNameChar(code: number) {
    return isKeyChar(code) || code === 46 /* . */
  }

  function isSpace(code: number) {
    return code === 32 || code === 9 || code === 10 || code === 13
  }

  function lower(code: number) {
    return code >= 65 && code <= 90 ? code + 32 : code
  }

  function words(input: string, at: number, word: string) {
    if (at + word.length > input.length) return false
    for (let index = 0; index < word.length; index++) {
      if (lower(input.charCodeAt(at + index)) !== word.charCodeAt(index)) return false
    }
    return true
  }

  function credentialChar(code: number) {
    return isKeyChar(code) || code === 46 /* . */ || code === 126 /* ~ */ || code === 43 /* + */ || code === 47 /* / */ || code === 61 /* = */
  }

  // A key body after `prefix`, when at least `min` key characters follow.
  function body(input: string, at: number, prefix: string, min: number, chars = isKeyChar) {
    if (!input.startsWith(prefix, at)) return -1
    const start = at + prefix.length
    let end = start
    while (end < input.length && chars(input.charCodeAt(end))) end++
    return end - start >= min && !isKeyChar(input.charCodeAt(end)) ? end : -1
  }

  function jwtEnd(input: string, at: number) {
    if (!input.startsWith("eyJ", at)) return -1
    let index = at + 3
    for (let part = 0; part < 2; part++) {
      const start = index
      while (index < input.length && isKeyChar(input.charCodeAt(index))) index++
      if (index - start < 10 || input.charCodeAt(index) !== 46 /* . */) return -1
      index++
    }
    const start = index
    while (index < input.length && isKeyChar(input.charCodeAt(index))) index++
    return index - start >= 10 ? index : -1
  }

  // Dotted token body: SendGrid and Terraform carry a literal dot inside the credential.
  function dotted(input: string, at: number, prefix: string, min: number) {
    if (!input.startsWith(prefix, at)) return -1
    const start = at + prefix.length
    let end = start
    while (end < input.length) {
      const code = input.charCodeAt(end)
      if (!isKeyChar(code) && code !== 46 /* . */) break
      end++
    }
    return end - start >= min ? end : -1
  }

  const ATLAS = /[A-Za-z0-9_-]+\.atlasv1\.[A-Za-z0-9_=-]{16,}/g
  const EXACT = new Set(["kiloauthcontent", "servicerolekey", "supabaseservicekey", "supabaseservicerolekey"])
  const STRONG = new Set([
    "apikey",
    "secretkey",
    "accesskey",
    "privatekey",
    "clientsecret",
    "signingkey",
    "encryptionkey",
    "authtoken",
    "apitoken",
    "accesstoken",
    "refreshtoken",
    "sessiontoken",
    "token",
    "secret",
  ])
  const BLOCK = new Set(["|", ">", "|-", "|+", ">-", ">+"])
  const CHALLENGE = /^(?:realm|error|error_description|scope|state|service|client_id)=/i

  function plainName(name: string) {
    return name.replaceAll(/[_\s.-]/g, "").toLowerCase()
  }

  function exactName(name: string) {
    // Prose such as "service role key: rotate monthly" is not an assignment.
    if (/\s/.test(name)) return false
    const plain = plainName(name)
    return [...EXACT].some((word) => plain.endsWith(word))
  }

  function strongName(name: string) {
    const plain = plainName(name)
    return [...STRONG].some((word) => plain === word || plain.endsWith(word))
  }

  function lowerHex(code: number) {
    return (code >= 48 && code <= 57) || (code >= 97 && code <= 102)
  }

  // OpenCode Console keys keep a 12-hex segment before the payload.
  function ocEnd(input: string, at: number) {
    if (!input.startsWith("oc_sk_", at)) return -1
    let index = at + 6
    for (let part = 0; part < 12; part++, index++) if (!lowerHex(input.charCodeAt(index))) return -1
    if (input.charCodeAt(index) !== 95 /* _ */) return -1
    index++
    const start = index
    while (index < input.length && isKeyChar(input.charCodeAt(index))) index++
    return index - start >= 20 && !isKeyChar(input.charCodeAt(index)) ? index : -1
  }

  // AWS access-key IDs share a 20-character uppercase/digit body across these prefixes.
  function awsEnd(input: string, at: number) {
    for (const prefix of ["AKIA", "ASIA", "ABIA", "ACCA", "A3T"]) {
      if (!input.startsWith(prefix, at)) continue
      let index = at + prefix.length
      const start = index
      while (index < input.length) {
        const code = input.charCodeAt(index)
        if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90))) break
        index++
      }
      const need = prefix.length === 3 ? 17 : 16
      return index - start >= need ? index : -1
    }
    return -1
  }

  // Slack incoming webhooks are URLs, not tokens; only the exact host and a path are masked.
  function webhookEnd(input: string, at: number) {
    const prefix = "https://hooks.slack.com/"
    if (!input.startsWith(prefix, at)) return -1
    let index = at + prefix.length
    while (index < input.length) {
      const code = input.charCodeAt(index)
      if (isSpace(code) || code === 34 || code === 39 || code === 41 || code === 93 || code === 125 || code === 44 || code === 59)
        break
      index++
    }
    return index - at >= prefix.length + 12 ? index : -1
  }

  // A JSON carrier such as KILO_AUTH_CONTENT spans past the first `}`; keep the object opaque.
  function objectEnd(input: string, at: number) {
    if (input.charCodeAt(at) !== 123 /* { */) return -1
    let depth = 0
    let quote = 0
    let escape = false
    for (let index = at; index < input.length; index++) {
      const code = input.charCodeAt(index)
      if (escape) {
        escape = false
        continue
      }
      if (code === 92 /* \ */) {
        escape = true
        continue
      }
      if (quote !== 0) {
        if (code === quote) quote = 0
        continue
      }
      if (code === 34 || code === 39) {
        quote = code
        continue
      }
      if (code === 123) depth++
      if (code === 125) depth--
      if (depth === 0) return index + 1
    }
    return -1
  }

  function gitlabEnd(input: string, at: number) {
    const base = body(input, at, "glpat-", 20)
    if (base < 0) return -1
    let index = base
    for (let part = 0; part < 2 && input.charCodeAt(index) === 46 /* . */; part++) {
      const start = index + 1
      let cursor = start
      while (cursor < input.length && isAlnum(input.charCodeAt(cursor))) cursor++
      if (cursor - start < 2) break
      index = cursor
    }
    return index
  }

  function prefixEnd(input: string, at: number) {
    if (at > 0 && isKeyChar(input.charCodeAt(at - 1))) return -1
    const code = input.charCodeAt(at)
    if (code === 111 /* o */) return ocEnd(input, at)
    if (code === 119 /* w */) return body(input, at, "whsec_", 24)
    if (code === 118 /* v */) return body(input, at, "vck_", 20)
    if (code === 102 /* f */) return body(input, at, "fw_", 20)
    if (code === 97 /* a */) return body(input, at, "api_org_", 34, isAlnum)
    if (code === 115 /* s */) {
      const stripe = body(input, at, "sk_live_", 16)
      if (stripe > 0) return stripe
      const test = body(input, at, "sk_test_", 16)
      if (test > 0) return test
      const prod = body(input, at, "sk_prod_", 16)
      if (prod > 0) return prod
      const secret = body(input, at, "sb_secret_", 20)
      if (secret > 0) return secret
      for (const sentry of ["sntryu_", "sntrys_", "sntryc_", "sntryh_", "sntrya_", "sntryi_"]) {
        const found = body(input, at, sentry, 32)
        if (found > 0) return found
      }
      return body(input, at, "sk-", 20)
    }
    if (code === 114 /* r */) {
      const live = body(input, at, "rk_live_", 16)
      if (live > 0) return live
      const test = body(input, at, "rk_test_", 16)
      if (test > 0) return test
      const prod = body(input, at, "rk_prod_", 16)
      if (prod > 0) return prod
      return body(input, at, "rpa_", 20)
    }
    if (code === 103 /* g */) {
      const github = body(input, at, "github_pat_", 20)
      if (github > 0) return github
      if (input.startsWith("gh", at) && "pousr".includes(input.charAt(at + 2)) && input.charAt(at + 3) === "_")
        return body(input, at, input.slice(at, at + 4), 20)
      const gitlab = gitlabEnd(input, at)
      return gitlab > 0 ? gitlab : body(input, at, "gsk_", 20)
    }
    if (code === 120 /* x */) {
      const xai = body(input, at, "xai-", 20)
      if (xai > 0) return xai
      if (input.startsWith("xox", at) && "baprs".includes(input.charAt(at + 3)) && input.charAt(at + 4) === "-")
        return body(input, at, input.slice(at, at + 5), 20)
      return -1
    }
    if (code === 104 /* h */) {
      const webhook = webhookEnd(input, at)
      if (webhook > 0) return webhook
      const vault = body(input, at, "hvs.", 24)
      if (vault > 0) return vault
      const vaultBatch = body(input, at, "hvb.", 24)
      if (vaultBatch > 0) return vaultBatch
      return body(input, at, "hf_", 20, isAlnum)
    }
    if (code === 101 /* e */) return jwtEnd(input, at)
    if (code === 65 /* A */) {
      const bedrock = body(input, at, "ABSK", 100, credentialChar)
      if (bedrock > 0) return bedrock
      const google = body(input, at, "AIza", 30)
      if (google > 0) return google
      return awsEnd(input, at)
    }
    if (code === 83 /* S */) return dotted(input, at, "SG.", 20)
    if (code === 78 /* N */) return body(input, at, "NRAK-", 20)
    if (code === 110 /* n */) {
      const notion = body(input, at, "ntn_", 32)
      return notion > 0 ? notion : body(input, at, "npm_", 32)
    }
    if (code === 112 /* p */) return body(input, at, "pypi-", 32)
    if (code === 100 /* d */) {
      const doppler = dotted(input, at, "dp.pt.", 20)
      if (doppler > 0) return doppler
      const ocean = body(input, at, "dop_v1_", 32)
      if (ocean > 0) return ocean
      const oceanOther = body(input, at, "doo_v1_", 32)
      if (oceanOther > 0) return oceanOther
      const oceanRefresh = body(input, at, "dor_v1_", 32)
      if (oceanRefresh > 0) return oceanRefresh
      return body(input, at, "dapi", 32)
    }
    if (code === 99 /* c */) {
      const oauth = body(input, at, "cfoat_", 30)
      if (oauth > 0) return oauth
      const key = body(input, at, "cfk_", 30)
      if (key > 0) return key
      const user = body(input, at, "cfut_", 30)
      return user > 0 ? user : body(input, at, "cfat_", 30)
    }
    return -1
  }

  // Base64 user:pass (and other Basic credentials) with optional padding.
  const BASIC = /^[A-Za-z0-9+/]+={0,2}$/

  // Basic credentials are only recognized after an `Authorization` mention on the same line, so prose
  // such as `Basic authentication is required` is left alone.
  function authorization(input: string) {
    const pattern = /authorization|[\r\n]/gi
    let next: RegExpExecArray | null | undefined
    let last = -Infinity
    // Credential candidates arrive in increasing order within this scan.
    return (at: number) => {
      if (next === undefined) next = pattern.exec(input)
      while (next !== null && pattern.lastIndex <= at) {
        last = next[0].length === 1 ? -Infinity : next.index
        next = pattern.exec(input)
      }
      return last >= at - 256
    }
  }

  function credentialSpan(input: string, at: number, auth: (at: number) => boolean) {
    const kind = words(input, at, "bearer")
      ? "bearer"
      : words(input, at, "basic")
        ? "basic"
        : words(input, at, "token")
          ? "token"
          : words(input, at, "api-key") || words(input, at, "api_key")
            ? "api-key"
            : undefined
    if (!kind) return
    if (at > 0 && isAlnum(input.charCodeAt(at - 1))) return
    let index = at + kind.length
    if (!isSpace(input.charCodeAt(index))) return
    while (index < input.length && isSpace(input.charCodeAt(index))) index++
    const start = index
    while (index < input.length && credentialChar(input.charCodeAt(index))) index++
    const length = index - start
    if (kind === "bearer") {
      if (length < 16) return
      if (CHALLENGE.test(input.slice(start, index))) return
      return { start, end: index, replacement: MARKER }
    }
    if (kind === "basic") {
      if (length < 8 || !BASIC.test(input.slice(start, index))) return
      if (!auth(at)) return
      return { start, end: index, replacement: MARKER }
    }
    if (length < 8 || !auth(at)) return
    return { start, end: index, replacement: MARKER }
  }

  function privateKeyEnd(input: string, at: number) {
    if (!input.startsWith("-----BEGIN ", at)) return -1
    const head = input.indexOf("PRIVATE KEY-----", at + 11)
    if (head < 0 || head - at > 100) return -1
    if (!/^[A-Z ]*$/.test(input.slice(at + 11, head))) return -1
    const end = input.indexOf("-----END ", head)
    if (end < 0) return input.length
    const tail = input.indexOf("PRIVATE KEY-----", end + 9)
    return tail < 0 ? input.length : tail + 16
  }

  function keyTail(input: string, at: number) {
    let index = at
    const code = input.charCodeAt(index)
    if (code === 95 || code === 45 || code === 46 || code === 32) index++
    if (!words(input, index, "key")) return -1
    return index + 3
  }

  // `api key`/`api_key`/`apikey`, `access key`, `secret`, `token`, plural included; whole word parts only.
  function keywordEnd(input: string, at: number) {
    const code = lower(input.charCodeAt(at))
    let end = -1
    if (code === 97 && words(input, at, "api")) end = keyTail(input, at + 3)
    if (code === 97 && words(input, at, "access")) end = keyTail(input, at + 6)
    if (code === 97 && words(input, at, "auth")) end = at + 4
    if (code === 97 && words(input, at, "app")) {
      const sep = input.charCodeAt(at - 1)
      if ((sep === 95 || sep === 45 || sep === 46) && words(input, at - 3, "dd") && !isNameChar(input.charCodeAt(at - 4)))
        end = keyTail(input, at + 3)
    }
    if (code === 97 && input.charCodeAt(at - 1) === 59 && input.startsWith("AccountKey", at))
      end = keyTail(input, at + 7)
    if (code === 99 && words(input, at, "credential")) end = at + 10
    if (code === 101 && words(input, at, "encryption")) end = keyTail(input, at + 10)
    if (code === 107 && words(input, at, "kilo_auth_content")) end = at + 17
    if (code === 108 && words(input, at, "license")) end = keyTail(input, at + 7)
    if (code === 111 && words(input, at, "openai")) end = keyTail(input, at + 6)
    if (code === 112 && words(input, at, "password")) end = at + 8
    if (code === 112 && words(input, at, "passwd")) end = at + 6
    if (code === 112 && words(input, at, "pwd")) end = at + 3
    if (code === 112 && words(input, at, "private")) end = keyTail(input, at + 7)
    if (code === 115 && words(input, at, "secret")) end = Math.max(at + 6, keyTail(input, at + 6))
    if (code === 115 && words(input, at, "signing")) end = keyTail(input, at + 7)
    if (code === 115 && words(input, at, "storage")) {
      const after = at + 7
      const code2 = input.charCodeAt(after)
      const word = code2 === 95 || code2 === 45 || code2 === 46 || code2 === 32 ? after + 1 : after
      if (words(input, word, "account")) end = keyTail(input, word + 7)
    }
    if (code === 115 && words(input, at, "service")) {
      const after = at + 7
      const sep = input.charCodeAt(after)
      const part = sep === 95 || sep === 45 || sep === 46 || sep === 32 ? after + 1 : after
      end = words(input, part, "role") ? keyTail(input, part + 4) : keyTail(input, after)
    }
    if (code === 115 && words(input, at, "session")) {
      const after = at + 7
      const sep = input.charCodeAt(after)
      const token = sep === 95 || sep === 45 || sep === 46 || sep === 32 ? after + 1 : after
      if (words(input, token, "token")) end = token + 5
    }
    if (code === 116 && words(input, at, "token")) end = at + 5
    if (end < 0) return -1
    const prev = input.charCodeAt(at - 1)
    const next = input.charCodeAt(at + 1)
    const camel = input.charCodeAt(at) !== code && (lower(prev) === prev || lower(next) === next)
    if (isAlnum(prev) && !camel) return -1
    if (end < input.length && lower(input.charCodeAt(end)) === 115 /* s */) end++
    if (isNameChar(input.charCodeAt(end))) return -1
    return end
  }

  // A bare value only counts when it is long, spaceless, and mixes letters with digits.
  function bareKey(value: string) {
    if (value.length < 16 || /\s/.test(value)) return false
    if (value.includes(".") || value.includes("(")) return false
    let letter = false
    let digit = false
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code >= 48 && code <= 57) digit = true
      else if (isAlnum(code)) letter = true
    }
    return letter && digit
  }

  // Shared parser for a named assignment. `assignmentSpan` adds the redaction filter on top; the file
  // guard uses the raw span so it can see marker values and names too.
  function assignmentAt(input: string, at: number) {
    const keyword = keywordEnd(input, at)
    if (keyword < 0) return
    let nameStart = at
    for (let back = 0; nameStart > 0 && isNameChar(input.charCodeAt(nameStart - 1)) && back < NAME_LIMIT; back++)
      nameStart--
    let nameEnd = keyword
    const name = input.slice(nameStart, nameEnd)
    const close = input.charAt(nameEnd)
    if ((close === '"' || close === "'") && nameStart > 0 && input.charAt(nameStart - 1) === close) nameEnd++
    // `\"name\":` inside a JSON string keeps the closing quote escaped.
    const mark = input.charAt(nameEnd + 1)
    if (
      close === "\\" &&
      (mark === '"' || mark === "'") &&
      nameStart > 1 &&
      input.charAt(nameStart - 1) === mark &&
      input.charAt(nameStart - 2) === "\\"
    )
      nameEnd += 2
    let index = nameEnd
    // `password[]=...` and `password[0]=...` keep the key name, then a bracketed suffix.
    if (input.charCodeAt(index) === 91) {
      const close = input.indexOf("]", index)
      if (close < 0 || close - index > 32) return
      index = close + 1
    }
    while (index < input.length && isSpace(input.charCodeAt(index))) index++
    const separator = input.charCodeAt(index)
    if (separator !== 58 && separator !== 61) return
    const next = input.charCodeAt(index + 1)
    if (separator === 61 && (next === 61 || next === 62)) return
    // `token := value` is a Go short variable declaration, not two operators.
    index += separator === 58 && next === 61 ? 2 : 1
    while (index < input.length && isSpace(input.charCodeAt(index))) index++
    // A query parameter ends at the next separator, not at the end of the URL.
    const query = nameStart > 0 && "?&#".includes(input.charAt(nameStart - 1))
    const quote = input.charCodeAt(index)
    if (exactName(name) && quote === 123 /* { */) {
      const end = objectEnd(input, index)
      if (end < 0) return
      return { name, start: index, end, quote: "" }
    }
    if (input.startsWith('"""', index) || input.startsWith("'''", index)) {
      const mark = input.slice(index, index + 3)
      const close = input.indexOf(mark, index + 3)
      if (close < 0) return
      return { name, start: index, end: close + 3, quote: "" }
    }
    // A command substitution can carry a heredoc or an inline secret; redact the whole substitution.
    if (input.startsWith("$(", index)) {
      let depth = 0
      let quote = 0
      let escape = false
      const limit = Math.min(input.length, index + 4_096)
      for (let cursor = index + 2; cursor < limit; cursor++) {
        const code = input.charCodeAt(cursor)
        if (escape) {
          escape = false
          continue
        }
        if (code === 92 /* \ */) {
          escape = true
          continue
        }
        if (quote !== 0) {
          if (code === quote) quote = 0
          continue
        }
        if (code === 34 || code === 39 || code === 96) {
          quote = code
          continue
        }
        if (code === 40) depth++
        if (code !== 41) continue
        if (depth === 0) return { name, start: index, end: cursor + 1, quote: "" }
        depth--
      }
      return
    }
    if (quote === 34 || quote === 39) {
      // In JSON, `name=",` is an empty value whose closing quote is followed by a delimiter.
      if (",}]\n\r".includes(input.charAt(index + 1))) {
        const after = input.charAt(index + 2)
        if (input.charAt(index + 1) !== "," || after === "" || "\n\r}]".includes(after)) return
      }
      let cursor = index + 1
      let closed = -1
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor)
        if (code === 92 /* \ */) {
          cursor += 2
          continue
        }
        if (code === quote) {
          closed = cursor
          break
        }
        cursor++
      }
      if (closed < 0) return
      return { name, start: index, end: closed + 1, quote: input.charAt(index) }
    }
    // `\"value\"` is the JSON-escaped form of a quoted value; keep both escape bytes.
    if (quote === 92 /* \ */) {
      const escaped = input.charAt(index + 1)
      if (escaped === '"' || escaped === "'") {
        const close = `\\${escaped}`
        const start = index + close.length
        let from = start
        let end = -1
        while (from <= input.length) {
          const hit = input.indexOf(close, from)
          if (hit < 0) break
          const after = input.charAt(hit + close.length)
          // The closing quote of an escaped assignment is followed by JSON punctuation.
          if (after === "" || '"\' ,}]\n\r'.includes(after)) {
            end = hit
            break
          }
          from = hit + close.length
        }
        if (end < 0) return
        return { name, start: index, end: end + close.length, quote: close }
      }
    }
    let end = index
    while (end < input.length) {
      const code = input.charCodeAt(end)
      if (
        isSpace(code) ||
        (query && (code === 38 || code === 35)) ||
        code === 34 ||
        code === 39 ||
        code === 44 ||
        code === 59 ||
        code === 41 ||
        code === 125 ||
        code === 93 ||
        (code === 92 && (input.charAt(end + 1) === '"' || input.charAt(end + 1) === "'"))
      )
        break
      end++
    }
    // A YAML block scalar keeps its value on the following indented lines.
    if (BLOCK.has(input.slice(index, end))) {
      let cursor = end
      let last = -1
      while (cursor < input.length) {
        while (input.charCodeAt(cursor) === 13 || input.charCodeAt(cursor) === 10) cursor++
        const lineStart = cursor
        let lineEnd = cursor
        while (lineEnd < input.length && input.charCodeAt(lineEnd) !== 10 && input.charCodeAt(lineEnd) !== 13)
          lineEnd++
        const line = input.slice(lineStart, lineEnd)
        if (!/^[ \t]+\S/.test(line)) break
        last = lineEnd
        cursor = lineEnd
      }
      if (last < 0) return
      end = last
    }
    return { name, start: index, end, quote: "" }
  }

  function assignmentSpan(input: string, at: number) {
    const found = assignmentAt(input, at)
    if (!found) return
    const size = found.quote.length
    const value = found.quote ? input.slice(found.start + size, found.end - size) : input.slice(found.start, found.end)
    if (
      !namedValue(found.name, value, found.quote !== "")
    )
      return
    return { start: found.start, end: found.end, replacement: `${found.quote}${MARKER}${found.quote}` }
  }

  // `authorized` is set when the string is the value of an Authorization-named field, which supplies
  // the context a bare `Basic <credential>` string cannot carry on its own.
  const PREFIX = new Set([111, 119, 118, 102, 97, 115, 114, 103, 120, 104, 101, 65, 83, 78, 110, 112, 100, 99])
  const KEY_START = new Set([97, 99, 101, 108, 111, 112, 115, 116, 65, 67, 69, 75, 76, 79, 80, 83, 84])

  // A keyword may start a word, follow a separator, or open a camelCase segment.
  function boundary(input: string, at: number) {
    const prev = input.charCodeAt(at - 1)
    if (at === 0 || !isNameChar(prev) || prev === 95 || prev === 45 || prev === 46) return true
    return prev >= 97 && prev <= 122 && input.charCodeAt(at) >= 65 && input.charCodeAt(at) <= 90
  }

  function valuesText(input: string, authorized = false) {
    const chunks: string[] = []
    const auth = authorized ? () => true : authorization(input)
    let last = 0
    let index = 0
    while (index < input.length) {
      const code = input.charCodeAt(index)
      if (code === 45 /* - */ && input.startsWith("-----BEGIN ", index)) {
        const end = privateKeyEnd(input, index)
        if (end > 0) {
          chunks.push(input.slice(last, index), MARKER)
          index = end
          last = end
          continue
        }
      }
      if (PREFIX.has(code)) {
        const end = boundary(input, index) ? prefixEnd(input, index) : -1
        if (end > 0) {
          chunks.push(input.slice(last, index), MARKER)
          index = end
          last = end
          continue
        }
      }
      if (lower(code) === 98 /* b */ || lower(code) === 116 /* t */ || lower(code) === 97 /* a */) {
        const span = credentialSpan(input, index, auth)
        if (span) {
          chunks.push(input.slice(last, span.start), span.replacement)
          index = span.end
          last = span.end
          continue
        }
      }
      if (KEY_START.has(code) && boundary(input, index)) {
        const span = assignmentSpan(input, index)
        if (span) {
          chunks.push(input.slice(last, span.start), span.replacement)
          index = span.end
          last = span.end
          continue
        }
      }
      index++
    }
    if (chunks.length > 0) chunks.push(input.slice(last))
    const joined = chunks.length > 0 ? chunks.join("") : input
    const atlas = joined.includes("atlasv1") ? joined.replace(ATLAS, MARKER) : joined
    const extra = extras(atlas, joined)
    const mail = mailMask(extra)
    // Connection strings carry a password without a key-shaped name; reuse the parser-primary rule.
    return mail.includes("://") ? redactUri(mail) : mail
  }

  // File guard: compare the file before and after a write, using the same values-mode matcher, and
  // report whether the next content replaces a recognized key with the marker. Never looks at config
  // and never exposes a value.
  function namedValues(input: string) {
    const found = new Map<string, { value: string; quoted: boolean }[]>()
    let index = 0
    while (index < input.length) {
      if (!isAlnum(input.charCodeAt(index))) {
        index++
        continue
      }
      const span = assignmentAt(input, index)
      if (!span || span.end <= index) {
        index++
        continue
      }
      const value = (() => {
        if (span.quote) return input.slice(span.start + span.quote.length, span.end - span.quote.length)
        // The bare scanner stops before the closing bracket of the marker; keep it and any suffix.
        if (!input.startsWith(MARKER, span.start)) return input.slice(span.start, span.end)
        let end = span.start + MARKER.length
        while (end < input.length) {
          const code = input.charCodeAt(end)
          if (isSpace(code) || code === 34 || code === 39 || code === 44 || code === 59 || code === 41 || code === 125 || code === 93)
            break
          end++
        }
        return input.slice(span.start, end)
      })()
      const name = span.name.replaceAll(/[_\s-]/g, "").toLowerCase()
      const item = { value, quoted: span.quote !== "" }
      const list = found.get(name)
      if (list) list.push(item)
      if (!list) found.set(name, [item])
      index = span.end
    }
    return found
  }

  function standaloneKeys(input: string) {
    const auth = authorization(input)
    let count = 0
    let index = 0
    while (index < input.length) {
      const code = input.charCodeAt(index)
      if (code === 45 /* - */ && input.startsWith("-----BEGIN ", index)) {
        const end = privateKeyEnd(input, index)
        if (end > 0) {
          count++
          index = end
          continue
        }
      }
      if (isKeyChar(code)) {
        const end = prefixEnd(input, index)
        if (end > 0) {
          count++
          index = end
          continue
        }
      }
      if (lower(code) === 98 /* b */ || lower(code) === 116 /* t */ || lower(code) === 97 /* a */) {
        const span = credentialSpan(input, index, auth)
        if (span) {
          count++
          index = span.end
          continue
        }
      }
      // A prefixed key that is a named assignment value is decided by the named comparison, not
      // counted again here; skip the whole value so `API_KEY=sk-...` is not double counted.
      if (isAlnum(code)) {
        const span = assignmentAt(input, index)
        if (span) {
          index = span.end
          continue
        }
      }
      index++
    }
    return count + (input.match(ATLAS) ?? []).length
  }

  // The marker itself is not a live credential, so a masked URL does not count as protected.
  function uriKeys(input: string) {
    return (input.match(candidate) ?? []).filter((raw) => {
      const info = userinfo(raw)
      return info !== undefined && info !== MARKER
    }).length
  }

  function markerCount(input: string) {
    let count = 0
    let index = input.indexOf(MARKER)
    while (index >= 0) {
      count++
      index = input.indexOf(MARKER, index + MARKER.length)
    }
    return count
  }

  function keyValue(value: string) {
    return bareKey(value) && !value.includes("${")
  }

  // Header values may be letters-only; an API key name is enough context to mask a long token.
  function headerKey(name: string, value: string) {
    if (name.charAt(0).toLowerCase() !== "x") return false
    const tail = name.slice(-12).replaceAll(/[_\s.-]/g, "").toLowerCase()
    if (!tail.endsWith("apikey") && !tail.endsWith("authtoken")) return false
    return value.length >= 16 && /[A-Za-z]/.test(value) && !/\s/.test(value) && /^[A-Za-z0-9_=+-]+$/.test(value)
  }

  const EXTRA: Array<[string, RegExp]> = [
    ["GOCSPX-", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
    ["shpat_", /\bshpat_[A-Za-z0-9]{16,}/g],
    ["lin_api_", /\blin_api_[A-Za-z0-9]{16,}/g],
    ["r8_", /\br8_[A-Za-z0-9]{20,}/g],
    ["pplx-", /\bpplx-[A-Za-z0-9]{20,}/g],
    ["sq0csp-", /\bsq0csp-[A-Za-z0-9_-]{16,}/g],
    ["AGE-SECRET-KEY-", /\bAGE-SECRET-KEY-1[A-Z0-9]{20,}/g],
    ["key-", /\bkey-[A-Za-z0-9]{24,}/g],
    ["secret_", /\bsecret_[A-Za-z0-9]{16,}/g],
    [".", /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g],
    [":", /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g],
  ]
  const CLI = /(^|[\s"'])(--?(?:password|passwd|pwd|token|secret|api-key|api_key|auth-token|auth_token))(\s+)((?:[^\s"'`\\]|\\(?!["']))+)/gi
  const MYSQL = /(\b(?:mysql|mariadb)\b[^\n]{0,256}?\s-p)([^\s"'`\]\\&,;)}]{4,})/gi
  const CURL = /(\s(?:-u|--user)\s+)([^\s:]+):((?:[^\s"'`\\]|\\(?!["']))+)/g
  const PGPASS = /(^|\n|["'])([^\s:]{1,255}:\d+:[^:\n]*:[^:\n]*:)((?:[^"\n\\]|\\(?!["']))+)/g
  // A plausible port followed by database/user/password separators.
  const PORT = /:\s*(?:(?:\*|[+-]?\d+)\s*)?:[^:]*:[^:]*:/
  const NETRC = /(\b(?:machine|login)\b[^\n]{0,512}?\bpassword\s+)((?:[^\s"'\\]|\\(?!["']))+)/gi
  const SETX = /(\bsetx\s+)(\w+)(\s+)("[^"]*"|(?:[^\s"'\\]|\\(?!["']))+)/gi
  const SIGN = /(^|[?&\s,;])(sig|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature)=((?:[^\\&\s#"']|\\(?!["']))+)/gi
  const COOKIE = /(^|\n|["'])(\s*cookie\s*:[^\n]*)/gi

  function extras(input: string, original = input) {
    let out = input
    for (const [needle, pattern] of EXTRA) {
      if (!out.includes(needle)) continue
      out = out.replace(pattern, (token) => (token.includes(MARKER) ? token : MARKER))
    }
    if (out.includes("--"))
      out = out.replace(CLI, (match, lead, flag, gap, value) =>
        value.startsWith("-") || value.startsWith("[redacted") ? match : `${lead}${flag}${gap}${MARKER}`,
      )
    if (/mysql|mariadb/i.test(out))
      out = out.replace(MYSQL, (match, head, value) => `${head}${value.startsWith("[redacted") ? value : MARKER}`)
    if (out.includes("-u"))
      out = out.replace(CURL, (match, head, user, pass) =>
        pass.startsWith("[redacted") ? match : `${head}${user}:${MARKER}`,
      )
    if (out.includes(":"))
      out = out.replace(PGPASS, (match, lead, head, pass) => {
        const host = head.split(":")[0]
        if (!host.includes(".") && host !== "localhost") return match
        const path = host.replace(/^["']/, "")
        const relative =
          /[\\/]/.test(path) &&
          !path.startsWith("/") &&
          !path.startsWith("\\") &&
          !path.startsWith("@")
        // A relative path with a short tail is a prefixed code line, not a complete passfile row.
        if (relative && !/:[^:]*:/.test(pass)) return match
        if (relative && out === original) {
          const row = head.slice(head.indexOf(":", host.length + 1) + 1) + pass
          const code = row.slice(0, row.indexOf(":"))
          if (!row.includes("\\") && /[({]/.test(code) && !PORT.test(row)) return match
        }
        return `${lead}${head}${pass.startsWith("[redacted") ? pass : MARKER}`
      })
    if (/password/i.test(out) && /machine|login/i.test(out))
      out = out.replace(NETRC, (match, head, value) => (value.startsWith("[redacted") ? match : `${head}${MARKER}`))
    if (/setx/i.test(out))
      out = out.replace(SETX, (match, head, name, gap, value) => {
        if (!weak(name)) return match
        const inner = value.startsWith('"') ? `"${MARKER}"` : MARKER
        return `${head}${name}${gap}${inner}`
      })
    if (/sig=|x-amz-|signature=/i.test(out))
      out = out.replace(SIGN, (match, sep, name, value) =>
        value.startsWith("[redacted") ? match : `${sep}${name}=${MARKER}`,
      )
    if (/cookie\s*:/i.test(out))
      out = out.replace(COOKIE, (match, lead, line) =>
        `${lead}${line.replace(/\b(session|sessionid|connect\.sid|auth)=([^;\\\s"']+)/gi, (part: string, key: string, value: string) =>
          value.startsWith("[redacted") ? part : `${key}=${MARKER}`,
        )}`,
      )
    return out
  }

  // Password-shaped names carry short or all-letter secrets that the key shape rejects.
  const WEAK = new Set(["password", "passwd", "pwd"])
  const TYPES = new Set([
    "string",
    "boolean",
    "number",
    "any",
    "unknown",
    "null",
    "undefined",
    "true",
    "false",
    "enabled",
    "disabled",
    "required",
    "optional",
    "default",
    "none",
    "include",
    "exclude",
    "inherit",
    "prompt",
    "ask",
  ])
  const REFERENCE = /^(?:process\.env|os\.environ|env|config|settings|ctx|this|secrets?|vars|options)\./i
  // Leaked credential dumps use `email:password`; a clone URL has a path and a port has five digits.
  const MAIL_PAIR = /(?<![\w.])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,3}\.[A-Za-z]{2,24}:(?:[^\s@/\\;,"'()[\]{}<>:&#]|\\(?!["']))+/g

  function weak(name: string) {
    const tail = name.slice(-16).toLowerCase()
    // `PWD` and `env.PWD` are the shell working directory, not a password.
    if (name === "PWD" || name.endsWith(".PWD")) return false
    return ["password", "passwords", "passwd", "passwds", "pwd", "pwds"].some((word) => tail.endsWith(word))
  }

  function mailPass(token: string) {
    if (token.slice(0, token.indexOf("@")).toLowerCase() === "git") return
    const pass = token.slice(token.lastIndexOf(":") + 1)
    if (pass.length < 6 || pass.length > 64 || !/[0-9]/.test(pass)) return
    if (pass.includes("${") || pass === MARKER) return
    return pass
  }

  function mailMask(input: string) {
    if (!input.includes("@")) return input
    return input.replace(MAIL_PAIR, (token) => {
      if (!mailPass(token)) return token
      return `${token.slice(0, token.lastIndexOf(":") + 1)}${MARKER}`
    })
  }

  function mailKeys(input: string) {
    let count = 0
    input.replace(MAIL_PAIR, (token) => {
      if (mailPass(token)) count++
      return token
    })
    return count
  }

  function explicit(value: string, quoted: boolean) {
    if (!value || value === MARKER) return false
    // A bare scan stops before `]`, so a marker prefix arrives without its last byte.
    if (value.startsWith("[redacted") || MARKER.startsWith(value)) return false
    if (value.includes("${")) return false
    if (!quoted && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return false
    if (!quoted && TYPES.has(value.toLowerCase())) return false
    if (value.startsWith("<") && value.endsWith(">")) return false
    return !REFERENCE.test(value)
  }

  function strongValue(value: string, quoted: boolean) {
    if (/[\s.()]/.test(value)) return false
    if (value.startsWith("[redacted") && value !== MARKER) return value.length > MARKER.length
    if (!explicit(value, quoted)) return false
    return value.length >= 16 && !/^\d+$/.test(value)
  }

  function namedValue(name: string, value: string, quoted: boolean) {
    if (weak(name) || exactName(name)) return explicit(value, quoted)
    if (strongName(name)) return strongValue(value, quoted)
    return keyValue(value) || headerKey(name, value)
  }

  function valueKey(item: { value: string; quoted: boolean }, name: string) {
    return namedValue(name, item.value, item.quoted)
  }

  function count(items: { value: string; quoted: boolean }[], name: string) {
    // A named value can also contain a key picked up by the standalone rules.
    return items.filter((item) => valueKey(item, name) || valuesText(item.value) !== item.value).length
  }

  const HEADER = /(?:^|\n)\s*[Xx]-[A-Za-z0-9-]*(?:api-key|auth-token)\s*:\s*([^\s"']+)/gi
  const SESSION = /\b(session|sessionid|connect\.sid|auth)=((?:[^;\\\s"']|\\(?!["']))+)/gi

  function spans(input: string, pattern: RegExp, group: number) {
    pattern.lastIndex = 0
    const out: Array<{ start: number; end: number }> = []
    let hit: RegExpExecArray | null
    while ((hit = pattern.exec(input)) !== null) {
      const value = hit[group]
      if (value) {
        const at = hit.index + hit[0].indexOf(value)
        out.push({ start: at, end: at + value.length })
      }
      if (hit[0] === "") pattern.lastIndex++
    }
    return out
  }

  function cookieSpans(input: string) {
    const out: Array<{ start: number; end: number }> = []
    for (const line of spans(input, COOKIE, 2)) {
      const text = input.slice(line.start, line.end)
      for (const item of spans(text, SESSION, 2))
        out.push({ start: line.start + item.start, end: line.start + item.end })
    }
    return out
  }

  function extraSpans(input: string) {
    const out = spans(input, HEADER, 1)
    out.push(...cookieSpans(input))
    for (const [, pattern] of EXTRA) out.push(...spans(input, pattern, 0))
    out.push(...spans(input, CLI, 4))
    out.push(...spans(input, MYSQL, 2))
    out.push(...spans(input, CURL, 3))
    out.push(...spans(input, PGPASS, 3))
    out.push(...spans(input, NETRC, 2))
    out.push(...spans(input, SETX, 4))
    out.push(...spans(input, SIGN, 3))
    return out
  }

  // A write guard may only block when the marker lands in the same slot as the old value.
  function slotLost(old: string, next: string) {
    for (const span of extraSpans(old)) {
      // A slot that already holds the marker lost nothing; without this, every edit to a file that
      // stores already-masked examples (test fixtures, docs) would be refused.
      if (old.slice(span.start, span.end).includes(MARKER)) continue
      const left = old.slice(Math.max(0, span.start - 40), span.start)
      const right = old.slice(span.end, span.end + 40)
      if (!left && !right) {
        if (next.trim() === MARKER) return true
        continue
      }
      const slot = `${left}${MARKER}${right}`
      // Block only when the edit adds a masked slot; a masked twin that was already there is not a loss.
      if (next.split(slot).length > old.split(slot).length) return true
    }
    return false
  }

  /**
   * True when writing `next` over `old` would replace a recognized access key with `[redacted]`.
   * New files, plain key deletion, and edits that keep every key are allowed.
   */
  export function blocksWrite(old: string, next: string): boolean {
    const before = namedValues(old)
    const after = namedValues(next)
    for (const [name, items] of before) {
      const keys = count(items, name)
      if (keys === 0) continue
      const later = after.get(name)
      // A name missing from the next content was deleted, which is a normal edit.
      if (!later) continue
      const marked =
        weak(name) || exactName(name)
          ? later.some((item) => item.value.startsWith("[redacted"))
          : later.some((item) => item.value === MARKER)
      if (!marked) continue
      if (count(later, name) < keys) return true
    }
    return (
      (standaloneKeys(next) < standaloneKeys(old) ||
        uriKeys(next) < uriKeys(old) ||
        mailKeys(next) < mailKeys(old)) &&
      markerCount(next) > markerCount(old)
    ) || slotLost(old, next)
  }
  // fork_change end

  // Pull the raw userinfo segment out of a candidate without normalizing it, so redaction preserves
  // the original shape (encoding, ports, path/query untouched). Any non-empty userinfo counts — a bare
  // `user@host` may still be a token, so we fail closed rather than require a colon.
  function rawUserinfo(raw: string): string | undefined {
    const sep = raw.indexOf("//")
    if (sep < 0) return undefined
    const authority = raw.slice(sep + 2).split(/[/?#]/)[0] ?? ""
    const at = authority.lastIndexOf("@")
    if (at < 1) return undefined
    return authority.slice(0, at)
  }

  // Parser-primary: a well-formed URL with userinfo is authoritative (handles ports, paths, query
  // strings, percent-encoding, and @ in the path without false positives). Regex-style raw extraction
  // is the fallback so malformed-but-credentialed strings the parser rejects still redact.
  // `git` with no password is the conventional clone-URL user (`ssh://git@github.com/...`), not a
  // credential — allowlist it so saved clone commands are not mangled.
  function clone(info: string | undefined): boolean {
    return info === "git"
  }

  function userinfo(raw: string): string | undefined {
    try {
      const url = new URL(raw)
      if (!url.username && !url.password) return undefined
      if (url.username === "git" && !url.password) return undefined
      return rawUserinfo(raw) ?? `${url.username}:${url.password}`
    } catch {
      const info = rawUserinfo(raw)
      return clone(info) ? undefined : info
    }
  }

  function hasUri(input: string) {
    return (input.match(candidate) ?? []).some((raw) => userinfo(raw) !== undefined)
  }

  function redactUri(input: string) {
    return input.replace(candidate, (raw) => {
      const info = userinfo(raw)
      return info ? raw.replace(`${info}@`, "[redacted]@") : raw
    })
  }

  function sensitive(input: string) {
    const name = input.replaceAll(/[_\s-]/g, "").toLowerCase()
    if (keys.has(name)) return true
    return [...keys].some((key) => name.endsWith(key))
  }

  // fork_change start - Values mode reuses the shared matcher instead of the legacy patterns.
  export function has(input: string, opts?: Options) {
    if (opts?.values) return valuesText(input) !== input
    // fork_change end
    return hasUri(input) || secret.some((item) => item.test(input))
  }

  // fork_change start - Values mode rewrites the string in place of the legacy pattern pass.
  export function text(input: string, opts?: Options) {
    if (opts?.values) return valuesText(input)
    // fork_change end
    return secret.reduce((next, item) => {
      const flags = item.flags.includes("g") ? item.flags : `${item.flags}g`
      return next.replace(new RegExp(item.source, flags), "[redacted]")
    }, redactUri(input))
  }

  // fork_change start - Shape-preserving values-mode walker.
  /**
   * Values mode: only string leaves under a sensitive name are key candidates. A recognized key
   * becomes the marker; a non-key string is still scrubbed for embedded keys. Objects, arrays,
   * numbers, booleans and null keep their shape.
   */
  function valuesValue(input: unknown, name?: string): unknown {
    if (typeof input === "string") {
      // A weak name has no key shape to check: any explicit literal is the secret.
      if (name && weak(name) && explicit(input, true)) return MARKER
      // A whole key leaf collapses to the bare marker; a structured value (e.g. "Bearer [redacted]")
      // keeps its scheme and only has the credential scrubbed by valuesText.
      if (name && sensitive(name) && input !== MARKER && (input.includes(MARKER) || bareKey(input))) return MARKER
      return valuesText(input, name !== undefined && name.toLowerCase().includes("authorization"))
    }
    // Array elements inherit the name of the property that holds the array.
    if (Array.isArray(input)) return input.map((item) => valuesValue(item, name))
    if (typeof input !== "object" || input === null) return input
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, valuesValue(item, key)]))
  }
  // fork_change end

  // fork_change start - Values mode dispatches to the shape-preserving walker.
  export function value(input: unknown, name?: string, opts?: Options): unknown {
    if (opts?.values) return valuesValue(input, name)
    // fork_change end
    if (name && sensitive(name)) return "[redacted]"
    if (typeof input === "string") return text(input)
    if (Array.isArray(input)) return input.map((item) => value(item))
    if (typeof input !== "object" || input === null) return input
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item, key)]))
  }
}
