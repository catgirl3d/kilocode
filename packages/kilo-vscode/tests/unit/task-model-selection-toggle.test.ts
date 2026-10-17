import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "writes experimental.task_model_selection when the settings switch is toggled",
  () => fixture("task-model-selection-toggle"),
  60_000,
)
