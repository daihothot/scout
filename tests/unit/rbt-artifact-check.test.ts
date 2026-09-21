import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tool = join(process.cwd(), "assets/codex/tools/scout-rbt-artifact-check/cli.cjs");
const templates = join(process.cwd(), "assets/codex/skills/domain-rbt-execution-pack/templates");

test("scout-rbt-artifact-check help succeeds without a pack", () => {
  for (const helpFlag of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [tool, helpFlag], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage:/);
  }
});

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = join(root, "sample.bdd", "26.9.0", "execute-pack");
  mkdirSync(join(pack, "evidence"), { recursive: true });
  // Fill the actual templates, so metadata/table drift is visible in this test.
  const put = (template: string, target: string, values: Record<string, string>) => {
    let text = readFileSync(join(templates, template), "utf8");
    text = text.replace(/<[^<>\n]+>/g, token => values[token] ?? (token === "<human-response>" ? token : "confirmed"));
    text = text.replace(/^- limitations: confirmed$/gm, "- limitations: none");
    writeFileSync(join(pack, target), text);
  };
  put("bdd-evidence.md", "bdd-evidence.md", {
    "<填写唯一 BDD ID 原始值>": "sample.bdd",
    "<逐项填写 BDD 明确要求的前置状态；技术值保持原样>": "G-001: configuration is available",
    "<逐项填写 BDD 明确要求的触发动作；command 和技术值保持原样>": "W-001: invoke the getter",
    "<逐项填写 BDD 明确要求的预期行为；技术值保持原样>": "T-001: returns configured value",
  });
  put("source-code-evidence.md", "evidence/E-CODE-001.md", {
    "<填写当前 managed codebase 的版本号>": "26.9.0",
    "<填写相对 managed codebase 的源码路径>": "Runtime/Sample.Behaviors.cs",
    "<填写 version:source_relative_file>": "26.9.0:Runtime/Sample.Behaviors.cs",
    "<填写 symbol 起始行号>": "10", "<填写 symbol 结束行号>": "20",
    "<填写支撑 source symbol evidence claim 的关键行号>": "12",
    "<填写当前源码中的完整 symbol signature>": "Read<T>(string key)",
  });
  put("journal-expected.md", "journal-expected.md", {
    "<本次 campaignId 原始值>": "sample/campaign/main", "<本次 scenarioId 原始值>": "sample",
    "<wire kind>": "response_payload", "<Node ID 或 none>": "none",
    "<Variant ID 或 none>": "none", "<Source ID 或 none>": "sample.trigger", "<Capture ID 或 none>": "none",
  });
  mutate(pack, "journal-expected.md", text => text.replace(/^\| 2 \| JR-002.*\n/m, ""));
  put("signal-expected.md", "signal-expected.md", {
    "<E-BDD-001 中对应的 G-*/W-*/T-* locators>": "E-BDD-001#T-001",
    "<Executor 已保存的 E-CODE-*；仅追溯依据，不要求 Reviewer 回读源码>": "E-CODE-001",
    "<present 或 absent>": "present", "<本次 campaignId>": "sample/campaign/main", "<本次 scenarioId>": "sample",
  });
  mutate(pack, "signal-expected.md", text => text.replace(/^\| <实际.*$/m,
    "| kind | locate | response_payload | exact |\n| sourceId | locate | sample.trigger | exact |\n| data.value | assert | expected | exact |"));
  appendSignal(pack, "SR-002", [
    "| campaignId | locate | sample/campaign/main | exact |",
    "| scenarioId | locate | sample | exact |",
    "| kind | locate | behavior_trace | exact |",
    "| id | locate | growth.remote_config.get_string | exact |",
    "| result | assert | success | semantic |",
  ].join("\n"));
  appendJournal(pack, "| none | JR-002 | behavior_trace | growth.remote_config.get_string | none | none | none | SR-002 |");
  put("human-input-evidence.md", "human-input-evidence.md", {});
  mutate(pack, "human-input-evidence.md", text => text.replace(/## Human Input Records[\s\S]*?(?=## Evidence Boundary)/,
    "## Human Input Records\n\nnone\n\n"));
  writeFileSync(join(dirname(pack), "execute-file.json"), JSON.stringify({ commands: [
    { command: "behavior.campaign.start", payload: { campaignId: "sample/campaign/main", scenarioId: "sample" } },
    { command: "behavior.scenario.activate", payload: { scenarioId: "sample", rootId: "growth.remote_config.get_string", activations: [] } },
    { command: "behavior.trigger.invoke", payload: { scenarioId: "sample", triggerCommandId: "sample.trigger", params: {} } },
    { command: "behavior.scenario.deactivate", payload: { scenarioId: "sample" } },
    { command: "behavior.campaign.stop", payload: { campaignId: "sample/campaign/main" } },
  ] }));
  return pack;
}

function mutate(pack: string, file: string, fn: (text: string) => string): void {
  const target = join(pack, file);
  writeFileSync(target, fn(readFileSync(target, "utf8")));
}

function mutateExecute(pack: string, fn: (plan: { commands: Array<{ payload: Record<string, unknown> }> }) => void): void {
  const target = join(pack, "..", "execute-file.json");
  const plan = JSON.parse(readFileSync(target, "utf8"));
  fn(plan);
  writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`);
}

function check(pack: string) {
  return spawnSync(process.execPath, [tool, "pack", pack, "--bdd-id", "sample.bdd", "--target-version", "26.9.0"], { encoding: "utf8" });
}

function appendSignal(pack: string, id: string, rows: string): void {
  mutate(pack, "signal-expected.md", text => text.replace("## Rules", `## ${id}

- signal_ref: signal-rbt-evidence
- claim: verify planned execution evidence
- bdd_refs: E-BDD-001#G-001
- expected_presence: present
- observation_scope: sample/campaign/main and sample
- code_refs: E-CODE-001
- limitations: none

### Fields

| field | role | expected_value | comparison |
| --- | --- | --- | --- |
${rows}

## Rules`));
}

function appendJournal(pack: string, row: string): void {
  mutate(pack, "journal-expected.md", text => text.replace("\n## Rules", `\n${row}\n\n## Rules`));
}

test("RBT checker accepts filled current templates and does not inspect source or business expected values", t => {
  const pack = fixture(t);
  const result = check(pack);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rbt_pack_valid=true/);
  mutate(pack, "signal-expected.md", text => text.replace("| expected | exact |", "| entirely different business value | exact |"));
  assert.equal(check(pack).status, 0);
});

test("RBT checker rejects an incomplete Pack without executable inputs", t => {
  const pack = fixture(t);
  rmSync(join(dirname(pack), "execute-file.json"));
  const result = check(pack);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXECUTE_FILE/);
});

const failures: Array<[string, string, string, (text: string) => string]> = [
  ["duplicate SR", "signal-expected.md", "DUPLICATE_ID", text => text.replace("## Rules", text.match(/## SR-001[\s\S]*?(?=## Rules)/)![0] + "## Rules")],
  ["dangling JR", "journal-expected.md", "DANGLING_REF", text => text.replace("| SR-001 |", "| SR-999 |")],
  ["absent JR", "signal-expected.md", "ABSENT_JOURNAL", text => text.replace("expected_presence: present", "expected_presence: absent")],
  ["source version", "evidence/E-CODE-001.md", "VERSION_MISMATCH", text => text.replace(/26\.9\.0/g, "26.8.0")],
  ["artifact version", "signal-expected.md", "ARTIFACT_VERSION", text => text.replace("artifact_version: 4", "artifact_version: 3")],
  ["artifact state", "bdd-evidence.md", "ARTIFACT_STATE", text => text.replace("artifact_version: 1", "artifact_version: 1\nstatus: ready")],
  ["reverse reference", "evidence/E-CODE-001.md", "REVERSE_REF", text => text + "\n- consumers: SR-001\n"],
  ["JR identity", "journal-expected.md", "JOURNAL_IDENTITY", text => text.replace("| response_payload |", "| behavior_trace |")],
  ["scope", "signal-expected.md", "QUERY_SCOPE", text => text.replace("| sample/campaign/main |", "| other |")],
  ["unfilled template", "bdd-evidence.md", "PLACEHOLDER", text => text.replace("bdd_id: sample.bdd", "bdd_id: <填写唯一 BDD ID 原始值>")],
  ["source lines", "evidence/E-CODE-001.md", "SOURCE_LINES", text => text.replace("end_line: 20", "end_line: 2")],
  ["BDD locator", "signal-expected.md", "BDD_LOCATOR", text => text.replace("#T-001", "#T-999")],
  ["missing claim", "signal-expected.md", "INCOMPLETE_FIELD", text => text.replace(/^- claim: .*$/m, "- claim: none")],
  ["invalid SR id", "signal-expected.md", "INVALID_ID", text => text + "\n## SR-invalid\n\ninvalid\n"],
];
for (const [name, file, code, change] of failures) {
  test(`RBT checker rejects ${name}`, t => {
    const pack = fixture(t);
    mutate(pack, file, change);
    const result = check(pack);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`\\[${code}\\]`));
  });
}

test("RBT checker rejects extra artifacts and symlinked evidence", t => {
  const pack = fixture(t);
  writeFileSync(join(pack, "execution-pack.md"), "old aggregate");
  symlinkSync(join(pack, "bdd-evidence.md"), join(pack, "evidence/E-CODE-002.md"));
  const result = check(pack);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXTRA_ARTIFACT/);
  assert.match(result.stderr, /READ_ERROR/);
});

test("RBT checker rejects execute-file scope/order without invoking any command", t => {
  const pack = fixture(t);
  mutate(pack, "../execute-file.json", text => text.replace('"behavior.scenario.activate"', '"behavior.registry.nodes"'));
  assert.match(check(pack).stderr, /EXECUTE_FILE/);
});

test("RBT checker allows multiple present SRs per JR and standalone absence", t => {
  const pack = fixture(t);
  mutate(pack, "signal-expected.md", text => {
    const sr = text.match(/## SR-001[\s\S]*?(?=## SR-|## Rules)/)![0];
    return text.replace("## Rules", sr.replace("SR-001", "SR-003") +
      sr.replace("SR-001", "SR-004").replace("expected_presence: present", "expected_presence: absent") + "## Rules");
  });
  mutate(pack, "journal-expected.md", text => text.replace("| 1 | JR-001", "| none | JR-001").replace("| SR-001 |", "| SR-001, SR-003 |"));
  const result = check(pack);
  assert.equal(result.status, 0, result.stderr);
});

test("RBT checker rejects activation without matching behavior trace SR and JR", t => {
  const pack = fixture(t);
  mutateExecute(pack, plan => {
    plan.commands[1]!.payload.activations = [{ id: "sample.default", variantId: "mock_by_key", params: {} }];
  });
  let result = check(pack);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[UNCOVERED_ACTIVATION\]/);

  appendSignal(pack, "SR-003", [
    "| campaignId | locate | sample/campaign/main | exact |",
    "| scenarioId | locate | sample | exact |",
    "| kind | locate | behavior_trace | exact |",
    "| id | locate | sample.default | exact |",
    "| variantId | locate | mock_by_key | exact |",
  ].join("\n"));
  result = check(pack);
  assert.match(result.stderr, /\[UNCOVERED_ACTIVATION\]/);

  mutate(pack, "signal-expected.md", text => text.replace(
    "| variantId | locate | mock_by_key | exact |",
    "| variantId | locate | mock_by_key | exact |\n| result | assert | success | exact |",
  ));
  result = check(pack);
  assert.doesNotMatch(result.stderr, /\[UNCOVERED_ACTIVATION\]/);
  assert.match(result.stderr, /\[UNJOURNALED_PRESENT_SIGNAL\]/);

  appendJournal(pack, "| none | JR-003 | behavior_trace | sample.default | mock_by_key | none | none | SR-003 |");
  assert.equal(check(pack).status, 0);
});

test("RBT checker rejects capture without matching capture result SR and JR", t => {
  const pack = fixture(t);
  mutateExecute(pack, plan => {
    plan.commands[1]!.payload.evidenceCapture = {
      enabled: true,
      captures: [{
        captureId: "sample-before",
        nodeId: "sample.node",
        timing: "before",
        sourceId: "sample.source",
        kind: "state_snapshot",
      }],
    };
  });
  let result = check(pack);
  assert.match(result.stderr, /\[UNCOVERED_CAPTURE\]/);

  appendSignal(pack, "SR-003", [
    "| campaignId | locate | sample/campaign/main | exact |",
    "| scenarioId | locate | sample | exact |",
    "| kind | locate | capture_result | exact |",
    "| id | locate | sample.node | exact |",
    "| sourceId | locate | sample.source | exact |",
    "| captureId | locate | sample-before | exact |",
  ].join("\n"));
  appendJournal(pack, "| none | JR-003 | capture_result | sample.node | none | sample.source | sample-before | SR-003 |");
  assert.equal(check(pack).status, 0);
});

test("RBT checker rejects a rootId without a matching main behavior trace", t => {
  const pack = fixture(t);
  mutateExecute(pack, plan => {
    plan.commands[1]!.payload.rootId = "growth.remote_config.wrong";
  });
  const result = check(pack);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[UNCOVERED_ROOT\]/);
});

test("RBT checker validates capture variant identity and unique captureId", t => {
  const pack = fixture(t);
  mutateExecute(pack, plan => {
    plan.commands[1]!.payload.evidenceCapture = {
      enabled: true,
      captures: [
        { captureId: "sample-before", nodeId: "sample.node", timing: "before", variantId: "expected", sourceId: "sample.source", kind: "state_snapshot" },
        { captureId: "sample-before", nodeId: "sample.node", timing: "after", sourceId: "sample.source", kind: "state_snapshot" },
      ],
    };
  });
  appendSignal(pack, "SR-003", [
    "| campaignId | locate | sample/campaign/main | exact |",
    "| scenarioId | locate | sample | exact |",
    "| kind | locate | capture_result | exact |",
    "| id | locate | sample.node | exact |",
    "| variantId | locate | other | exact |",
    "| sourceId | locate | sample.source | exact |",
    "| captureId | locate | sample-before | exact |",
  ].join("\n"));
  appendJournal(pack, "| none | JR-003 | capture_result | sample.node | other | sample.source | sample-before | SR-003 |");
  const result = check(pack);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[UNCOVERED_CAPTURE\]/);
  assert.match(result.stderr, /\[DUPLICATE_EXECUTE_IDENTITY\]/);
});

test("RBT checker rejects trigger without matching response payload SR and JR", t => {
  const pack = fixture(t);
  mutate(pack, "signal-expected.md", text => text.replace(
    "| kind | locate | response_payload | exact |",
    "| kind | locate | behavior_trace | exact |",
  ));
  mutate(pack, "journal-expected.md", text => text.replace(
    "| response_payload |",
    "| behavior_trace |",
  ));
  const result = check(pack);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[UNCOVERED_TRIGGER\]/);
});

test("RBT checker rejects pending Human Input and requires response refs for resolved input", t => {
  const pack = fixture(t);
  mutate(pack, "human-input-evidence.md", text => text.replace("## Human Input Records\n\nnone", `## Human Input Records

### HI-001

- request_id: request-accepted-42
- task_id: task-17
- reason: clarify a missing observation
- question: which observation applies?
- status: pending
- response_ref: none
- response_summary: none
- effect_on_plan: none
- related_refs: E-BDD-001, E-CODE-001, SR-001, JR-001`));
  assert.match(check(pack).stderr, /PENDING_HUMAN_INPUT/);
  mutate(pack, "human-input-evidence.md", text => text.replace("status: pending", "status: resolved"));
  assert.match(check(pack).stderr, /HUMAN_RESPONSE/);
  mutate(pack, "human-input-evidence.md", text => text.replace("response_ref: none", "response_ref: message-58"));
  assert.equal(check(pack).status, 0);
});

test("RBT checker smoke and usage are bounded", () => {
  const smoke = spawnSync(process.execPath, [tool, "--smoke"], { encoding: "utf8" });
  assert.equal(smoke.status, 0);
  assert.equal(smoke.stdout.trim(), "SCOUT_RBT_ARTIFACT_CHECK_OK");
  assert.equal(spawnSync(process.execPath, [tool], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [tool, "pack", "unused", "--bdd-id", "sample.bdd", "--target-version", "26.9.0", "--status", "partial"], { encoding: "utf8" }).status, 2);
});
