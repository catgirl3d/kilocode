// fork_change - new file
import { onMount } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { List } from "@kilocode/kilo-ui/list"
import type { GitCommitSearchItem } from "../../types/messages"

interface Props {
  commits: GitCommitSearchItem[]
  onSearch: (query: string) => void
  onSelect: (commit: GitCommitSearchItem) => void
  onClose: () => void
}

/** Inline history search for selecting a full-hash git commit mention. */
export function CommitMentionPicker(props: Props) {
  let root: HTMLDivElement | undefined

  onMount(() => {
    queueMicrotask(() => root?.querySelector("input")?.focus({ preventScroll: true }))
  })

  return (
    <div
      ref={root}
      class="session-mention-picker commit-mention-picker"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      <List<GitCommitSearchItem>
        items={props.commits}
        key={(item) => item.hash}
        skipFilter={() => true}
        search={{ placeholder: "Search commits", autofocus: true }}
        onFilter={(query) => props.onSearch(query)}
        onSelect={(item) => {
          if (item) props.onSelect(item)
        }}
      >
        {(item) => (
          <span class="session-mention-item">
            <Icon name="git-commit" class="file-mention-icon" />
            <span class="session-mention-title">{item.subject}</span>
            <span class="session-mention-worktree">{item.shortHash}</span>
            <span class="session-mention-time">
              {item.author} - {item.date}
            </span>
          </span>
        )}
      </List>
    </div>
  )
}
