import { type ParentComponent } from "solid-js"
import { Base } from "./provider-base"
import { RichProvider } from "./rich-provider"
import { Session } from "./provider-session"
import { MemoryProvider } from "./memory"
import { SessionTagsProvider } from "./session-tags" // fork_change
import { FeedbackProvider } from "./feedback"

// fork_change start - preserve the shared webview session tag provider lifetime
const Root: ParentComponent = (props) => (
  <Base content={RichProvider}>
    <SessionTagsProvider>{props.children}</SessionTagsProvider>
  </Base>
)
// fork_change end

const Chat: ParentComponent = (props) => (
  <MemoryProvider>
    <FeedbackProvider>{props.children}</FeedbackProvider>
  </MemoryProvider>
)

export const ProviderShell = { Root, Session, Chat }
