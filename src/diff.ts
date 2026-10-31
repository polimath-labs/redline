// Line numbers each file adds on the new side of a unified diff.
export function addedLines(diff: string) {
  const added: Record<string, number[]> = {};
  let lines: number[] = [];
  let line = 0;
  let header = false;
  for (const entry of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(entry);
    if (entry.startsWith("diff --git ")) header = true;
    else if (header && entry.startsWith("+++ ")) {
      lines = [];
      if (entry.startsWith("+++ b/")) added[entry.slice(6).replace(/\t$/, "")] = lines;
    } else if (hunk) {
      header = false;
      line = Number(hunk[1]);
    } else if (header) continue;
    else if (entry.startsWith("+")) lines.push(line++);
    else if (entry.startsWith(" ")) line++;
  }
  return added;
}
