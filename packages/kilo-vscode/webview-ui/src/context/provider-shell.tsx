import { type ParentComponent } from "solid-js"
import { Base } from "./provider-base"
import { RichProvider } from "./rich-provider"
import { Session } from "./provider-session"
import { MemoryProvider } from "./memory"
import { SessionTagsProvider } from "./session-tags" // fork_change
import { FeedbackProvider } from "./feedback"

const Root: ParentComponent = (props) => (
  <Base content={RichProvider}>
    {/* fork_change start - keep local session tags inside the shared webview provider lifetime */}
    <SessionTagsProvider>{props.children}</SessionTagsProvider>
    {/* fork_change end */}
  </Base>
)

const Chat: ParentComponent = (props) => (
  <MemoryProvider>
    <FeedbackProvider>{props.children}</FeedbackProvider>
  </MemoryProvider>
)

export const ProviderShell = { Root, Session, Chat }
