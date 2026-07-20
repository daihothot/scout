import type { ScoutAgentRole } from "../../agent/thread/types.js";

export type TuiColor =
  | "blue"
  | "cyan"
  | "gray"
  | "green"
  | "magenta"
  | "red"
  | "white"
  | "yellow";

export function roleColor(role: ScoutAgentRole | string | undefined): TuiColor {
  if (role === "coordinator") return "cyan";
  if (role === "researcher") return "green";
  if (role === "verifier") return "magenta";
  if (role === "validator") return "yellow";
  return "gray";
}

export function statusColor(status: string | undefined): TuiColor {
  if (
    status === "done"
    || status === "complete"
    || status === "completed"
    || status === "passed"
  ) return "green";
  if (status === "failed" || status === "blocked" || status === "stopped") return "red";
  if (status === "running" || status === "inProgress") return "yellow";
  return "gray";
}
