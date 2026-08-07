import { ScoutAgentRoles, type ScoutAgentRole } from "../../../agent/thread/types.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../../agent/activity/activity-event.js";
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
  const latestTurn = latestTurnActivity(state.turnActivities);
  if (!latest && !latestTurn) return undefined;
  if (latestTurn && (!latest || compareTimelineFacts(latestTurn, latest) > 0)) {
    const item = latestActivity(state.activities.filter((activity) =>
      activity.threadId === latestTurn.threadId
      && activity.turnId === latestTurn.turnId
    ));
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
  const status = turnStatus && turnStatus !== "inProgress"
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
  if (activity.type === "commandExecution") return `${completedPrefix}${label}`;
  if (activity.type === "mcpToolCall") {
    return `${completedPrefix}${detail ? `${label} ${detail}` : label}`;
  }
  if (activity.type === "fileChange") {
    return `${completedPrefix}${detail ? `文件变更 · ${detail}` : "文件变更"}`;
  }
  return detail || label;
}

function roleLabel(role: ScoutAgentRole): string {
  if (role === ScoutAgentRoles.Coordinator) return "COORD";
  if (role === ScoutAgentRoles.Researcher) return "RES";
  if (role === ScoutAgentRoles.Verifier) return "VER";
  return "VAL";
}
