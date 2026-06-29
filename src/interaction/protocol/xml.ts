export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function readXmlTag(input: string, tag: string): string | undefined {
  return readXmlTags(input, tag)[0];
}

export function readXmlTags(input: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const values: string[] = [];
  let match = pattern.exec(input);
  while (match) {
    const value = unescapeXml((match[1] ?? "").trim());
    if (value) values.push(value);
    match = pattern.exec(input);
  }
  return values;
}

export function indentXmlText(text: string, indent: string): string {
  return text.split("\n").map((line) => `${indent}${escapeXml(line)}`).join("\n");
}
