import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../../agent/activity/activity-event.js";
import type { AgentCommandExecutionObservedEvent } from "../../../agent/command-execution/command-execution-events.js";
import type { TuiState } from "../tui-store.js";

/** Reduced activity item used by the compact activity strip. */
export interface TuiAgentActivityStripItem {
  activityId: string;
  role: ScoutAgentRole;
  label: string;
  taskId?: string;
  type: string;
  activity: string;
  markdown: boolean;
  status: string;
  processing: boolean;
}

/** Selects the latest visible activity for the active agent timeline. */
export function selectCurrentAgentActivity(
  state: TuiState,
): TuiAgentActivityStripItem | undefined {
  const latest = latestActivity(state.activities);
  const latestCommand = latestCommandExecution(state.commandExecutions ?? []);
  const latestTurn = latestTurnActivity(state.turnActivities);
  if (!latest && !latestCommand && !latestTurn) return undefined;
  if (latestCommand && (!latest || compareTimelineFacts(latestCommandFact(latestCommand), latest) > 0)) {
    if (!latestTurn || compareTimelineFacts(latestCommandFact(latestCommand), latestTurn) >= 0) {
      return commandPresentation(latestCommand);
    }
  }
  if (latestTurn && (!latest || compareTimelineFacts(latestTurn, latest) > 0)) {
    const item = latestActivity(state.activities.filter((activity) =>
      activity.threadId === latestTurn.threadId
      && activity.turnId === latestTurn.turnId
    ));
    const command = latestCommandExecution((state.commandExecutions ?? []).filter((candidate) =>
      candidate.threadId === latestTurn.threadId
      && candidate.turnId === latestTurn.turnId
    ));
    if (
      latestTurn.status !== "inProgress"
      && command
      && (!item || compareTimelineFacts(latestCommandFact(command), item) > 0)
    ) {
      return commandPresentation(command);
    }
    if (latestTurn.status !== "inProgress" && item) {
      return itemPresentation(item, false, latestTurn.status);
    }
    return turnPresentation(latestTurn);
  }
  if (!latest) return latestTurn ? turnPresentation(latestTurn) : undefined;
  const turn = latest.turnId
    ? state.turnActivities.find((activity) =>
      activity.threadId === latest.threadId
      && activity.turnId === latest.turnId
    )
    : undefined;
  const processing = latest.type !== "contextCompaction"
    && latest.status !== "inProgress"
    && turn?.status === "inProgress";
  return itemPresentation(latest, processing, turn?.status);
}

function itemPresentation(
  activity: AgentActivity,
  processing: boolean,
  turnStatus?: string,
): TuiAgentActivityStripItem {
  const status = activity.type === "commandExecution" && activity.status !== "inProgress"
    ? activity.status
    : turnStatus && turnStatus !== "inProgress"
      ? turnStatus
      : activity.status;
  return {
    activityId: `${activity.agentId}:${activity.threadId}:${activity.turnId ?? "no-turn"}:${activity.itemId}`,
    role: activity.role,
    label: roleLabel(activity.role),
    taskId: activity.taskId,
    type: activity.type,
    activity: `${processing ? "处理中 · " : ""}${activityText(activity, status)}`,
    markdown: activity.type === "reasoning",
    status,
    processing,
  };
}

function turnPresentation(activity: AgentTurnActivity): TuiAgentActivityStripItem {
  const processing = activity.status === "inProgress";
  return {
    activityId: `${activity.agentId}:${activity.threadId}:${activity.turnId}:turn`,
    role: activity.role,
    label: roleLabel(activity.role),
    taskId: activity.taskId,
    type: "turn",
    activity: processing
      ? "处理中"
      : activity.status === "completed"
        ? "处理完成"
        : "处理未完成",
    markdown: false,
    status: activity.status,
    processing,
  };
}

function latestActivity(activities: AgentActivity[]): AgentActivity | undefined {
  return activities.reduce<AgentActivity | undefined>((latest, current) => {
    if (!latest) return current;
    return compareTimelineFacts(current, latest) > 0 ? current : latest;
  }, undefined);
}

function latestTurnActivity(activities: AgentTurnActivity[]): AgentTurnActivity | undefined {
  return activities.reduce<AgentTurnActivity | undefined>((latest, current) => {
    if (!latest) return current;
    return compareTimelineFacts(current, latest) > 0 ? current : latest;
  }, undefined);
}

function latestCommandExecution(
  commands: AgentCommandExecutionObservedEvent[],
): AgentCommandExecutionObservedEvent | undefined {
  return commands.reduce<AgentCommandExecutionObservedEvent | undefined>((latest, current) => {
    if (!latest) return current;
    return compareTimelineFacts(latestCommandFact(current), latestCommandFact(latest)) > 0
      ? current
      : latest;
  }, undefined);
}

function latestCommandFact(command: AgentCommandExecutionObservedEvent): Pick<AgentActivity, "seq" | "updatedAt"> {
  return { seq: command.sourceSeq, updatedAt: command.observedAt };
}

function commandPresentation(command: AgentCommandExecutionObservedEvent): TuiAgentActivityStripItem {
  const label = summarizeCommand(command.command);
  const detail = [
    command.exitCode === undefined || command.exitCode === null ? undefined : `exit_code: ${command.exitCode}`,
  ].filter(Boolean).join(" · ");
  const failed = command.status === "failed"
    || (command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0);
  const status = failed ? "failed" : command.status;
  const execution = failed
    ? "执行失败"
    : command.status === "completed"
      ? "执行完成"
      : `执行未完成(${command.status})`;
  return {
    activityId: `${command.agentId}:${command.threadId}:${command.turnId ?? "no-turn"}:${command.itemId}`,
    role: command.role,
    label: roleLabel(command.role),
    taskId: command.taskId,
    type: "commandExecution",
    activity: `${execution} · ${label}${detail ? ` · ${detail}` : ""}`,
    markdown: false,
    status,
    processing: false,
  };
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const heredocIndex = normalized.search(/<<-?/);
  const summary = heredocIndex >= 0
    ? normalized.slice(0, heredocIndex).trim()
    : normalized;
  return summary.length <= 240 ? summary : `${summary.slice(0, 239)}…`;
}

function compareTimelineFacts(
  left: Pick<AgentActivity, "seq" | "updatedAt">,
  right: Pick<AgentActivity, "seq" | "updatedAt">,
): number {
  if (left.seq !== right.seq) return left.seq - right.seq;
  return left.updatedAt.localeCompare(right.updatedAt);
}

function activityText(activity: AgentActivity, status = activity.status): string {
  const detail = activity.detail?.replace(/\s+/g, " ").trim();
  const label = activity.label.replace(/\s+/g, " ").trim();
  if (activity.type === "reasoning") {
    const state = status === "inProgress" ? "思考" : "已思考";
    return detail ? `${state} · ${detail}` : state;
  }
  if (activity.type === "contextCompaction") {
    if (status === "failed" || status === "blocked" || status === "cancelled") {
      return "上下文压缩失败";
    }
    return status === "inProgress" ? "压缩上下文" : "压缩完成";
  }
  const completedPrefix = status === "inProgress" ? "" : "已执行 · ";
  if (activity.type === "commandExecution") {
    if (status === "inProgress") return label;
    const result = detail ? ` · ${detail}` : "";
    if (status === "failed") return `执行失败 · ${label}${result}`;
    if (status === "completed") return `执行完成 · ${label}${result}`;
    return `执行未完成(${status}) · ${label}${result}`;
  }
  if (activity.type === "mcpToolCall") {
    return `${completedPrefix}${detail ? `${label} ${detail}` : label}`;
  }
  if (activity.type === "fileChange") {
    return `${completedPrefix}${detail ? `文件变更 · ${detail}` : "文件变更"}`;
  }
  return detail || label;
}

function roleLabel(role: ScoutAgentRole): string {
  const label = role.replace(/[^A-Za-z0-9]/g, "").slice(0, 5).toUpperCase();
  return label || "ROLE";
}
