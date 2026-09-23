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
      executorHistoryRef: "history/001.json",
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
      executorHistoryRef: "history/001.json",
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

test("RBT review report renderer applies pass and attention totals", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-review-report-totals-"));
  try {
    const input = join(root, "review-result.json");
    const output = join(root, "review-report.html");
    const base = {
      bddId: "bdd.example",
      targetVersion: "v1",
      campaignId: "campaign",
      executorHistoryRef: "history/001.json",
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
