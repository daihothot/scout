import { terminalDisplayWidth } from "./terminal-text.js";

/** One currently visible terminal row that can participate in text selection. */
export interface TuiSelectableLine {
  y: number;
  text: string;
}

/** A mouse position expressed in content-local cells and terminal rows. */
export interface TuiSelectionPoint {
  x: number;
  y: number;
}

/** The two endpoints of an active drag selection. */
export interface TuiTextSelection {
  anchor: TuiSelectionPoint;
  focus: TuiSelectionPoint;
}

/** One highlighted segment rendered over a selectable terminal row. */
export interface TuiSelectionSegment {
  y: number;
  startX: number;
  text: string;
}

/** Normalizes a selection so text extraction always proceeds top-to-bottom. */
export function normalizeTuiSelection(selection: TuiTextSelection): {
  start: TuiSelectionPoint;
  end: TuiSelectionPoint;
} {
  const { anchor, focus } = selection;
  if (anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

/** Extracts visible text between two inclusive mouse endpoints. */
export function extractTuiSelectionText(
  lines: TuiSelectableLine[],
  selection: TuiTextSelection,
): string {
  const { start, end } = normalizeTuiSelection(selection);
  const lineByY = new Map(lines.map((line) => [line.y, line.text]));
  const parts: string[] = [];
  for (let y = start.y; y <= end.y; y += 1) {
    const text = lineByY.get(y) ?? "";
    const width = terminalDisplayWidth(text);
    const startX = y === start.y ? Math.min(start.x, width) : 0;
    const endX = y === end.y ? Math.min(end.x + 1, width) : width;
    parts.push(sliceByDisplayCells(text, startX, Math.max(startX, endX)));
  }
  return parts.join("\n");
}

/** Builds the visible highlight segments for an active selection. */
export function buildTuiSelectionSegments(
  lines: TuiSelectableLine[],
  selection: TuiTextSelection | undefined,
): TuiSelectionSegment[] {
  if (!selection) return [];
  const { start, end } = normalizeTuiSelection(selection);
  const lineByY = new Map(lines.map((line) => [line.y, line.text]));
  const segments: TuiSelectionSegment[] = [];
  for (let y = start.y; y <= end.y; y += 1) {
    const text = lineByY.get(y);
    if (text === undefined) continue;
    const width = terminalDisplayWidth(text);
    const startX = y === start.y ? Math.min(start.x, width) : 0;
    const endX = y === end.y ? Math.min(end.x + 1, width) : width;
    if (endX <= startX) continue;
    const alignedStartX = alignDisplayCellStart(text, startX);
    segments.push({
      y,
      startX: alignedStartX,
      text: sliceByDisplayCells(text, startX, endX),
    });
  }
  return segments;
}

/** Writes a standard OSC 52 clipboard payload to the active terminal. */
export function writeTuiClipboard(
  stdout: { write(value: string): unknown },
  value: string,
): void {
  if (value.length === 0) return;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

/** Slices text by terminal cells without splitting a wide code point. */
export function sliceByDisplayCells(value: string, start: number, end: number): string {
  if (end <= start) return "";
  const output: string[] = [];
  let offset = 0;
  let previousCellSelected = false;
  for (const char of value) {
    const charWidth = terminalDisplayWidth(char);
    const charEnd = offset + charWidth;
    if (charWidth === 0) {
      if (previousCellSelected) output.push(char);
      continue;
    }
    previousCellSelected = charEnd > start && offset < end;
    if (previousCellSelected) output.push(char);
    offset = charEnd;
  }
  return output.join("");
}

function alignDisplayCellStart(value: string, position: number): number {
  let offset = 0;
  for (const char of value) {
    const charEnd = offset + terminalDisplayWidth(char);
    if (position >= offset && position < charEnd) return offset;
    offset = charEnd;
  }
  return offset;
}
