// fork_change - new file
import { randomUUID } from "node:crypto"
import type { Memento } from "vscode"
import { SECTION_COLORS } from "../webview-ui/agent-manager/section-colors"
import type { SessionTag, SessionTagError, SessionTagsState } from "../webview-ui/src/types/messages/sessions"
import { createMementoStore } from "./memento-store"

const KEY = "sessionTags"
const BACKUP_KEY = "sessionTags.v1-backup"
const COLORS = new Set<string>(SECTION_COLORS.map((color) => color.label))

type ProjectState = { tags: SessionTag[]; sessions: Record<string, string[]> }

type StoredState = {
  version: 2
  global: SessionTag[]
  projects: Record<string, ProjectState>
  legacy: { sessions: Record<string, string[]> }
}

const EMPTY: StoredState = {
  version: 2,
  global: [],
  projects: dict<ProjectState>(),
  legacy: { sessions: dict<string[]>() },
}

let memento: Memento | undefined
let backupRaw: unknown
let backupNeeded = false
let backupTask: Promise<void> | undefined

const storeMemento = {
  get: (key: string) => memento?.get(key),
  update: (key: string, value: unknown) => {
    const current = memento
    if (!current) return Promise.reject(new Error(`Memento store ${KEY} is not initialized`))
    return beforeWrite(current).then(() => current.update(key, value))
  },
  keys: () => memento?.keys() ?? [],
} as unknown as Memento

const store = createMementoStore<StoredState>({
  key: KEY,
  empty: EMPTY,
  sanitize,
  copy,
})

type Change = { next?: StoredState; error?: SessionTagError }
type Found = { kind: "global" | "project"; tag: SessionTag }
type UpdateValues = { target: "global" | "project"; name: string; color: string }
type UpdateResult = { value?: UpdateValues; error?: SessionTagError }

export function initSessionTags(value: Memento): void {
  const raw = value.get<unknown>(KEY)
  memento = value
  backupRaw = isV1(raw) || isUnsupported(raw) ? clone(raw) : undefined
  backupNeeded = backupRaw !== undefined
  backupTask = undefined
  store.init(storeMemento)
}

export function sessionTags(): StoredState {
  return publicState(store.snapshot())
}

export function sessionTagsFor(project?: string, value: StoredState = store.snapshot()): SessionTagsState {
  const local = project ? (value.projects[project]?.tags ?? []) : []
  const tags = [
    ...local.map((tag) => ({ ...tag })),
    ...value.global.map((tag) => ({ ...tag, scope: "global" as const })),
  ]
  const known = new Set(tags.map((tag) => tag.id))
  const sessions = dict<string[]>()
  const add = (source: Record<string, string[]> | undefined): void => {
    if (!source) return
    for (const [sessionID, ids] of Object.entries(source)) {
      const next = new Set(sessions[sessionID] ?? [])
      for (const id of ids) {
        if (known.has(id)) next.add(id)
      }
      if (next.size) sessions[sessionID] = [...next]
    }
  }
  add(value.legacy.sessions)
  add(project ? value.projects[project]?.sessions : undefined)
  return { tags, sessions: publicSessions(sessions) }
}

export function onSessionTagsChanged(listener: (view: (project?: string) => SessionTagsState) => void): () => void {
  return store.onChange((value) => {
    try {
      listener((project) => sessionTagsFor(project, value))
    } catch (error) {
      console.error("[Kilo New] Session tag listener failed:", error)
    }
  })
}

export async function handleSessionTagsMessage(
  message: unknown,
  post: (message: unknown) => void,
  project: string | undefined,
): Promise<boolean> {
  if (!record(message)) return false
  if (message.type === "requestSessionTags") {
    send(post, { type: "sessionTagsLoaded", state: sessionTagsFor(project) })
    return true
  }
  if (message.type !== "sessionTagAction") return false
  if (typeof message.requestID !== "string" || !message.requestID) return true
  const requestID = message.requestID
  const result: { error?: SessionTagError } = {}

  try {
    await store.write((value) => {
      const change = apply(value, message.action, project)
      if (change.error) {
        result.error = change.error
        return
      }
      if (!change.next) return
      return { next: change.next }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to persist session tags:", error)
    send(post, { type: "sessionTagResult", requestID, ok: false, error: "storage" })
    return true
  }
  if (result.error) {
    send(post, { type: "sessionTagResult", requestID, ok: false, error: result.error })
    return true
  }
  send(post, { type: "sessionTagResult", requestID, ok: true })
  return true
}

export async function removeSessionTags(sessionID: string): Promise<void> {
  if (!localID(sessionID)) return
  try {
    await store.write((value) => {
      const legacy = withoutSession(value.legacy.sessions, sessionID)
      let changed = legacy.changed
      const projects = dict<ProjectState>()
      for (const [name, project] of Object.entries(value.projects)) {
        const sessions = withoutSession(project.sessions, sessionID)
        if (sessions.changed) changed = true
        projects[name] = sessions.changed ? { ...project, sessions: sessions.value } : project
      }
      if (!changed) return
      return { next: { ...value, projects, legacy: { sessions: legacy.value } } }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to remove session tags:", error)
  }
}

function create(state: StoredState, action: Record<string, unknown>, project: string | undefined): Change {
  const sessionID = action.sessionID
  const name = action.name
  const color = action.color
  const scope = action.scope
  if (typeof sessionID !== "string" || !localID(sessionID) || typeof color !== "string" || !COLORS.has(color)) {
    return { error: "invalid" }
  }
  if (scope !== undefined && scope !== "project" && scope !== "global") return { error: "invalid" }
  if (typeof name !== "string" || !name.trim()) return { error: "name" }
  if (!project) return { error: "project" }
  const trimmed = name.trim()
  if (sessionTagsFor(project, state).tags.some((tag) => tag.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: "duplicate" }
  }

  const tag: SessionTag =
    scope === "global" ? { id: randomUUID(), name: trimmed, color, scope } : { id: randomUUID(), name: trimmed, color }
  const current = state.projects[project] ?? { tags: [], sessions: dict<string[]>() }
  const sessions = add(current.sessions, sessionID, tag.id)
  const nextProject =
    scope === "global" ? { ...current, sessions } : { ...current, tags: [...current.tags, tag], sessions }
  return {
    next: {
      ...state,
      global: scope === "global" ? [...state.global, tag] : state.global,
      projects: putProject(state.projects, project, nextProject),
    },
  }
}

function update(state: StoredState, action: Record<string, unknown>, project: string | undefined): Change {
  const id = action.id
  if (typeof id !== "string") return { error: "missing" }
  const found = find(state, id, project)
  if (!found) return { error: "missing" }
  const values = parseUpdate(state, found, action.patch, project)
  if (values.error) return { error: values.error }
  const next = values.value!
  if (next.target === found.kind && next.name === found.tag.name && next.color === found.tag.color) return {}

  const tag: SessionTag =
    next.target === "global"
      ? { id, name: next.name, color: next.color, scope: "global" }
      : { id, name: next.name, color: next.color }
  return applyUpdate(state, found, next.target, tag, project)
}

function parseUpdate(state: StoredState, found: Found, raw: unknown, project: string | undefined): UpdateResult {
  if (!record(raw) || Object.keys(raw).some((key) => key !== "name" && key !== "color" && key !== "scope")) {
    return { error: "invalid" }
  }
  const scope = Object.hasOwn(raw, "scope") ? raw.scope : undefined
  if (scope !== undefined && scope !== "project" && scope !== "global") return { error: "invalid" }
  const target = found.kind === "global" ? (scope ?? "global") : (scope ?? "project")
  if (found.kind === "global" && target === "project" && !project) return { error: "project" }

  let name = found.tag.name
  if (Object.hasOwn(raw, "name")) {
    if (typeof raw.name !== "string" || !raw.name.trim()) return { error: "name" }
    name = raw.name.trim()
    if (
      sessionTagsFor(project, state).tags.some(
        (tag) => tag.id !== found.tag.id && tag.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return { error: "duplicate" }
    }
  }
  let color = found.tag.color
  if (Object.hasOwn(raw, "color")) {
    if (typeof raw.color !== "string" || !COLORS.has(raw.color)) return { error: "invalid" }
    color = raw.color
  }
  return { value: { target, name, color } }
}

function applyUpdate(
  state: StoredState,
  found: Found,
  target: "global" | "project",
  tag: SessionTag,
  project: string | undefined,
): Change {
  if (found.kind === "global" && target === "project") return moveGlobal(state, project!, tag)
  if (found.kind === "project" && target === "global") return moveProject(state, project!, tag)
  if (found.kind === "global")
    return { next: { ...state, global: state.global.map((item) => (item.id === tag.id ? tag : item)) } }
  const current = state.projects[project!]
  if (!current) return { error: "missing" }
  return {
    next: {
      ...state,
      projects: putProject(state.projects, project!, {
        ...current,
        tags: current.tags.map((item) => (item.id === tag.id ? tag : item)),
      }),
    },
  }
}

function moveGlobal(state: StoredState, project: string, tag: SessionTag): Change {
  const current = state.projects[project] ?? { tags: [], sessions: dict<string[]>() }
  const projects = putProject(state.projects, project, {
    ...current,
    tags: [...current.tags.filter((item) => item.id !== tag.id), tag],
  })
  const scrubbed = dict<ProjectState>()
  for (const [name, value] of Object.entries(projects)) {
    if (name === project) {
      scrubbed[name] = value
      continue
    }
    const sessions = withoutTag(value.sessions, tag.id)
    scrubbed[name] = sessions.changed ? { ...value, sessions: sessions.value } : value
  }
  return {
    next: {
      ...state,
      global: state.global.filter((item) => item.id !== tag.id),
      projects: scrubbed,
      legacy: { sessions: withoutTag(state.legacy.sessions, tag.id).value },
    },
  }
}

function moveProject(state: StoredState, project: string, tag: SessionTag): Change {
  const current = state.projects[project]
  if (!current) return { error: "missing" }
  return {
    next: {
      ...state,
      global: [...state.global, tag],
      projects: putProject(state.projects, project, {
        ...current,
        tags: current.tags.filter((item) => item.id !== tag.id),
      }),
    },
  }
}

function assign(state: StoredState, action: Record<string, unknown>, project: string | undefined): Change {
  const sessionID = action.sessionID
  const id = action.id
  const assigned = action.assigned
  if (typeof sessionID !== "string" || !localID(sessionID) || typeof assigned !== "boolean") return { error: "invalid" }
  if (typeof id !== "string" || !sessionTagsFor(project, state).tags.some((tag) => tag.id === id))
    return { error: "missing" }
  if (!project) return { error: "project" }
  const current = state.projects[project] ?? { tags: [], sessions: dict<string[]>() }
  if (assigned) {
    if (current.sessions[sessionID]?.includes(id) || state.legacy.sessions[sessionID]?.includes(id)) return {}
    return {
      next: {
        ...state,
        projects: putProject(state.projects, project, { ...current, sessions: add(current.sessions, sessionID, id) }),
      },
    }
  }
  const local = withoutAssignment(current.sessions, sessionID, id)
  const legacy = withoutAssignment(state.legacy.sessions, sessionID, id)
  if (!local.changed && !legacy.changed) return {}
  return {
    next: {
      ...state,
      projects: local.changed
        ? putProject(state.projects, project, { ...current, sessions: local.value })
        : state.projects,
      legacy: { sessions: legacy.value },
    },
  }
}

function apply(state: StoredState, action: unknown, project: string | undefined): Change {
  if (!record(action) || typeof action.type !== "string") return { error: "invalid" }
  if (action.type === "create") return create(state, action, project)
  if (action.type === "update") return update(state, action, project)
  if (action.type === "assign") return assign(state, action, project)
  if (action.type === "delete") {
    const id = action.id
    if (typeof id !== "string") return { error: "missing" }
    const found = find(state, id, project)
    if (!found) return { error: "missing" }
    const projects = dict<ProjectState>()
    for (const [name, value] of Object.entries(state.projects)) {
      const sessions = withoutTag(value.sessions, id)
      projects[name] = sessions.changed ? { ...value, sessions: sessions.value } : value
    }
    const current = project ? projects[project] : undefined
    return {
      next: {
        ...state,
        global: found.kind === "global" ? state.global.filter((tag) => tag.id !== id) : state.global,
        projects:
          found.kind === "project" && current
            ? putProject(projects, project!, { ...current, tags: current.tags.filter((tag) => tag.id !== id) })
            : projects,
        legacy: { sessions: withoutTag(state.legacy.sessions, id).value },
      },
    }
  }
  return { error: "invalid" }
}

function find(state: StoredState, id: string, project: string | undefined): Found | undefined {
  const global = state.global.find((tag) => tag.id === id)
  if (global) return { kind: "global", tag: global }
  const local = project ? state.projects[project]?.tags.find((tag) => tag.id === id) : undefined
  return local ? { kind: "project", tag: local } : undefined
}

function sanitize(value: unknown): StoredState {
  if (!record(value)) return copy(EMPTY)
  if (isV1(value)) return migrate(value)
  if (value.version !== 2) return copy(EMPTY)
  const global = tags(value.global, true)
  const projects = dict<ProjectState>()
  if (record(value.projects)) {
    for (const [name, raw] of Object.entries(value.projects)) {
      if (!name || name.length > 200 || !record(raw)) continue
      const local = tags(raw.tags, false)
      const known = new Set([...global, ...local].map((tag) => tag.id))
      projects[name] = { tags: local, sessions: sessions(raw.sessions, known) }
    }
  }
  const known = new Set(global.map((tag) => tag.id))
  const legacy =
    record(value.legacy) && record(value.legacy.sessions) ? sessions(value.legacy.sessions, known) : dict<string[]>()
  return { version: 2, global, projects, legacy: { sessions: legacy } }
}

function migrate(value: Record<string, unknown>): StoredState {
  const global = tags(value.tags, true)
  return {
    version: 2,
    global,
    projects: dict<ProjectState>(),
    legacy: { sessions: sessions(value.sessions, new Set(global.map((tag) => tag.id))) },
  }
}

function tags(value: unknown, global: boolean): SessionTag[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const names = new Set<string>()
  const result: SessionTag[] = []
  for (const raw of value) {
    if (!record(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string") continue
    if (typeof raw.color !== "string" || !COLORS.has(raw.color)) continue
    const name = raw.name.trim()
    const key = name.toLowerCase()
    if (!name || ids.has(raw.id) || names.has(key)) continue
    ids.add(raw.id)
    names.add(key)
    result.push(
      global ? { id: raw.id, name, color: raw.color, scope: "global" } : { id: raw.id, name, color: raw.color },
    )
  }
  return result
}

function sessions(value: unknown, known: Set<string>): Record<string, string[]> {
  if (!record(value)) return dict<string[]>()
  const result = dict<string[]>()
  for (const [sessionID, raw] of Object.entries(value)) {
    if (!localID(sessionID) || !Array.isArray(raw)) continue
    const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && known.has(id)))]
    if (ids.length) result[sessionID] = ids
  }
  return result
}

function copy(value: StoredState): StoredState {
  const projects = dict<ProjectState>()
  for (const [name, project] of Object.entries(value.projects)) {
    projects[name] = { tags: project.tags.map((tag) => ({ ...tag })), sessions: copySessions(project.sessions) }
  }
  return {
    version: 2,
    global: value.global.map((tag) => ({ ...tag })),
    projects,
    legacy: { sessions: copySessions(value.legacy.sessions) },
  }
}

function publicState(value: StoredState): StoredState {
  return {
    version: 2,
    global: value.global.map((tag) => ({ ...tag })),
    projects: Object.fromEntries(
      Object.entries(value.projects).map(([name, project]) => [
        name,
        { tags: project.tags.map((tag) => ({ ...tag })), sessions: publicSessions(project.sessions) },
      ]),
    ),
    legacy: { sessions: publicSessions(value.legacy.sessions) },
  }
}

function publicSessions(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([sessionID, ids]) => [sessionID, [...ids]]))
}

function putProject(
  value: Record<string, ProjectState>,
  name: string,
  project: ProjectState,
): Record<string, ProjectState> {
  const next = projectMap(value)
  next[name] = project
  return next
}

function projectMap(value: Record<string, ProjectState>): Record<string, ProjectState> {
  const next = dict<ProjectState>()
  for (const [name, project] of Object.entries(value)) next[name] = project
  return next
}

function copySessions(value: Record<string, string[]>): Record<string, string[]> {
  const next = dict<string[]>()
  for (const [sessionID, ids] of Object.entries(value)) next[sessionID] = [...ids]
  return next
}

function add(value: Record<string, string[]>, sessionID: string, id: string): Record<string, string[]> {
  const next = copySessions(value)
  next[sessionID] = [...(value[sessionID] ?? []), id]
  return next
}

function withoutSession(
  value: Record<string, string[]>,
  sessionID: string,
): { value: Record<string, string[]>; changed: boolean } {
  if (!Object.hasOwn(value, sessionID)) return { value, changed: false }
  const next = copySessions(value)
  delete next[sessionID]
  return { value: next, changed: true }
}

function withoutAssignment(
  value: Record<string, string[]>,
  sessionID: string,
  id: string,
): { value: Record<string, string[]>; changed: boolean } {
  const current = value[sessionID]
  if (!current?.includes(id)) return { value, changed: false }
  const ids = current.filter((item) => item !== id)
  const next = copySessions(value)
  if (ids.length) next[sessionID] = ids
  else delete next[sessionID]
  return { value: next, changed: true }
}

function withoutTag(
  value: Record<string, string[]>,
  id: string,
): { value: Record<string, string[]>; changed: boolean } {
  let changed = false
  const next = dict<string[]>()
  for (const [sessionID, ids] of Object.entries(value)) {
    const rest = ids.filter((item) => item !== id)
    if (rest.length !== ids.length) changed = true
    if (rest.length) next[sessionID] = rest
  }
  return { value: changed ? next : value, changed }
}

async function beforeWrite(value: Memento): Promise<void> {
  if (backupTask) {
    await backupTask
    return
  }
  if (!backupNeeded || backupRaw === undefined) return
  backupNeeded = false
  const raw = backupRaw
  backupTask = (async () => {
    try {
      await value.update(BACKUP_KEY, raw)
    } catch (error) {
      console.error("[Kilo New] Failed to save session tags v1 backup:", error)
    }
  })()
  await backupTask
}

function isV1(value: unknown): boolean {
  return record(value) && !Object.hasOwn(value, "version") && Array.isArray(value.tags)
}

function isUnsupported(value: unknown): boolean {
  return record(value) && Object.hasOwn(value, "version") && typeof value.version === "number" && value.version !== 2
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone)
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

function send(post: (message: unknown) => void, message: unknown): void {
  try {
    post(message)
  } catch (error) {
    console.error("[Kilo New] Session tag message delivery failed:", error)
  }
}

function localID(value: string): boolean {
  return value.length > 0 && !value.startsWith("cloud:")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}
