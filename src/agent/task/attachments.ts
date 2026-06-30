export type AgentAttachmentOrigin =
  | {
    kind: "coordinator";
  }
  | {
    kind: "system";
  };

export interface AgentAttachment {
  type: "pending_message";
  prompt: string;
  origin: AgentAttachmentOrigin;
  isMeta: boolean;
}

export function getAgentPendingMessageAttachments(input: {
  messages: string[];
}): AgentAttachment[] {
  return input.messages.map((message) => ({
    type: "pending_message",
    prompt: message,
    origin: { kind: "coordinator" },
    isMeta: true,
  }));
}

export function renderAttachmentsForPrompt(attachments: AgentAttachment[]): string {
  return attachments
    .map((attachment) => {
      if (attachment.type === "pending_message") {
        return [
          "<pending-message origin=\"coordinator\">",
          attachment.prompt,
          "</pending-message>",
        ].join("\n");
      }
      return attachment.prompt;
    })
    .join("\n\n");
}
