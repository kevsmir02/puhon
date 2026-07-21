import type { Terminal } from "@xterm/headless";

export function snapshotGrid(term: Terminal, title = "untitled"): string {
  const active = term.buffer.active;
  const { cols, rows } = term;
  const out: string[] = [
    `# title: ${title}`,
    `# cursor: [${active.cursorY}, ${active.cursorX}]`,
    `# alt: ${active.type === "alternate"}`,
  ];
  for (let y = 0; y < rows; y++) {
    const line = active.getLine(y);
    let row = "";
    if (line) {
      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x);
        if (!cell) break;
        if (cell.getWidth() > 0) row += cell.getChars();
      }
    }
    out.push(row.replace(/\s+$/, ""));
  }
  return `${out.join("\n")}\n`;
}
