import type { Logger } from "../../core/logging/index.js";

export type AttachmentLogger = Pick<Logger, "error">;

export interface AgentTaggedAttachmentBlock {
  tag: string;
  body: string;
  raw: string;
}

export const attachments = {
  compose(logger: AttachmentLogger | undefined, ...blocks: string[]): string {
    const validBlocks: string[] = [];
    blocks.forEach((block, index) => {
      const trimmed = block.trim();
      if (trimmed.length === 0) return;
      if (isValidAttachmentBlock(trimmed)) {
        validBlocks.push(trimmed);
        return;
      }
      logger?.error({
        module: "agent.context",
        event: "invalid_attachment_block",
        data: {
          index,
          reason: "Attachment block must be one or more complete tag blocks.",
          preview: previewAttachmentBlock(trimmed),
        },
      });
    });
    return validBlocks.join("\n\n");
  },
  addTagBlock(tag: string, body: string): string {
    assertTagName(tag);
    return [
      `<${tag}>`,
      body,
      `</${tag}>`,
    ].join("\n");
  },
  removeTagBlock(text: string, tag: string): string {
    assertTagName(tag);
    return text.replace(tagPattern(tag), (_raw, body: string) => body);
  },
  replaceTagBlock(text: string, tag: string, body: string): string {
    assertTagName(tag);
    return text.replace(tagPattern(tag), [
      `<${tag}>`,
      body,
      `</${tag}>`,
    ].join("\n"));
  },
  readTagBlock(text: string, tag: string): AgentTaggedAttachmentBlock[] {
    assertTagName(tag);
    const blocks: AgentTaggedAttachmentBlock[] = [];
    for (const match of text.matchAll(tagPattern(tag))) {
      blocks.push({
        tag,
        body: match[1] ?? "",
        raw: match[0],
      });
    }
    return blocks;
  },
  haveTagBlock(text: string, tag: string): boolean {
    assertTagName(tag);
    return tagPattern(tag).test(text);
  },
} as const;

function tagPattern(tag: string): RegExp {
  const escapedTag = escapeRegExp(tag);
  return new RegExp(`<${escapedTag}>\\n?([\\s\\S]*?)\\n?<\\/${escapedTag}>`, "g");
}

function anyTagBlockPattern(): RegExp {
  return /<([A-Za-z][A-Za-z0-9_-]*)>\n?([\s\S]*?)\n?<\/\1>/g;
}

function isValidAttachmentBlock(text: string): boolean {
  let cursor = 0;
  let count = 0;
  for (const match of text.matchAll(anyTagBlockPattern())) {
    const index = match.index ?? 0;
    if (text.slice(cursor, index).trim().length > 0) return false;
    count += 1;
    cursor = index + match[0].length;
  }
  return count > 0 && text.slice(cursor).trim().length === 0;
}

function previewAttachmentBlock(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

function assertTagName(tag: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tag)) {
    throw new Error(`Invalid attachment tag: ${tag}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
