export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  released: boolean;
}

export function resolveActivityScrollTop(
  totalRows: number,
  viewportRows: number,
  requestedTop: number | null,
): number {
  const maxTop = Math.max(0, totalRows - Math.max(1, viewportRows));
  return requestedTop === null ? maxTop : Math.min(maxTop, Math.max(0, requestedTop));
}

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

export function mouseWheelDelta(event: SgrMouseEvent, step = 3): number | undefined {
  if ((event.button & 64) === 0) return undefined;
  return (event.button & 1) === 0 ? -step : step;
}
