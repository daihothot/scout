import {
  marked,
  type Token,
  type Tokens,
} from "marked";
import { terminalDisplayWidth } from "./terminal-text.js";

export interface TerminalMarkdownStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dimColor?: boolean;
  color?: "cyan" | "yellow" | "gray" | "#c1beb0" | "#a898a9";
  inverse?: boolean;
}

export interface TerminalMarkdownSpan {
  text: string;
  style?: TerminalMarkdownStyle;
}

export interface TerminalMarkdownLine {
  kind: "text" | "heading" | "code" | "quote" | "rule" | "blank";
  spans: TerminalMarkdownSpan[];
}

export function buildTerminalMarkdownLines(
  source: string,
  width: number,
): TerminalMarkdownLine[] {
  const normalizedWidth = Math.max(1, width);
  try {
    const tokens = marked.lexer(source, {
      breaks: true,
      gfm: true,
    });
    return trimBlankLines(renderBlocks(tokens, normalizedWidth));
  } catch {
    return wrapSpans([{ text: source }], normalizedWidth, "text");
  }
}

function renderBlocks(tokens: Token[], width: number): TerminalMarkdownLine[] {
  const output: TerminalMarkdownLine[] = [];
  for (const token of tokens) {
    if (token.type === "space" || token.type === "def") continue;
    const block = renderBlock(token, width);
    if (block.length === 0) continue;
    appendBlock(output, block);
  }
  return output;
}

function renderBlock(token: Token, width: number): TerminalMarkdownLine[] {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return wrapSpans(
        applyStyle(inlineSpans(heading.tokens), headingStyle(heading.depth)),
        width,
        "heading",
      );
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return wrapSpans(inlineSpans(paragraph.tokens), width, "text");
    }
    case "text": {
      const text = token as Tokens.Text;
      return wrapSpans(
        text.tokens ? inlineSpans(text.tokens) : [{ text: text.text }],
        width,
        "text",
      );
    }
    case "code":
      return renderCode(token as Tokens.Code, width);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, width);
    case "list":
      return renderList(token as Tokens.List, width);
    case "hr":
      return [{
        kind: "rule",
        spans: [{ text: "─".repeat(Math.max(1, width)), style: { dimColor: true } }],
      }];
    case "table":
      return renderTable(token as Tokens.Table, width);
    case "html": {
      const html = token as Tokens.HTML | Tokens.Tag;
      return wrapSpans([{ text: html.text }], width, "text");
    }
    default: {
      const generic = token as Token & { tokens?: Token[]; text?: string };
      if (generic.tokens) return renderBlocks(generic.tokens, width);
      return wrapSpans([{ text: generic.text ?? generic.raw }], width, "text");
    }
  }
}

function renderCode(token: Tokens.Code, width: number): TerminalMarkdownLine[] {
  const output: TerminalMarkdownLine[] = [];
  if (token.lang) {
    output.push({
      kind: "code",
      spans: [{ text: `[${token.lang}]`, style: { color: "gray", dimColor: true } }],
    });
  }
  for (const sourceLine of token.text.split("\n")) {
    const lines = wrapSpans([{
      text: sourceLine.length > 0 ? sourceLine : " ",
      style: { color: "#a898a9" },
    }], width, "code");
    output.push(...lines);
  }
  return output;
}

function renderBlockquote(token: Tokens.Blockquote, width: number): TerminalMarkdownLine[] {
  const prefix: TerminalMarkdownSpan = {
    text: "│ ",
    style: { color: "cyan", dimColor: true },
  };
  const body = trimBlankLines(renderBlocks(token.tokens, Math.max(1, width - 2)));
  return body.map((line) => ({
    kind: line.kind === "blank" ? "blank" : "quote",
    spans: line.kind === "blank" ? [] : [prefix, ...line.spans],
  }));
}

function renderList(token: Tokens.List, width: number): TerminalMarkdownLine[] {
  const output: TerminalMarkdownLine[] = [];
  token.items.forEach((item, index) => {
    const marker = item.task
      ? `[${item.checked ? "x" : " "}] `
      : token.ordered
        ? `${Number(token.start || 1) + index}. `
        : "• ";
    const nested = item.tokens.filter((itemToken) => itemToken.type === "list");
    const contentTokens = item.tokens.filter((itemToken) => itemToken.type !== "list");
    const content = blockTokensToInlineSpans(contentTokens);
    const bodyLines = wrapSpans(content, Math.max(1, width - terminalDisplayWidth(marker)), "text");
    bodyLines.forEach((line, lineIndex) => {
      output.push({
        kind: "text",
        spans: [
          {
            text: lineIndex === 0 ? marker : " ".repeat(marker.length),
            style: { color: "cyan" },
          },
          ...line.spans,
        ],
      });
    });
    for (const nestedToken of nested) {
      const nestedLines = renderBlock(nestedToken, Math.max(1, width - 2));
      output.push(...nestedLines.map((line) => ({
        ...line,
        spans: line.kind === "blank" ? [] : [{ text: "  " }, ...line.spans],
      })));
    }
  });
  return output;
}

function renderTable(token: Tokens.Table, width: number): TerminalMarkdownLine[] {
  const rows = [token.header, ...token.rows];
  return rows.flatMap((cells, rowIndex) => {
    const spans = cells.flatMap((cell, cellIndex): TerminalMarkdownSpan[] => [
      ...(cellIndex === 0 ? [] : [{ text: " | ", style: { dimColor: true } }]),
      ...applyStyle(inlineSpans(cell.tokens), rowIndex === 0 ? { bold: true } : {}),
    ]);
    return wrapSpans(spans, width, "text");
  });
}

function blockTokensToInlineSpans(tokens: Token[]): TerminalMarkdownSpan[] {
  const output: TerminalMarkdownSpan[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    const generic = token as Token & { tokens?: Token[]; text?: string };
    const spans = generic.tokens
      ? inlineSpans(generic.tokens)
      : [{ text: generic.text ?? generic.raw }];
    if (output.length > 0 && !output.at(-1)?.text.endsWith(" ")) output.push({ text: " " });
    output.push(...spans);
  }
  return output;
}

function inlineSpans(tokens: Token[], inherited: TerminalMarkdownStyle = {}): TerminalMarkdownSpan[] {
  return tokens.flatMap((token): TerminalMarkdownSpan[] => {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens
          ? inlineSpans(text.tokens, inherited)
          : [{ text: text.text, style: inherited }];
      }
      case "escape": {
        const escape = token as Tokens.Escape;
        return [{ text: escape.text, style: inherited }];
      }
      case "strong": {
        const strong = token as Tokens.Strong;
        return inlineSpans(strong.tokens, mergeStyle(inherited, { bold: true }));
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return inlineSpans(emphasis.tokens, mergeStyle(inherited, { italic: true }));
      }
      case "del": {
        const deletion = token as Tokens.Del;
        return inlineSpans(deletion.tokens, mergeStyle(inherited, { strikethrough: true }));
      }
      case "codespan": {
        const code = token as Tokens.Codespan;
        return [{
          text: code.text,
          style: mergeStyle(inherited, { color: "#c1beb0" }),
        }];
      }
      case "br":
        return [{ text: "\n", style: inherited }];
      case "link": {
        const link = token as Tokens.Link;
        const label = inlineSpans(link.tokens, mergeStyle(inherited, {
          color: "cyan",
          underline: true,
        }));
        return link.text === link.href
          ? label
          : [...label, { text: ` (${link.href})`, style: mergeStyle(inherited, { dimColor: true }) }];
      }
      case "image": {
        const image = token as Tokens.Image;
        return [{
          text: `[image: ${image.text || "untitled"}] (${image.href})`,
          style: mergeStyle(inherited, { color: "cyan", dimColor: true }),
        }];
      }
      case "html": {
        const html = token as Tokens.HTML | Tokens.Tag;
        return [{ text: html.text, style: inherited }];
      }
      default: {
        const generic = token as Token & { tokens?: Token[]; text?: string };
        return generic.tokens
          ? inlineSpans(generic.tokens, inherited)
          : [{ text: generic.text ?? generic.raw, style: inherited }];
      }
    }
  });
}

function wrapSpans(
  spans: TerminalMarkdownSpan[],
  width: number,
  kind: Exclude<TerminalMarkdownLine["kind"], "blank">,
): TerminalMarkdownLine[] {
  const lines: TerminalMarkdownLine[] = [];
  let current: TerminalMarkdownSpan[] = [];
  let currentWidth = 0;
  const pushLine = () => {
    lines.push({ kind, spans: current });
    current = [];
    currentWidth = 0;
  };

  for (const span of spans) {
    for (const char of span.text) {
      if (char === "\n") {
        pushLine();
        continue;
      }
      const charWidth = terminalDisplayWidth(char);
      if (current.length > 0 && currentWidth + charWidth > width) pushLine();
      appendChar(current, char, span.style);
      currentWidth += charWidth;
    }
  }
  if (current.length > 0 || lines.length === 0) pushLine();
  return lines;
}

function appendChar(
  spans: TerminalMarkdownSpan[],
  char: string,
  style: TerminalMarkdownStyle | undefined,
): void {
  const previous = spans.at(-1);
  if (previous && sameStyle(previous.style, style)) {
    previous.text += char;
    return;
  }
  spans.push({ text: char, style });
}

function appendBlock(output: TerminalMarkdownLine[], block: TerminalMarkdownLine[]): void {
  if (output.length > 0 && output.at(-1)?.kind !== "blank") {
    output.push({ kind: "blank", spans: [] });
  }
  output.push(...block);
}

function trimBlankLines(lines: TerminalMarkdownLine[]): TerminalMarkdownLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.kind === "blank") start += 1;
  while (end > start && lines[end - 1]?.kind === "blank") end -= 1;
  return lines.slice(start, end);
}

function headingStyle(depth: number): TerminalMarkdownStyle {
  if (depth === 1) return { bold: true, color: "cyan", underline: true };
  if (depth === 2) return { bold: true, color: "cyan" };
  return { bold: true };
}

function applyStyle(
  spans: TerminalMarkdownSpan[],
  style: TerminalMarkdownStyle,
): TerminalMarkdownSpan[] {
  return spans.map((span) => ({
    ...span,
    style: mergeStyle(span.style, style),
  }));
}

function mergeStyle(
  base: TerminalMarkdownStyle | undefined,
  extra: TerminalMarkdownStyle,
): TerminalMarkdownStyle {
  return { ...(base ?? {}), ...extra };
}

function sameStyle(
  left: TerminalMarkdownStyle | undefined,
  right: TerminalMarkdownStyle | undefined,
): boolean {
  return left?.bold === right?.bold
    && left?.italic === right?.italic
    && left?.underline === right?.underline
    && left?.strikethrough === right?.strikethrough
    && left?.dimColor === right?.dimColor
    && left?.color === right?.color
    && left?.inverse === right?.inverse;
}
