// fork_change - new file
// Runtime-free parts of the model-error policy. They read no v1 error class, so they move to Kilo v2 unchanged.
export namespace KiloErrorCore {
  export const INCOMPLETE_RESPONSE_RETRIES = 2
  export const INCOMPLETE_RESPONSE_MESSAGE =
    "The provider repeatedly ended the response before returning usable output."

  /** A stream that ended without usable output; KiloSessionProcessor.recover owns its bounded retries. */
  export class IncompleteResponseError extends Error {
    constructor(readonly vercelID?: string) {
      super(INCOMPLETE_RESPONSE_MESSAGE)
      this.name = "IncompleteResponseError"
    }
  }

  /** True when an unknown finish carries nothing worth keeping, so the attempt is replayed. */
  export function replayable(input: {
    finish?: string
    text: boolean
    reasoning: boolean
    tool: boolean
    usage: boolean
  }) {
    if (input.finish !== undefined && input.finish !== "unknown") return false
    if (input.text || input.tool) return false
    // Reasoning without text or tools has no actionable output. Retry it through
    // the existing bounded recovery budget instead of silently settling unknown.
    // Keeping this decision here avoids the unbounded loop caused by continuing
    // every unknown finish at the prompt-loop boundary.
    if (input.reasoning) return true
    return !input.usage
  }

  /**
   * - `retry`: wait and request again; text and reasoning of the failed attempt are rewound first.
   * - `resume`: a tool already ran, so close the step as a tool turn and let the loop continue.
   * - `compact`: the conversation is too large; compaction handles it.
   * - `incomplete`: an empty response; the bounded recovery loop handles it.
   * - `stop`: nothing waits for it: the operator interrupted, or fallback() declines it.
   */
  export type Action = "retry" | "resume" | "compact" | "incomplete" | "stop"

  export type Verdict = {
    rule: string
    action: Action
    message?: string
  }
}
