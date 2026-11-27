import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const layer = (filename = ":memory:") =>
  AppNodeBuilder.build(LayerNode.group([EventV2.node, Database.node]), [
    [Database.node, Database.layerFromPath(filename)],
  ])
const it = testEffect(layer())
const Durable = EventV2.define({
  type: "test.batch.durable",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, value: Schema.Int },
})
const entries = Array.from({ length: 201 }, (_, value) => ({
  definition: Durable,
  data: { id: value % 2 === 0 ? "one" : "two", value },
}))
const LocalBatch = EventV2.define({
  type: "test.batch.local",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, value: Schema.Int },
})

test("commits every chunk before notifying and preserves per-aggregate sequences", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "batch.db")
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      for (const id of ["one", "two"]) yield* events.publish(Durable, { id, value: -1 })
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => new SQLite(filename, { readonly: true })),
        (reader) => Effect.sync(() => reader.close()),
      )
      const observed = new Array<unknown>()
      const stop = yield* events.listen(() =>
        Effect.sync(() => observed.push(reader.query("SELECT COUNT(*) AS count FROM event").get())),
      )
      yield* events.publishAll(entries)
      yield* stop
      expect(observed).toEqual(Array.from({ length: 201 }, () => ({ count: 203 })))
      const rows = yield* db.select().from(EventTable).orderBy(EventTable.seq).all()
      for (const [id, count] of [
        ["one", 102],
        ["two", 101],
      ] as const) {
        expect(rows.filter((row) => row.aggregate_id === id).map((row) => row.seq)).toEqual(
          Array.from({ length: count }, (_, seq) => seq),
        )
      }
      const next = yield* events.publish(Durable, { id: "one", value: 201 })
      expect(next.durable?.seq).toBe(102)
    }).pipe(Effect.provide(layer(filename)), Effect.scoped),
  )
})

it.effect("keeps projection, sequence, and notification without journal rows in local-only mode", () =>
  Effect.gen(function* () {
    const previous = process.env.KILO_EVENT_JOURNAL
    process.env.KILO_EVENT_JOURNAL = "off"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.KILO_EVENT_JOURNAL
        else process.env.KILO_EVENT_JOURNAL = previous
      }),
    )

    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const received = new Array<EventV2.Payload>()
    yield* db.run("CREATE TABLE local_batch_probe (value integer NOT NULL)")
    yield* events.project(LocalBatch, (event) =>
      db
        .run(`INSERT INTO local_batch_probe (value) VALUES (${(event.data as { value: number }).value})`)
        .pipe(Effect.orDie),
    )
    yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === LocalBatch.type) received.push(event)
      }),
    )

    yield* events.publishAll(
      Array.from({ length: 3 }, (_, value) => ({ definition: LocalBatch, data: { id: "local", value } })),
    )

    const sequence = yield* db
      .select()
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, "local"))
      .get()
      .pipe(Effect.orDie)
    expect(yield* db.select().from(EventTable).all()).toEqual([])
    expect(sequence?.seq).toBe(2)
    expect(yield* db.all("SELECT value FROM local_batch_probe ORDER BY value")).toEqual([
      { value: 0 },
      { value: 1 },
      { value: 2 },
    ])
    expect(received.map((event) => (event.data as { value: number }).value)).toEqual([0, 1, 2])
  }),
)

it.effect("rolls back all chunks and projections without notifying on failure", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const received = new Array<EventV2.Payload>()
    yield* db.run("CREATE TABLE batch_probe (value integer NOT NULL)")
    yield* events.project(Durable, (event) =>
      Effect.gen(function* () {
        yield* db.run("INSERT INTO batch_probe (value) VALUES (1)").pipe(Effect.orDie)
        if (event.data.value === 100) yield* Effect.die("batch failed")
      }),
    )
    yield* events.listen((event) => Effect.sync(() => received.push(event)))
    const exit = yield* events.publishAll(entries).pipe(Effect.exit)
    expect(String(exit)).toContain("batch failed")
    expect(yield* db.all("SELECT value FROM batch_probe")).toEqual([])
    expect(yield* db.select().from(EventTable).all()).toEqual([])
    expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
    expect(received).toEqual([])
    const next = yield* events.publish(Durable, { id: "one", value: 0 })
    expect(next.durable?.seq).toBe(0)
  }),
)
