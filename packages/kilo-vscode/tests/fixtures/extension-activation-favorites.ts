import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mock } from "bun:test"

type Disposable = { dispose: () => void }
type Message = Record<string, unknown>

const noop = () => {}
const disposable = (): Disposable => ({ dispose: noop })
const event = () => disposable()
const kind = (value: string) => ({ value, append: (part: string) => kind(`${value}.${part}`) })

function memory(seed: unknown) {
  const data = new Map<string, unknown>([["sessionFavorites", seed]])
  return {
    data,
    state: {
      get: <T>(key: string, fallback?: T) => (data.has(key) ? (data.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) data.delete(key)
        else data.set(key, value)
      },
      keys: () => [...data.keys()],
      setKeysForSync: () => {},
    },
  }
}

class ThemeColor {
  constructor(public id: string) {}
}

class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

class DisposableClass {
  constructor(private cb: () => void = noop) {}

  static from(...items: Disposable[]) {
    return { dispose: () => items.forEach((item) => item.dispose()) }
  }

  dispose() {
    this.cb()
  }
}

class EventEmitterClass {
  event = event
  fire = noop
  dispose = noop
}

class CodeAction {
  command?: { command: string; title: string }
  isPreferred?: boolean

  constructor(
    public title: string,
    public kind: { value: string },
  ) {}
}

class TabInputText {
  constructor(public uri: unknown) {}
}

class TabInputNotebook {
  constructor(public uri: unknown) {}
}

class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

class Range {
  constructor(
    public start: unknown,
    public end: unknown,
  ) {}
}

class InlineCompletionItem {
  constructor(
    public insertText: string,
    public range?: unknown,
    public command?: unknown,
  ) {}
}

class TreeItem {
  constructor(public label: string) {}
}

class ThemeIcon {
  constructor(public id: string) {}
}

class MarkdownString {
  isTrusted = false

  constructor(public value: string) {}
}

const uri = {
  parse: (value: string) => ({ scheme: "https", authority: "", path: value, query: "", fragment: "", fsPath: value }),
  file: (value: string) => ({ scheme: "file", authority: "", path: value, query: "", fragment: "", fsPath: value }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join("/")
    return { scheme: "file", authority: "", path: joined, query: "", fragment: "", fsPath: joined }
  },
}

const root = path.resolve(import.meta.dir, "../..")
const storage = path.join(os.tmpdir(), "kilo", `activation-favorites-${randomUUID()}`)
const global = memory({ sessions: ["ses-startup"] })
const workspace = memory({ sessions: ["ses-workspace-only"] })
let provider: unknown

const configuration = (section: string) => ({
  get: (key: string, fallback?: unknown) => {
    if (section === "kilo-code.new.autocomplete" && key === "enableAutoTrigger") return false
    return fallback
  },
  inspect: () => ({}),
  update: async () => {},
})

const watcher = () => ({
  onDidChange: event,
  onDidCreate: event,
  onDidDelete: event,
  dispose: noop,
})

const host = {
  Uri: uri,
  extensions: {
    getExtension: (id: string) => {
      if (id === "vscode.git") return undefined
      return {
        packageJSON: { version: "test", contributes: { configuration: { properties: {}, keybindings: [] } } },
        isActive: true,
        exports: undefined,
      }
    },
    onDidChange: event,
  },
  env: {
    appName: "VS Code",
    language: "en",
    machineId: "test-machine",
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: event,
    shell: "/bin/bash",
    remoteName: undefined,
    openExternal: noop,
    clipboard: { writeText: async () => {} },
  },
  version: "1.90.0",
  l10n: { t: (message: string) => message },
  workspace: {
    workspaceFolders: [],
    isTrusted: true,
    name: "activation-test",
    findFiles: async () => [],
    textDocuments: [] as unknown[],
    notebookDocuments: [] as unknown[],
    onDidOpenTextDocument: event,
    onDidChangeTextDocument: event,
    onDidSaveTextDocument: event,
    onDidCloseTextDocument: event,
    onDidChangeConfiguration: event,
    onDidChangeWorkspaceFolders: event,
    onDidCreateFiles: event,
    getWorkspaceFolder: () => undefined,
    getConfiguration: configuration,
    createFileSystemWatcher: watcher,
    openTextDocument: async (input: { content?: string; language?: string }) => ({
      getText: () => input.content ?? "",
      languageId: input.language ?? "plaintext",
    }),
    asRelativePath: (value: string | { fsPath?: string }) => (typeof value === "string" ? value : (value.fsPath ?? "")),
    fs: {
      createDirectory: async () => {},
      writeFile: async () => {},
      readFile: async () => new Uint8Array(),
      readDirectory: async () => [],
      delete: async () => {},
      stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor,
  ThemeIcon,
  MarkdownString,
  RelativePattern,
  window: {
    activeTextEditor: undefined,
    activeColorTheme: { kind: 2 },
    activeNotebookEditor: undefined,
    state: { focused: true },
    visibleTextEditors: [],
    visibleNotebookEditors: [],
    tabGroups: { all: [] },
    onDidChangeWindowState: event,
    onDidChangeTextEditorSelection: event,
    onDidChangeActiveTextEditor: event,
    onDidChangeActiveColorTheme: event,
    onDidCloseTerminal: event,
    onDidChangeActiveTerminal: event,
    showTextDocument: async () => {},
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    createTerminal: () => ({ show: noop, sendText: noop, dispose: noop }),
    createOutputChannel: () => ({
      name: "",
      append: noop,
      appendLine: noop,
      replace: noop,
      clear: noop,
      show: noop,
      hide: noop,
      dispose: noop,
    }),
    createStatusBarItem: () => ({
      text: "",
      tooltip: "",
      color: undefined,
      command: undefined,
      show: noop,
      hide: noop,
      dispose: noop,
    }),
    createTextEditorDecorationType: () => disposable(),
    registerWebviewViewProvider: (viewType: string, value: unknown) => {
      if (viewType === "kilo-code.SidebarProvider") provider = value
      return disposable()
    },
    registerWebviewPanelSerializer: () => disposable(),
    registerUriHandler: () => disposable(),
  },
  commands: {
    registerCommand: () => disposable(),
    executeCommand: async () => undefined,
  },
  languages: {
    getDiagnostics: () => [],
    registerCodeActionsProvider: () => disposable(),
    registerInlineCompletionItemProvider: () => disposable(),
  },
  CodeAction,
  CodeActionKind: { QuickFix: kind("quickfix"), RefactorRewrite: kind("refactor.rewrite") },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  TabInputText,
  TabInputNotebook,
  NotebookCellKind: { Markup: 1, Code: 2 },
  Position,
  Range,
  InlineCompletionItem,
  Disposable: DisposableClass,
  EventEmitter: EventEmitterClass,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrastLight: 3 },
  OverviewRulerLane: { Left: 1 },
  ViewColumn: { One: 1, Two: 2, Three: 3, Active: -1 },
}

mock.restore()
mock.module("vscode", () => host)

const context = {
  extensionUri: host.Uri.file(root),
  extensionPath: root,
  extensionMode: 1,
  extension: { packageJSON: { version: "test" } },
  globalState: global.state,
  workspaceState: workspace.state,
  globalStorageUri: host.Uri.file(storage),
  globalStoragePath: storage,
  storageUri: host.Uri.file(storage),
  storagePath: storage,
  subscriptions: [] as Disposable[],
  asAbsolutePath: (value: string) => path.join(root, value),
}

const extension = await import("../../src/extension")
await mkdir(storage, { recursive: true })

try {
  await extension.activate(context as never)
  assert.ok(provider, "activate should register the real sidebar provider")

  const sent: unknown[] = []
  let receive: ((message: Message) => Promise<void>) | undefined
  const viewListeners = new Set<() => void>()
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined as unknown,
    html: "",
    asWebviewUri: (value: unknown) => value,
    onDidReceiveMessage: (listener: (message: Message) => Promise<void>) => {
      receive = listener
      return disposable()
    },
    postMessage: async (message: unknown) => {
      sent.push(message)
      return true
    },
  }
  const internal = provider as unknown as {
    connectionService: { connect: (directory: string) => Promise<void> }
    initConnectionPromise: Promise<void> | null
    resolveWebviewView: (view: unknown, viewContext: unknown, token: unknown) => void
  }
  const connect = internal.connectionService.connect
  // The public resolver eagerly connects; keep that lifecycle real without starting the CLI.
  internal.connectionService.connect = async () => {}
  try {
    internal.resolveWebviewView(
      {
        webview,
        visible: false,
        onDidChangeVisibility: (listener: () => void) => {
          viewListeners.add(listener)
          return { dispose: () => viewListeners.delete(listener) }
        },
      },
      {},
      {},
    )
    await internal.initConnectionPromise
  } finally {
    internal.connectionService.connect = connect
  }
  sent.length = 0
  assert.ok(receive, "the captured provider should expose its real message entry")

  await receive({ type: "requestSessionFavorites" })
  const snapshot = [...sent]

  sent.length = 0
  await receive({
    type: "sessionFavoriteAction",
    requestID: "activation-add",
    action: { type: "set", sessionID: "ses-added-after-activation", favorite: true },
  })
  const mutation = [...sent]

  assert.deepEqual(
    {
      snapshot,
      mutation,
      global: global.data.get("sessionFavorites"),
      workspace: workspace.data.get("sessionFavorites"),
    },
    {
      snapshot: [{ type: "sessionFavoritesLoaded", state: { sessions: ["ses-startup"] } }],
      mutation: [
        {
          type: "sessionFavoritesLoaded",
          state: { sessions: ["ses-startup", "ses-added-after-activation"] },
        },
        { type: "sessionFavoriteResult", requestID: "activation-add", ok: true },
      ],
      global: { sessions: ["ses-startup", "ses-added-after-activation"] },
      workspace: { sessions: ["ses-workspace-only"] },
    },
  )
} finally {
  try {
    await extension.deactivate()
    for (const item of context.subscriptions.splice(0).reverse()) item.dispose()
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
}
