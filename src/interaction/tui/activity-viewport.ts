/** Parsed SGR mouse packet used by the TUI's scroll and input handlers. */
export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  released: boolean;
}

/** Clamps an activity viewport to the available rows; null means follow the latest row. */
export function resolveActivityScrollTop(
  totalRows: number,
  viewportRows: number,
  requestedTop: number | null,
): number {
  const maxTop = Math.max(0, totalRows - Math.max(1, viewportRows));
  return requestedTop === null ? maxTop : Math.min(maxTop, Math.max(0, requestedTop));
}

/** Applies a wheel delta and returns null when the viewport has reached the live tail. */
export function scrollActivity(
  totalRows: number,
  viewportRows: number,
  requestedTop: number | null,
  delta: number,
): number | null {
  const maxTop = Math.max(0, totalRows - Math.max(1, viewportRows));
  const currentTop = resolveActivityScrollTop(totalRows, viewportRows, requestedTop);
  const nextTop = Math.min(maxTop, Math.max(0, currentTop + delta));
  return nextTop >= maxTop ? null : nextTop;
}

/** Parses one SGR mouse sequence, returning undefined for keyboard or malformed input. */
export function parseSgrMouseEvent(input: string): SgrMouseEvent | undefined {
  const match = /^(?:\u001b)?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return undefined;
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    released: match[4] === "m",
  };
}

/** Converts a wheel packet into a signed row delta, ignoring non-wheel buttons. */
export function mouseWheelDelta(event: SgrMouseEvent, step = 3): number | undefined {
  if ((event.button & 64) === 0) return undefined;
  return (event.button & 1) === 0 ? -step : step;
}
