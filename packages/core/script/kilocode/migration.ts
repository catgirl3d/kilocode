function board(name: string) {
  return /(?:^|_)kilocode_board(?:_reset)?$/.test(name)
}

function continuation(name: string) {
  return /(?:^|_)kilocode_continuation(?:_intent)?$/.test(name)
}

// fork_change start
function btw(name: string) {
  return /(?:^|_)kilocode_btw$/.test(name)
}
// fork_change end

export function file(name: string, value: string) {
  if (btw(name)) return `// fork_change - new file\n${value}` // fork_change
  return board(name) || continuation(name) ? `// kilocode_change - new file\n${value}` : value
}

export function block(name: string | undefined, source: string, value: string) {
  // fork_change start
  // A new fork migration file needs only its header; in the shared schema.gen.ts the /btw statements are marked [fork].
  if (name !== undefined && btw(name)) return value
  if (/kilo_btw/.test(source)) return `// kilocode_change start - [fork] /btw\n${value}\n// kilocode_change end`
  // fork_change end
  return (name !== undefined && (board(name) || continuation(name))) ||
    /kilo_board(?:_message)?|part_session_step_finish_idx|recall_(?:part_search|message_role)_idx|kilo_continuation_intent/.test(source)
    ? `// kilocode_change start\n${value}\n// kilocode_change end`
    : value
}

export function line(name: string, value: string) {
  if (btw(name)) return `${value} // kilocode_change - [fork] /btw` // fork_change
  const kilo =
    board(name) ||
    continuation(name) ||
    name.endsWith("_kilocode_model_usage_index") ||
    name.endsWith("_account_server_scoped_key")
  return kilo ? `${value} // kilocode_change` : value
}
