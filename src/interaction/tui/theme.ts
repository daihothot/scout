import type { ScoutAgentRole } from "../../agent/thread/types.js";

/** Palette names accepted by the TUI's semantic color helpers. */
export type TuiColor =
  | "blue"
  | "cyan"
  | "gray"
  | "green"
  | "magenta"
  | "red"
  | "white"
  | "yellow";

/** Selects the stable role color used across task and activity rows. */
export function roleColor(role: ScoutAgentRole | string | undefined): TuiColor {
  if (!role) return "gray";
  const palette = ["cyan", "green", "magenta", "yellow", "blue"] as const;
  const index = [...role].reduce((hash, character) =>
    (hash * 31 + character.codePointAt(0)!) >>> 0, 0
  ) % palette.length;
  return palette[index]!;
}

/** Selects a semantic color for a task or lifecycle status. */
export function statusColor(status: string | undefined): TuiColor {
  if (
    status === "done"
    || status === "complete"
    || status === "completed"
    || status === "passed"
  ) return "green";
  if (
    status === "failed"
    || status === "blocked"
    || status === "stopped"
    || status === "interrupted"
  ) return "red";
  if (status === "running" || status === "inProgress") return "yellow";
  return "gray";
}
