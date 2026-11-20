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
  return board(name) || continuation(name) || btw(name) ? `// kilocode_change - new file\n${value}` : value // fork_change
}

export function block(name: string | undefined, source: string, value: string) {
  // fork_change start
  return (name !== undefined && (board(name) || continuation(name) || btw(name))) ||
    /kilo_board(?:_message)?|part_session_step_finish_idx|recall_(?:part_search|message_role)_idx|kilo_continuation_intent|kilo_btw/.test(source)
    ? `// kilocode_change start\n${value}\n// kilocode_change end`
    : value
  // fork_change end
}

export function line(name: string, value: string) {
  // fork_change start
  return board(name) || continuation(name) || btw(name) || name.endsWith("_kilocode_model_usage_index")
    ? `${value} // kilocode_change`
    : value
  // fork_change end
}
