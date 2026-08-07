import { ScoutAgentRoles } from "../../../agent/thread/types.js";
import { attachments } from "../../../agent/context/attachments.js";
import {
  type ResumePacket,
  type ResumePacketInput,
} from "./resume-packet-common.js";
import { buildCoordinatorResumePacket } from "./resume-packet-coordinator.js";
import { buildWorkerResumePacket } from "./resume-packet-worker.js";

/** Hard upper bound for the serialized resume attachment sent to an agent. */
const MAX_PACKET_BYTES = 12 * 1024;

/** Re-exported wire shape used by callers that inspect a built packet. */
export type { ResumePacket } from "./resume-packet-common.js";

/**
 * Selects the role-specific packet, applies deterministic size reduction, and
 * wraps the result in the attachment tag consumed by the agent context layer.
 * It never replays events or starts a thread; an irreducibly oversized packet
 * fails closed instead of silently changing its recovery meaning.
 */
export function buildResumePacket(input: ResumePacketInput): string {
  const packet = input.role === ScoutAgentRoles.Coordinator
    ? buildCoordinatorResumePacket(input)
    : buildWorkerResumePacket(input);
  const rendered = renderPacket(fitPacket(packet));
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes > MAX_PACKET_BYTES) {
    throw new Error(`Resume packet for ${input.agentId} exceeds ${MAX_PACKET_BYTES} bytes: ${bytes}`);
  }
  return attachments.addTagBlock("resume", rendered);
}

/**
 * Removes the least essential history in bounded passes while retaining the
 * identity, recovery actions, and most recent state needed to resume safely.
 */
function fitPacket(packet: ResumePacket): ResumePacket {
  if (packetBytes(packet) <= MAX_PACKET_BYTES) return packet;

  const compact = {
    ...packet,
    resume_actions: packet.resume_actions.slice(-20),
    task: compactTask(packet.task),
    tasks: packet.tasks?.slice(-12).map((task) => omitFields(task, ["description"])),
    reported: packet.reported.slice(-6).map((entry) => omitFields(entry, ["outcome"])),
    confirmed: packet.confirmed.slice(-8).map((entry) =>
      omitFields(entry, ["text", "response"])
    ),
    open: packet.open.slice(-8).map((entry) => omitFields(entry, ["prompt"])),
    artifacts: packet.artifacts.slice(-12),
    pending_messages: packet.pending_messages.slice(-12),
  } satisfies ResumePacket;
  if (packetBytes(compact) <= MAX_PACKET_BYTES) return compact;

  const minimal = {
    ...compact,
    resume_actions: compact.resume_actions.slice(-12),
    tasks: compact.tasks?.slice(-8),
    reported: compact.reported.slice(-2),
    confirmed: compact.confirmed.slice(-4),
    open: compact.open.slice(-4).map((entry) => omitFields(entry, ["body"])),
    artifacts: compact.artifacts.slice(-2),
    pending_messages: compact.pending_messages.slice(-4),
  } satisfies ResumePacket;
  if (packetBytes(minimal) <= MAX_PACKET_BYTES) return minimal;

  return {
    ...minimal,
    resume_actions: minimal.resume_actions.slice(-8),
    tasks: minimal.tasks?.slice(-4),
    reported: minimal.reported.slice(-1),
    confirmed: minimal.confirmed.slice(-2),
    open: minimal.open.slice(-2),
    artifacts: minimal.artifacts.slice(-1),
    pending_messages: minimal.pending_messages.slice(-2),
  };
}

/** Keeps task status and step identity while dropping verbose prompt text. */
function compactTask(
  task: ResumePacket["task"],
): ResumePacket["task"] {
  if (!task) return undefined;
  const compact = omitFields(task, ["initial_prompt"]);
  const currentStep = compact.current_step;
  if (!isRecord(currentStep)) return compact;
  return {
    ...compact,
    current_step: omitFields(currentStep, ["final_response"]),
  };
}

function omitFields(
  value: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const omitted = new Set(fields);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  );
}

function packetBytes(packet: ResumePacket): number {
  return Buffer.byteLength(renderPacket(packet), "utf8");
}

/** Serializes the packet with stable indentation and escapes tag delimiters. */
function renderPacket(packet: ResumePacket): string {
  return JSON.stringify(packet, null, 2).replaceAll("<", "\\u003c");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
