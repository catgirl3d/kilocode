// fork_change - new file
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, type JSONPath } from "jsonc-parser"

export namespace KilocodeJsonc {
  /**
   * Delete `path` from JSONC `text` and return the new text. An absent path returns `text` unchanged.
   *
   * jsonc-parser keeps the comma that follows the last property of an object, so deleting the only
   * key of `{ "a": 1, }` leaves the invalid `{ , }`. Drop that trailing comma before deleting.
   */
  export function remove(text: string, path: JSONPath) {
    const tree = parseTree(text)
    const node = tree && findNodeAtLocation(tree, path)
    if (!node) return text
    const prop = node.parent
    const base = (() => {
      if (prop?.type !== "property" || prop.parent?.children?.at(-1) !== prop) return text
      const scanner = createScanner(text, true)
      scanner.setPosition(prop.offset + prop.length)
      scanner.scan()
      const comma = scanner.getTokenOffset()
      if (text[comma] !== ",") return text
      return text.slice(0, comma) + text.slice(comma + 1)
    })()
    return applyEdits(base, modify(base, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  }
}
