#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STATUS = new Set(["match", "warning", "not_match"]);
const ID_PATTERN = /^(?:JR|SR)-[0-9]+$/;

main(process.argv.slice(2));

function main(args) {
  if (args.length === 1 && args[0] === "--smoke") {
    process.stdout.write("RBT_REVIEW_REPORT_OK\n");
    return;
  }
  const { input, output } = parseArgs(args);
  const review = readReview(input);
  const result = calculateOverall(review.timeline);
  const html = renderHtml(review, result);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, html, "utf8");
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--input" && flag !== "--output") {
      throw new Error(`未知参数: ${flag ?? "none"}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} 需要路径。`);
    if (values.has(flag)) throw new Error(`${flag} 不能重复。`);
    values.set(flag, value);
    index += 1;
  }
  const input = values.get("--input");
  const output = values.get("--output");
  if (!input || !output) throw new Error("必须同时提供 --input 和 --output。" );
  return { input, output };
}

function readReview(input) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(input, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 review-result.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new Error("review-result.json 必须是对象。");
  for (const field of ["bddId", "targetVersion", "campaignId", "executorHistoryRef", "summary"]) {
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      throw new Error(`${field} 必须是非空字符串。`);
    }
  }
  if (parsed.scenarioId !== undefined && typeof parsed.scenarioId !== "string") {
    throw new Error("scenarioId 必须是字符串。");
  }
  if (!Array.isArray(parsed.timeline) || parsed.timeline.length === 0) {
    throw new Error("timeline 必须是非空数组。");
  }
  const ids = new Set();
  const timeline = parsed.timeline.map((point, index) => validatePoint(point, index, ids));
  return {
    bddId: parsed.bddId,
    targetVersion: parsed.targetVersion,
    campaignId: parsed.campaignId,
    executorHistoryRef: parsed.executorHistoryRef,
    ...(parsed.scenarioId ? { scenarioId: parsed.scenarioId } : {}),
    summary: parsed.summary,
    timeline,
  };
}

function validatePoint(point, index, ids) {
  if (!isObject(point)) throw new Error(`timeline[${index}] 必须是对象。`);
  for (const field of ["id", "title", "status", "comparison"]) {
    if (typeof point[field] !== "string" || point[field].trim() === "") {
      throw new Error(`timeline[${index}].${field} 必须是非空字符串。`);
    }
  }
  if (!ID_PATTERN.test(point.id)) throw new Error(`timeline[${index}].id 必须是 JR-* 或 SR-*。`);
  if (ids.has(point.id)) throw new Error(`timeline ID 重复: ${point.id}`);
  ids.add(point.id);
  if (!STATUS.has(point.status)) throw new Error(`timeline[${index}].status 无效: ${point.status}`);
  if (!Object.hasOwn(point, "expected") || !Object.hasOwn(point, "actual")) {
    throw new Error(`timeline[${index}] 必须包含 expected 和 actual。`);
  }
  if (point.note !== undefined && typeof point.note !== "string") {
    throw new Error(`timeline[${index}].note 必须是字符串。`);
  }
  if (point.refs !== undefined) validateRefs(point.refs, index);
  return {
    id: point.id,
    title: point.title,
    status: point.status,
    expected: point.expected,
    actual: point.actual,
    comparison: point.comparison,
    ...(point.note ? { note: point.note } : {}),
    refs: normalizeRefs(point.refs),
  };
}

function validateRefs(refs, index) {
  if (!isObject(refs)) throw new Error(`timeline[${index}].refs 必须是对象。`);
  for (const key of ["journal", "signal", "runtime", "code"]) {
    if (refs[key] !== undefined && (!Array.isArray(refs[key]) || !refs[key].every((value) => typeof value === "string"))) {
      throw new Error(`timeline[${index}].refs.${key} 必须是字符串数组。`);
    }
  }
}

function normalizeRefs(refs) {
  return Object.fromEntries(["journal", "signal", "runtime", "code"].map((key) => [
    key,
    refs?.[key] ?? [],
  ]));
}

function calculateOverall(timeline) {
  if (timeline.some((point) => point.status === "not_match")) return "fail";
  if (timeline.some((point) => point.status === "warning")) return "attention";
  return "pass";
}

function renderHtml(review, overall) {
  const labels = {
    pass: { text: "通过", icon: "✓", className: "status-pass" },
    attention: { text: "注意", icon: "!", className: "status-warning" },
    fail: { text: "不通过", icon: "×", className: "status-fail" },
  };
  const overallLabel = labels[overall];
  const counts = Object.fromEntries(["match", "warning", "not_match"].map((status) => [
    status,
    review.timeline.filter((point) => point.status === status).length,
  ]));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(review.bddId)} · RBT 审查报告</title>
<style>${styles()}</style>
</head>
<body>
<main class="report">
  <header class="hero">
    <div>
      <p class="eyebrow">RBT REVIEW REPORT</p>
      <h1>${escapeHtml(review.bddId)}</h1>
      <p class="summary">${escapeHtml(review.summary)}</p>
    </div>
    <div class="overall ${overallLabel.className}">
      <span class="status-icon" aria-hidden="true">${overallLabel.icon}</span>
      <span><small>总体结果</small><strong>${overallLabel.text}</strong></span>
    </div>
  </header>
  <section class="metadata" aria-label="执行信息">
    ${metadataItem("目标版本", review.targetVersion)}
    ${metadataItem("Campaign", review.campaignId)}
    ${metadataItem("Executor 执行历史", review.executorHistoryRef)}
    ${review.scenarioId ? metadataItem("Scenario", review.scenarioId) : ""}
    ${metadataItem("预期点", String(review.timeline.length))}
  </section>
  <section class="legend" aria-label="状态统计">
    ${statItem("match", "匹配", counts.match)}
    ${statItem("warning", "注意", counts.warning)}
    ${statItem("not_match", "不匹配", counts.not_match)}
  </section>
  <section class="timeline-section">
    <div class="section-heading"><h2>预期时间线</h2><span>按 Executor 预期顺序</span></div>
    <div class="timeline">
      ${review.timeline.map((point, index) => renderPoint(point, index, labels)).join("\n")}
    </div>
  </section>
  <footer class="conclusion"><h2>总体说明</h2><p>${escapeHtml(review.summary)}</p></footer>
</main>
<script>${interactionScript()}</script>
</body>
</html>
`;
}

function renderPoint(point, index, labels) {
  const label = labels[point.status === "not_match" ? "fail" : point.status === "warning" ? "attention" : "pass"];
  const refs = Object.entries(point.refs)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `<span><b>${escapeHtml(key)}</b> ${values.map((value) => `<code>${escapeHtml(value)}</code>`).join(" ")}</span>`)
    .join("");
  return `<article class="timeline-item ${label.className}">
  <button class="timeline-point" type="button" aria-expanded="false" aria-controls="detail-${index}">
    <span class="status-icon" aria-hidden="true">${label.icon}</span>
    <span class="point-copy"><strong>${escapeHtml(point.id)}</strong><span>${escapeHtml(point.title)}</span></span>
    <span class="point-status">${statusText(point.status)}</span>
  </button>
  <div class="detail" id="detail-${index}" hidden>
    <div class="detail-grid">
      ${detailValue("预期", point.expected)}
      ${detailValue("实际", point.actual)}
    </div>
    <div class="comparison"><b>匹配说明</b><p>${escapeHtml(point.comparison)}</p></div>
    ${point.note ? `<div class="comparison"><b>补充说明</b><p>${escapeHtml(point.note)}</p></div>` : ""}
    ${refs ? `<div class="refs"><b>定位引用</b>${refs}</div>` : ""}
  </div>
</article>`;
}

function detailValue(label, value) {
  return `<div class="value-block"><b>${label}</b><pre>${escapeHtml(formatValue(value))}</pre></div>`;
}

function metadataItem(label, value) {
  return `<div><span>${label}</span><code>${escapeHtml(value)}</code></div>`;
}

function statItem(status, label, value) {
  const className = status === "match" ? "status-pass" : status === "warning" ? "status-warning" : "status-fail";
  const icon = status === "match" ? "✓" : status === "warning" ? "!" : "×";
  return `<div class="stat"><span class="status-icon ${className}" aria-hidden="true">${icon}</span><span>${label}</span><strong>${value}</strong></div>`;
}

function statusText(status) {
  return status === "match" ? "匹配" : status === "warning" ? "注意" : "不匹配";
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interactionScript() {
  return `document.querySelectorAll('.timeline-point').forEach((button) => {
  button.addEventListener('click', () => {
    const detail = document.getElementById(button.getAttribute('aria-controls'));
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    detail.hidden = expanded;
  });
});`;
}

function styles() {
  return `:root{color-scheme:light;--ink:#17212b;--muted:#687582;--line:#dfe5e9;--panel:#fff;--bg:#f4f7f8;--green:#1d8a5a;--green-bg:#e8f6ef;--yellow:#b77912;--yellow-bg:#fff4d8;--red:#c74444;--red-bg:#fdebec}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.report{max-width:1050px;margin:0 auto;padding:42px 26px 64px}.hero{display:flex;justify-content:space-between;gap:32px;align-items:flex-start;padding:4px 0 30px;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 8px;color:var(--muted);font-size:11px;letter-spacing:1.5px}.hero h1{margin:0;font-size:clamp(24px,4vw,38px);letter-spacing:0}.summary{max-width:720px;margin:10px 0 0;color:var(--muted)}.overall{display:flex;align-items:center;gap:12px;min-width:150px;padding:12px 15px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.overall small,.overall strong{display:block}.overall small{color:var(--muted);font-size:12px}.overall strong{font-size:19px}.status-icon{display:inline-grid;place-items:center;width:30px;height:30px;flex:0 0 30px;border-radius:50%;font-weight:800;font-size:19px;line-height:1}.status-pass .status-icon,.status-icon.status-pass{background:var(--green-bg);color:var(--green)}.status-warning .status-icon,.status-icon.status-warning{background:var(--yellow-bg);color:var(--yellow)}.status-fail .status-icon,.status-icon.status-fail{background:var(--red-bg);color:var(--red)}.metadata{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:24px 0}.metadata>div{padding:13px 15px;background:var(--panel);border:1px solid var(--line);border-radius:7px}.metadata span{display:block;color:var(--muted);font-size:12px}.metadata code{display:block;margin-top:2px;overflow-wrap:anywhere}.legend{display:flex;gap:22px;align-items:center;padding:12px 0 22px;color:var(--muted)}.stat{display:flex;align-items:center;gap:8px}.stat strong{color:var(--ink)}.stat .status-icon{width:22px;height:22px;flex-basis:22px;font-size:14px}.section-heading{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:10px}.section-heading h2,.conclusion h2{margin:0;font-size:20px}.section-heading span{color:var(--muted);font-size:13px}.timeline{position:relative;padding:22px 0 4px 22px}.timeline:before{content:"";position:absolute;left:36px;top:30px;bottom:30px;width:2px;background:var(--line)}.timeline-item{position:relative;margin:0 0 13px}.timeline-point{position:relative;z-index:1;display:flex;align-items:center;width:100%;padding:14px 16px 14px 0;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s}.timeline-point:hover,.timeline-point:focus-visible{border-color:#99aab5;box-shadow:0 3px 10px #17212b12;outline:none}.timeline-point>.status-icon{margin:0 16px 0 -1px}.point-copy{display:flex;flex-direction:column;gap:2px;min-width:0}.point-copy strong{font-size:13px}.point-copy span{color:var(--muted);overflow-wrap:anywhere}.point-status{margin-left:auto;padding-left:12px;color:var(--muted);font-size:13px}.detail{margin:0 0 0 52px;padding:16px;border:1px solid var(--line);border-top:0;border-radius:0 0 8px 8px;background:#fbfcfc}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.value-block,.comparison,.refs{padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:6px}.value-block b,.comparison b,.refs>b{display:block;color:var(--muted);font-size:12px;font-weight:600}.value-block pre{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.comparison,.refs{margin-top:12px}.comparison p{margin:5px 0 0;white-space:pre-wrap}.refs{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.refs>b{width:100%}.refs span{color:var(--muted);font-size:12px}.refs code{margin-left:4px}.conclusion{margin-top:30px;padding:18px 20px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.conclusion p{margin:6px 0 0;color:var(--muted);white-space:pre-wrap}@media(max-width:650px){.report{padding:28px 16px 48px}.hero{display:block}.overall{margin-top:18px}.legend{gap:12px;flex-wrap:wrap}.timeline{padding-left:0}.timeline:before{left:14px}.timeline-point{padding-right:10px}.timeline-point>.status-icon{margin-left:-1px;margin-right:10px}.point-status{padding-left:8px}.detail{margin-left:28px}.detail-grid{grid-template-columns:1fr}}`;
}
