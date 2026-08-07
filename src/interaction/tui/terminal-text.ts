/** Truncates by terminal cell width and appends an ellipsis when needed. */
export function truncateByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (terminalDisplayWidth(value) <= maxWidth) return value;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  const output: string[] = [];
  let width = 0;
  for (const char of value) {
    const charWidth = terminalDisplayWidth(char);
    if (width + charWidth > maxWidth - 3) break;
    width += charWidth;
    output.push(char);
  }
  return `${output.join("")}...`;
}

/** Counts terminal cells, treating combining and wide code points accordingly. */
export function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (isZeroWidthCodePoint(char.codePointAt(0) ?? 0)) continue;
    width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/** Keeps the rightmost terminal cells so identifiers remain inspectable. */
export function tailByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const chars = Array.from(value);
  let width = 0;
  const output: string[] = [];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? "";
    const charWidth = terminalDisplayWidth(char);
    if (width + charWidth > maxWidth) break;
    width += charWidth;
    output.push(char);
  }
  return output.reverse().join("");
}

/** Wraps text at terminal-cell boundaries while preserving explicit newlines. */
export function wrapByDisplayWidth(value: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  return value.split("\n").flatMap((source) => {
    if (source.length === 0) return [""];
    const lines: string[] = [];
    let line = "";
    let width = 0;
    for (const char of source) {
      const charWidth = terminalDisplayWidth(char);
      if (line.length > 0 && width + charWidth > maxWidth) {
        lines.push(line);
        line = "";
        width = 0;
      }
      line += char;
      width += charWidth;
    }
    if (line.length > 0) lines.push(line);
    return lines.length > 0 ? lines : [""];
  });
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7f && codePoint < 0xa0)
    || (codePoint >= 0x300 && codePoint <= 0x36f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f);
}

function isWideCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}
