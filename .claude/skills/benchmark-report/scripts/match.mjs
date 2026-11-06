// Matching of benchmark rows to their input file, shared with the tests.

// Runs from the selection page save each row's input line (input_line), so a
// run of chosen messages matches its file by line number: every row's question
// and expected answer must be on its line. Pairs come in file order.
export function matchByLine(rows, lines) {
  if (!rows.length || !rows.every((r) => Number.isInteger(r.input_line))) return null;
  const pairs = [];
  for (const r of rows) {
    const line = lines[r.input_line - 1];
    if (!line || line.question !== r.prompt || (line.answer ?? "") !== r.expected_answer) return null;
    pairs.push({ r, line, lineNo: r.input_line });
  }
  return pairs.sort((a, b) => a.lineNo - b.lineNo);
}
