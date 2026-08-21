import React from "react";
import { Box, Text } from "ink";
import type { TuiCoordinatorStepDrawerItem } from "../selectors/coordinator-steps.js";
import { statusColor } from "../theme.js";
import { terminalDisplayWidth, truncateByDisplayWidth } from "../terminal-text.js";

/** Renders the lifecycle row for a Coordinator step without inventing a task id. */
export function CoordinatorStepRow({ step, width }: {
  step: TuiCoordinatorStepDrawerItem;
  width: number;
}) {
  const display = buildCoordinatorStepDisplay(step, width);
  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Text color="cyan" wrap="truncate-end">{display.title}</Text>
      <Text color={statusColor(step.status)}>{display.status}</Text>
    </Box>
  );
}

/** Builds the plain Coordinator step row used by terminal selection. */
export function buildCoordinatorStepText(
  step: TuiCoordinatorStepDrawerItem,
  width: number,
): string {
  const display = buildCoordinatorStepDisplay(step, width);
  return `${display.title}${" ".repeat(Math.max(0, width - terminalDisplayWidth(display.title) - terminalDisplayWidth(display.status)))}${display.status}`;
}

function buildCoordinatorStepDisplay(
  step: TuiCoordinatorStepDrawerItem,
  width: number,
): { title: string; status: string } {
  const status = truncateByDisplayWidth(step.status, Math.min(width, terminalDisplayWidth(step.status)));
  const statusWidth = terminalDisplayWidth(status);
  const title = truncateByDisplayWidth(
    `  Coordinator  ${step.stepId}${step.turnId ? `  ${step.turnId}` : ""}`,
    Math.max(0, width - statusWidth - (statusWidth > 0 ? 1 : 0)),
  );
  return { title, status };
}

/** Renders the optional plan explanation beneath a Coordinator step. */
export function CoordinatorPlanExplanationRow({ explanation, width }: {
  explanation: string;
  width: number;
}) {
  return <Text dimColor wrap="truncate-end">{"    "}{truncateByDisplayWidth(explanation, Math.max(0, width - 4))}</Text>;
}

/** Builds the plain plan explanation row used by terminal selection. */
export function buildCoordinatorPlanExplanationText(explanation: string, width: number): string {
  return `    ${truncateByDisplayWidth(explanation, Math.max(0, width - 4))}`;
}
