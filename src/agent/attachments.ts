export type AgentAttachmentOrigin =
  | {
    kind: "coordinator";
  }
  | {
    kind: "system";
  };

export interface AgentAttachment {
  type: "queued_command";
  prompt: string;
  origin: AgentAttachmentOrigin;
  isMeta: boolean;
}

export function getAgentPendingMessageAttachments(input: {
  messages: string[];
}): AgentAttachment[] {
  return input.messages.map((message) => ({
    type: "queued_command",
    prompt: message,
    origin: { kind: "coordinator" },
    isMeta: true,
  }));
}

export function renderAttachmentsForPrompt(attachments: AgentAttachment[]): string {
  return attachments
    .map((attachment) => {
      if (attachment.type === "queued_command") {
        return [
          "<queued-command origin=\"coordinator\">",
          attachment.prompt,
          "</queued-command>",
        ].join("\n");
      }
      return attachment.prompt;
    })
    .join("\n\n");
}
