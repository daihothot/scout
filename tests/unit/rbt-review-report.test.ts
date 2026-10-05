import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "assets/scout/skills/domain-rbt-review-pack/scripts/render-review-report.mjs");

test("RBT review report help succeeds without input files", () => {
  for (const helpFlag of ["--help", "-h"]) {
    const output = execFileSync(process.execPath, [script, helpFlag], { encoding: "utf8" });
    assert.match(output, /^Usage:/);
  }
});

test("RBT review report renderer computes overall status and renders all timeline details", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-review-report-"));
  try {
    const input = join(root, "review-result.json");
    const output = join(root, "nested", "review-report.html");
    writeFileSync(input, JSON.stringify({
      bddId: "bdd.example",
      targetVersion: "v1",
      campaignId: "bdd.example/campaign/main",
      executorHistoryRef: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["history", "001.json"] },
      scenarioId: "bdd.example",
      summary: "存在一项需要人工关注的证据。",
      timeline: [
        {
          id: "JR-001",
          title: "预期触发顺序",
          status: "match",
          expected: { order: 1, kind: "stateSnapshot", sourceId: "account-state", signal_refs: ["SR-001"] },
          actual: { recordLocator: "evidence[0]", sequence: 1 },
          comparison: "顺序一致。",
          refs: { journal: ["JR-001"], signal: ["SR-001"], runtime: ["evidence[0]"] },
        },
        {
          id: "SR-001",
          title: "恢复后账号状态",
          status: "warning",
          expected: {
            claim: "恢复完成后账号已初始化。",
            expected_presence: "present",
            observation_scope: "本次 campaign 中恢复完成后的 account-state 快照。",
            fields: [
              { field: "sourceId", role: "locate", expected_value: "account-state", comparison: "equals" },
              { field: "data.state", role: "assert", expected_value: "Initialized", comparison: "equals" },
            ],
          },
          actual: {
            records: [{ sourceId: "account-state", sequence: 1, data: {} }],
            field_comparisons: [{ field: "data.state", actual_value: "<缺少字段>", result: "unresolved" }],
          },
          comparison: "证据不足，无法完整比较。",
          note: "保留为注意。",
          refs: { bdd: ["E-BDD-001#T-01"], signal: ["SR-001"], code: ["E-CODE-001"] },
        },
        {
          id: "SR-002",
          title: "错误不存在",
          status: "not_match",
          expected: "none",
          actual: "error",
          comparison: "出现了预期之外的错误。",
          refs: {},
        },
      ],
    }, null, 2));
    execFileSync(process.execPath, [script, "--input", input, "--output", output], { encoding: "utf8" });
    const html = readFileSync(output, "utf8");
    assert.match(html, /总体结果/);
    assert.match(html, /不通过/);
    assert.match(html, /JR-001/);
    assert.match(html, /SR-001/);
    assert.match(html, /SR-002/);
    assert.match(html, /&lt;缺少字段&gt;/);
    assert.match(html, /signal_refs/);
    assert.match(html, /observation_scope/);
    assert.match(html, /data\.state/);
    assert.match(html, /field_comparisons/);
    assert.match(html, /aria-controls="detail-0"/);
    assert.match(html, /document\.querySelectorAll/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RBT review report renderer rejects invalid timeline points", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-review-report-invalid-"));
  try {
    const input = join(root, "review-result.json");
    const output = join(root, "review-report.html");
    writeFileSync(input, JSON.stringify({
      bddId: "bdd.example",
      targetVersion: "v1",
      campaignId: "campaign",
      executorHistoryRef: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["history", "001.json"] },
      summary: "summary",
      timeline: [{
        id: "EXP-001",
        title: "bad",
        status: "match",
        expected: true,
        actual: true,
        comparison: "bad",
      }],
    }));
    assert.throws(
      () => execFileSync(process.execPath, [script, "--input", input, "--output", output], { encoding: "utf8", stdio: "pipe" }),
      /必须是 JR-\* 或 SR-\*/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const formatDefect of ["missing-summary", "invalid-summary", "empty-summary", "missing-id", "invalid-id", "invalid-id-format", "duplicate-point",
  "missing-title", "invalid-title", "missing-comparison", "invalid-comparison", "missing-expected", "missing-actual", "invalid-note",
  "invalid-refs", "refs-not-object", "refs-nonstring"] as const) {
  test(`RBT review report renderer still rejects ${formatDefect} document formatting`, () => {
    const root = mkdtempSync(join(tmpdir(), "scout-rbt-review-report-format-"));
    try {
      const input = join(root, "review-result.json");
      const output = join(root, "review-report.html");
      const point: Record<string, unknown> = {
        id: "SR-001", title: "Signal", status: "match", expected: true, actual: true, comparison: "Compared evidence",
      };
      const timeline = [point];
      const value: Record<string, unknown> = {
        bddId: "bdd.example", targetVersion: "v1", campaignId: "campaign", executorHistoryRef: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["history", "001.json"] },
        summary: "Comparison facts", timeline,
      };
      let expected: RegExp;
      switch (formatDefect) {
        case "missing-summary": delete value.summary; expected = /summary 必须是非空字符串/; break;
        case "invalid-summary": value.summary = 1; expected = /summary 必须是非空字符串/; break;
        case "empty-summary": value.summary = ""; expected = /summary 必须是非空字符串/; break;
        case "missing-id": delete point.id; expected = /\.id 必须是非空字符串/; break;
        case "invalid-id": point.id = 1; expected = /\.id 必须是非空字符串/; break;
        case "invalid-id-format": point.id = "EXP-001"; expected = /必须是 JR-\* 或 SR-\*/; break;
        case "duplicate-point": timeline.push({ ...point }); expected = /timeline ID 重复/; break;
        case "missing-title": delete point.title; expected = /\.title 必须是非空字符串/; break;
        case "invalid-title": point.title = 1; expected = /\.title 必须是非空字符串/; break;
        case "missing-comparison": delete point.comparison; expected = /\.comparison 必须是非空字符串/; break;
        case "invalid-comparison": point.comparison = 1; expected = /\.comparison 必须是非空字符串/; break;
        case "missing-expected": delete point.expected; expected = /必须包含 expected 和 actual/; break;
        case "missing-actual": delete point.actual; expected = /必须包含 expected 和 actual/; break;
        case "invalid-note": point.note = 1; expected = /\.note 必须是字符串/; break;
        case "invalid-refs": point.refs = { runtime: 1 }; expected = /\.refs\.runtime 必须是字符串数组/; break;
        case "refs-not-object": point.refs = []; expected = /\.refs 必须是对象/; break;
        case "refs-nonstring": point.refs = { runtime: [1] }; expected = /\.refs\.runtime 必须是字符串数组/; break;
      }
      writeFileSync(input, JSON.stringify(value));
      assert.throws(
        () => execFileSync(process.execPath, [script, "--input", input, "--output", output], { encoding: "utf8", stdio: "pipe" }),
        expected,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("RBT review report renderer applies pass and attention totals", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-review-report-totals-"));
  try {
    const input = join(root, "review-result.json");
    const output = join(root, "review-report.html");
    const base = {
      bddId: "bdd.example",
      targetVersion: "v1",
      campaignId: "campaign",
      executorHistoryRef: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["history", "001.json"] },
      summary: "summary",
    };
    const render = (status: "match" | "warning") => {
      writeFileSync(input, JSON.stringify({
        ...base,
        timeline: [{
          id: "SR-001",
          title: "点",
          status,
          expected: true,
          actual: status === "match" ? true : null,
          comparison: "comparison",
        }],
      }));
      execFileSync(process.execPath, [script, "--input", input, "--output", output], { encoding: "utf8" });
      return readFileSync(output, "utf8");
    };
    assert.match(render("match"), /总体结果<\/small><strong>通过<\/strong>/);
    assert.match(render("warning"), /总体结果<\/small><strong>注意<\/strong>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
