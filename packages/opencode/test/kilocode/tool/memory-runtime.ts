import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import type { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"

const info = {
  name: "code",
  mode: "primary",
  options: {},
  permission: {},
} as Agent.Info

const agents = Agent.Service.of({
  get: () => Effect.succeed(info),
  list: () => Effect.succeed([info]),
  defaultInfo: () => Effect.succeed(info),
  defaultAgent: () => Effect.succeed("code"),
  generate: () => Effect.succeed({ identifier: "code", whenToUse: "", systemPrompt: "" }),
})

type Runtime = {
  limits?: () => { maxBytes: number; maxLines: number }
  output?: (text: string) => Truncate.Result
}

function layer(runtime: Runtime) {
  const truncate = Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed(""),
    output: (text) => Effect.sync(() => runtime.output?.(text) ?? { content: text, truncated: false as const }),
    limits: () =>
      Effect.sync(() => runtime.limits?.() ?? { maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
  })

  return Layer.mergeAll(
    MemoryService.layer,
    Layer.succeed(Agent.Service, agents),
    Layer.succeed(Truncate.Service, truncate),
  )
}

export function runMemoryTool(
  input: Effect.Effect<Tool.Info, never, MemoryService.Service | Agent.Service | Truncate.Service>,
  params: unknown,
  ctx: Tool.Context,
  runtime: Runtime = {},
) {
  return runMemoryToolMany(input, [params], ctx, runtime).then((result) => result[0])
}

export function runMemoryToolMany(
  input: Effect.Effect<Tool.Info, never, MemoryService.Service | Agent.Service | Truncate.Service>,
  params: unknown[],
  ctx: Tool.Context,
  runtime: Runtime = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* input
      const tool = yield* result.init()
      const out = []
      for (const item of params) out.push(yield* tool.execute(item, ctx))
      return out
    }).pipe(Effect.provide(layer(runtime))),
  )
}
