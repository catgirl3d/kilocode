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
    'An access key was found in the outgoing context where it cannot be hidden safely, so the request was not sent. Roll back to a message before the key entered the context, or turn off "Redact access keys before sending" in Experimental.'

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

  const ATLAS = /[A-Za-z0-9]+\.atlasv1\.[A-Za-z0-9]{16,}/g

  function prefixEnd(input: string, at: number) {
    if (at > 0 && isKeyChar(input.charCodeAt(at - 1))) return -1
    const code = input.charCodeAt(at)
    if (code === 115 /* s */) {
      const stripe = body(input, at, "sk_live_", 16)
      return stripe > 0 ? stripe : body(input, at, "sk-", 20)
    }
    if (code === 114 /* r */) return body(input, at, "rk_live_", 16)
    if (code === 103 /* g */) {
      const github = body(input, at, "github_pat_", 20)
      if (github > 0) return github
      if (input.startsWith("gh", at) && "pousr".includes(input.charAt(at + 2)) && input.charAt(at + 3) === "_")
        return body(input, at, input.slice(at, at + 4), 20)
      const gitlab = body(input, at, "glpat-", 20)
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
      const vault = body(input, at, "hvs.", 24)
      if (vault > 0) return vault
      const vaultBatch = body(input, at, "hvb.", 24)
      if (vaultBatch > 0) return vaultBatch
      return body(input, at, "hf_", 20, isAlnum)
    }
    if (code === 101 /* e */) return jwtEnd(input, at)
    if (code === 65 /* A */) {
      const google = body(input, at, "AIza", 30)
      if (google > 0) return google
      if (!input.startsWith("AKIA", at) && !input.startsWith("ASIA", at)) return -1
      let end = at + 4
      const start = end
      while (end < input.length) {
        const next = input.charCodeAt(end)
        if (!((next >= 48 && next <= 57) || (next >= 65 && next <= 90))) break
        end++
      }
      return end - start >= 16 ? end : -1
    }
    if (code === 83 /* S */) return dotted(input, at, "SG.", 20)
    if (code === 78 /* N */) return body(input, at, "NRAK-", 20)
    if (code === 110 /* n */) return body(input, at, "npm_", 32)
    if (code === 112 /* p */) return body(input, at, "pypi-", 32)
    if (code === 100 /* d */) return body(input, at, "dop_v1_", 32)
    if (code === 99 /* c */) {
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
    const kind = words(input, at, "bearer") ? "bearer" : words(input, at, "basic") ? "basic" : undefined
    if (!kind) return
    if (at > 0 && isAlnum(input.charCodeAt(at - 1))) return
    let index = at + kind.length
    if (!isSpace(input.charCodeAt(index))) return
    while (index < input.length && isSpace(input.charCodeAt(index))) index++
    const start = index
    while (index < input.length && credentialChar(input.charCodeAt(index))) index++
    const length = index - start
    if (kind === "bearer") return length >= 16 ? { start, end: index, replacement: MARKER } : undefined
    if (length < 8 || !BASIC.test(input.slice(start, index))) return
    if (!auth(at)) return
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
    if (code === 108 && words(input, at, "license")) end = keyTail(input, at + 7)
    if (code === 111 && words(input, at, "openai")) end = keyTail(input, at + 6)
    if (code === 112 && words(input, at, "password")) end = at + 8
    if (code === 112 && words(input, at, "passwd")) end = at + 6
    if (code === 112 && words(input, at, "pwd")) end = at + 3
    if (code === 112 && words(input, at, "private")) end = keyTail(input, at + 7)
    if (code === 115 && words(input, at, "secret")) end = Math.max(at + 6, keyTail(input, at + 6))
    if (code === 115 && words(input, at, "storage")) {
      const after = at + 7
      const code2 = input.charCodeAt(after)
      const word = code2 === 95 || code2 === 45 || code2 === 46 || code2 === 32 ? after + 1 : after
      if (words(input, word, "account")) end = keyTail(input, word + 7)
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
    while (index < input.length && isSpace(input.charCodeAt(index))) index++
    const separator = input.charCodeAt(index)
    if (separator !== 58 && separator !== 61) return
    const next = input.charCodeAt(index + 1)
    if (separator === 61 && (next === 61 || next === 62)) return
    // `token := value` is a Go short variable declaration, not two operators.
    index += separator === 58 && next === 61 ? 2 : 1
    while (index < input.length && isSpace(input.charCodeAt(index))) index++
    const quote = input.charCodeAt(index)
    if (quote === 34 || quote === 39) {
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
        const end = input.indexOf(close, start)
        if (end < 0) return
        return { name, start: index, end: end + close.length, quote: close }
      }
    }
    let end = index
    while (end < input.length) {
      const code = input.charCodeAt(end)
      if (
        isSpace(code) ||
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
    return { name, start: index, end, quote: "" }
  }

  function assignmentSpan(input: string, at: number) {
    const found = assignmentAt(input, at)
    if (!found) return
    const size = found.quote.length
    const value = found.quote ? input.slice(found.start + size, found.end - size) : input.slice(found.start, found.end)
    if (!(weak(found.name) ? explicit(value, found.quote !== "") : keyValue(value))) return
    return { start: found.start, end: found.end, replacement: `${found.quote}${MARKER}${found.quote}` }
  }

  // `authorized` is set when the string is the value of an Authorization-named field, which supplies
  // the context a bare `Basic <credential>` string cannot carry on its own.
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
      if (isKeyChar(code)) {
        const end = prefixEnd(input, index)
        if (end > 0) {
          chunks.push(input.slice(last, index), MARKER)
          index = end
          last = end
          continue
        }
      }
      if (lower(code) === 98 /* b */) {
        const span = credentialSpan(input, index, auth)
        if (span) {
          chunks.push(input.slice(last, span.start), span.replacement)
          index = span.end
          last = span.end
          continue
        }
      }
      if (isAlnum(code)) {
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
    const mail = mailMask(atlas)
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
      if (lower(code) === 98 /* b */) {
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

  // Password-shaped names carry short or all-letter secrets that the key shape rejects.
  const WEAK = new Set(["password", "passwd", "pwd"])
  const TYPES = new Set(["string", "boolean", "number", "any", "unknown", "null", "undefined", "true", "false"])
  const REFERENCE = /^(?:process\.env|os\.environ|env|config|settings|ctx|this|secrets?|vars|options)\./i
  // Leaked credential dumps use `email:password`; a clone URL has a path and a port has five digits.
  const MAIL_PAIR = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}:[^\s@/\\;,"'()[\]{}<>:]+/g

  function weak(name: string) {
    // `PWD` is the shell working directory, not a password.
    if (name === "PWD") return false
    const plain = name.replaceAll(/[_\s.-]/g, "").toLowerCase()
    return [...WEAK].some((word) => plain.endsWith(word) || plain.endsWith(`${word}s`))
  }

  function mailPass(token: string) {
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

  function valueKey(item: { value: string; quoted: boolean }, name: string) {
    return weak(name) ? explicit(item.value, item.quoted) : keyValue(item.value)
  }

  function count(items: { value: string; quoted: boolean }[], name: string) {
    // A named value can also contain a key picked up by the standalone rules.
    return items.filter((item) => valueKey(item, name) || valuesText(item.value) !== item.value).length
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
      const marked = weak(name)
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
    )
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
