import type { RuntimeQueuedCommand } from "../../core/queue/message-queue.js";
import { escapeXml, indentXmlText } from "./xml.js";

export function renderQueuedCommands(commands: RuntimeQueuedCommand[]): string {
  return [
    "<queued-commands>",
    ...commands.map((command) => [
      `  <command id="${escapeXml(command.id)}" type="${escapeXml(command.type)}" priority="${escapeXml(command.priority)}">`,
      indentXmlText(command.payload, "    "),
      "  </command>",
    ].join("\n")),
    "</queued-commands>",
  ].join("\n");
}
