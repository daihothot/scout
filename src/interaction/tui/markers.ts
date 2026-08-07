/** Maps a run or lifecycle status to the compact marker used in status rows. */
export function statusMarker(status: string | undefined): string {
  if (
    status === "done"
    || status === "complete"
    || status === "completed"
    || status === "passed"
  ) return "+";
  if (status === "failed" || status === "blocked" || status === "stopped") return "!";
  if (status === "running" || status === "inProgress") return ">";
  return "o";
}

/** Maps task state and selection to the drawer's marker glyph. */
export function taskMarker(status: string | undefined, selected: boolean): string {
  if (selected) return "▶";
  if (status === "archived") return "□";
  if (status === "done") return "✓";
  if (status === "failed" || status === "stopped") return "!";
  if (status === "running") return "→";
  return "o";
}

/** Maps a plan-step state to the marker rendered beside its label. */
export function planStepMarker(status: string): string {
  if (status === "completed") return "✓";
  if (status === "inProgress") return "→";
  if (status === "pending") return "·";
  if (status === "failed" || status === "blocked") return "!";
  return "·";
}
