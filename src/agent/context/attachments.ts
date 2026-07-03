export type AgentAttachmentOrigin =
  | {
    kind: "coordinator";
  }
  | {
    kind: "system";
  };

export interface AgentAttachment {
  prompt: string;
  origin: AgentAttachmentOrigin;
  isMeta: boolean;
}

export interface ComposeTaskTurnInputOptions {
  sections: string[];
  attachments?: AgentAttachment[];
}

export function composeAttachmentText(attachments: AgentAttachment[]): string {
  return attachments
    .map((attachment) => attachment.prompt)
    .join("\n\n");
}

export function composeTaskTurnInput(input: ComposeTaskTurnInputOptions): string {
  const sectionText = input.sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const attachmentText = input.attachments && input.attachments.length > 0
    ? composeAttachmentText(input.attachments)
    : "";
  return [...sectionText, attachmentText].filter(Boolean).join("\n\n");
}
