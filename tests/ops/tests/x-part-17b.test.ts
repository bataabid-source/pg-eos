// tests/ops/tests/x-part-17b.test.ts — X part 17 part 2 + part 3 (pg-tester).
//
// Proves scripts/check-master-reads.mjs (+ the .sh wrapper) against tests/ops/x-part-17b.feature.
// Fixtures are JSONL transcripts written to a disposable temp dir. One `it` per Scenario, titled
// verbatim. The 300-case table is an ordinary table-driven unit test, NOT a property test
// (D-208: property tests only for security/stock/money).
//
// No `any`, no eslint-disable, no console.*.

import { afterAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT_MJS = path.join(ROOT, "scripts", "check-master-reads.mjs");
const SCRIPT_SH = path.join(ROOT, "scripts", "check-master-reads.sh");

// ---- named constants ---------------------------------------------------------------------
const EXEC_TIMEOUT_MS = 30_000;
const TMP_PREFIX = "master-reads-";
const EXIT_OK = 0;
const EXIT_STRICT_FINDING = 1;
const EXIT_USAGE = 2;
const DEFAULT_MAX_LINES = 20;
const OVER_LINES = 25;
const AT_LIMIT_LINES = 20;
const CASE_COUNT = 300;
const LCG_SEED = 170_002;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_MODULUS = 2 ** 32;
const MAX_ENTRIES_PER_CASE = 8;
const PR_NUMBER = 228;
const SIDECHAIN_PROBABILITY = 0.5;
const GOVERNED_PROBABILITY = 0.5;
const ABSOLUTE_PROBABILITY = 0.5;
const RESULT_PROBABILITY = 0.5;
const MAX_RESULT_LINES = 30;
const ABS_PREFIX = "/home/user/pg-eos/";
const MISSING_PATH = "/nonexistent-dir-x17b/session.jsonl";

const CHANGELOG = "docs/CHANGELOG.md";
const BACKLOG = "tasks/MASTER_BACKLOG.md";
const HANDOVER = "docs/notes/handover-master.md";
const HANDOVER_CORE = "docs/notes/handover-core.md";
const DOMAIN_FILE = "modules/wms/domain/x.ts";
const BRIEF_FILE = "docs/notes/slice-briefs/_slice-x.brief.md";
const GOVERNED_PATHS = [CHANGELOG, BACKLOG, HANDOVER, HANDOVER_CORE];
const OTHER_PATHS = [DOMAIN_FILE, BRIEF_FILE];
const LINE1_RE =
  /^master-reads: (\d+) inline read\(s\) of governed content in (\d+) main-thread tool calls; (\d+) result\(s\) over (\d+) lines$/;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---- fixture helpers ---------------------------------------------------------------------
type ToolUseOpts = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  sidechain?: boolean;
};
type ResultOpts = { id: string; text: string; asBlocks?: boolean };
type Entry = Record<string, unknown>;

function entry(kind: "tool_use", opts: ToolUseOpts): Entry;
function entry(kind: "tool_result", opts: ResultOpts): Entry;
function entry(
  kind: "tool_use" | "tool_result",
  opts: ToolUseOpts | ResultOpts,
): Entry {
  if (kind === "tool_use") {
    const o = opts as ToolUseOpts;
    return {
      type: "assistant",
      isSidechain: o.sidechain === true,
      message: {
        content: [{ type: "tool_use", id: o.id, name: o.name, input: o.input }],
      },
    };
  }
  const o = opts as ResultOpts;
  return {
    type: "user",
    isSidechain: false,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: o.id,
          content:
            o.asBlocks === true ? [{ type: "text", text: o.text }] : o.text,
        },
      ],
    },
  };
}

function readUse(id: string, filePath: string, sidechain = false): Entry {
  return entry("tool_use", {
    id,
    name: "Read",
    input: { file_path: filePath },
    sidechain,
  });
}
function bashUse(id: string, command: string, sidechain = false): Entry {
  return entry("tool_use", { id, name: "Bash", input: { command }, sidechain });
}
function grepUse(id: string, mode: string, target: string): Entry {
  return entry("tool_use", {
    id,
    name: "Grep",
    input: { pattern: "foo", output_mode: mode, path: target },
  });
}
function agentUse(
  id: string,
  name: "Agent" | "Task",
  sidechain = false,
): Entry {
  return entry("tool_use", {
    id,
    name,
    input: { prompt: "summarise" },
    sidechain,
  });
}
function prReadUse(id: string, method: string, sidechain = false): Entry {
  return entry("tool_use", {
    id,
    name: "mcp__github__pull_request_read",
    input: { method, owner: "o", repo: "r", pullNumber: PR_NUMBER },
    sidechain,
  });
}

let fixtureCounter = 0;
function writeTranscript(entries: Entry[]): string {
  return writeRaw(entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function writeRaw(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  fixtureCounter += 1;
  const file = path.join(dir, `session-${fixtureCounter}.jsonl`);
  writeFileSync(file, content);
  return file;
}

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  lines: string[];
};
function run(script: string, args: string[]): Run {
  const cmd = script.endsWith(".sh") ? "bash" : "node";
  const r = spawnSync(cmd, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lines: r.stdout.split("\n").filter((l) => l.length > 0),
  };
}
function line1(r: Run): { n: number; k: number; m: number; max: number } {
  const match = LINE1_RE.exec(r.lines[0] ?? "");
  expect(match, `line 1 was: ${r.lines[0] ?? "<none>"}`).not.toBeNull();
  const [, n, k, m, max] = match ?? [];
  return { n: Number(n), k: Number(k), m: Number(m), max: Number(max) };
}
function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

// ---- scenarios ---------------------------------------------------------------------------
it("a main-thread Read of docs/CHANGELOG.md is counted", () => {
  const file = writeTranscript([readUse("t1", CHANGELOG)]);
  const r = run(SCRIPT_MJS, [file]);
  expect(line1(r)).toMatchObject({ n: 1, k: 1 });
  expect(r.lines[1]).toMatch(
    new RegExp(`^\\d+ Read .*${CHANGELOG.replace(".", "\\.")}`),
  );
});

it("a sidechain Read of docs/CHANGELOG.md is not counted", () => {
  const file = writeTranscript([readUse("t1", CHANGELOG, true)]);
  const r = run(SCRIPT_MJS, [file]);
  expect(line1(r)).toMatchObject({ n: 0, k: 0 });
});

it("an absolute-path Read of /home/user/pg-eos/docs/CHANGELOG.md is counted", () => {
  const file = writeTranscript([readUse("t1", `${ABS_PREFIX}${CHANGELOG}`)]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 1 });
});

it("Bash cat of tasks/MASTER_BACKLOG.md is counted and Bash pnpm test is not", () => {
  const file = writeTranscript([
    bashUse("t1", `cat ${BACKLOG}`),
    bashUse("t2", "pnpm test"),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 2 });
});

it("Bash cat of an absolute /home/user/pg-eos/tasks/MASTER_BACKLOG.md is counted", () => {
  const file = writeTranscript([bashUse("t1", `cat ${ABS_PREFIX}${BACKLOG}`)]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 1 });
});

it("a Read of docs/notes/handover-core.md is counted", () => {
  const file = writeTranscript([readUse("t1", HANDOVER_CORE)]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 1 });
});

it("Grep with output_mode content on a governed file is counted and files_with_matches is not", () => {
  const file = writeTranscript([
    grepUse("t1", "content", CHANGELOG),
    grepUse("t2", "files_with_matches", CHANGELOG),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 2 });
});

it("Bash grep, git show, git diff, sed, head, tail and less on governed paths are counted", () => {
  const file = writeTranscript([
    bashUse("t1", `grep -n foo ${CHANGELOG}`),
    bashUse("t2", `git show origin/main:${CHANGELOG}`),
    bashUse("t3", `git diff -- ${BACKLOG}`),
    bashUse("t4", `sed -n 1,40p ${HANDOVER}`),
    bashUse("t5", `head -n 5 ${CHANGELOG}`),
    bashUse("t6", `tail -n 5 ${BACKLOG}`),
    bashUse("t7", `less ${HANDOVER_CORE}`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 7, k: 7 });
});

it("Bash gh pr view 228 --json body is counted", () => {
  const file = writeTranscript([
    bashUse("t1", `gh pr view ${PR_NUMBER} --json body`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 1 });
});

it("gh pr view 228 is counted, with --json body,title is counted, with --json state,mergeable,statusCheckRollup is not", () => {
  const file = writeTranscript([
    bashUse("t1", `gh pr view ${PR_NUMBER}`),
    bashUse("t2", `gh pr view ${PR_NUMBER} --json body,title`),
    bashUse(
      "t3",
      `gh pr view ${PR_NUMBER} --json state,mergeable,statusCheckRollup`,
    ),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 2, k: 3 });
});

it("mcp__github__pull_request_read with method get is counted and get_files is not", () => {
  const file = writeTranscript([
    prReadUse("t1", "get"),
    prReadUse("t2", "get_files"),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 2 });
});

it("a Read of modules/wms/domain/x.ts is not counted", () => {
  const file = writeTranscript([readUse("t1", DOMAIN_FILE)]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 0, k: 1 });
});

it("a tool_result over the line limit is paired to its counted read by tool_use_id", () => {
  const file = writeTranscript([
    readUse("big", CHANGELOG),
    readUse("small", BACKLOG),
    // results arrive out of order and in both content shapes
    entry("tool_result", { id: "small", text: numberedLines(AT_LIMIT_LINES) }),
    entry("tool_result", {
      id: "big",
      text: numberedLines(OVER_LINES),
      asBlocks: true,
    }),
  ]);
  const r = run(SCRIPT_MJS, [file, "--max-lines", String(DEFAULT_MAX_LINES)]);
  expect(line1(r)).toMatchObject({ n: 2, k: 2, m: 1, max: DEFAULT_MAX_LINES });
});

it("an Agent or Task tool_result over the line limit is counted in m and one at the limit is not", () => {
  const file = writeTranscript([
    agentUse("a-big", "Agent"),
    agentUse("a-small", "Agent"),
    agentUse("t-big", "Task"),
    entry("tool_result", { id: "a-big", text: numberedLines(OVER_LINES) }),
    entry("tool_result", {
      id: "a-small",
      text: numberedLines(AT_LIMIT_LINES),
    }),
    entry("tool_result", {
      id: "t-big",
      text: numberedLines(OVER_LINES),
      asBlocks: true,
    }),
  ]);
  const r = run(SCRIPT_MJS, [file, "--max-lines", String(DEFAULT_MAX_LINES)]);
  expect(line1(r)).toMatchObject({ n: 0, k: 3, m: 2, max: DEFAULT_MAX_LINES });
});

it("the report exits 0 and line 1 has the fixed format", () => {
  const file = writeTranscript([readUse("t1", CHANGELOG)]);
  const r = run(SCRIPT_MJS, [file]);
  expect(r.status).toBe(EXIT_OK);
  expect(line1(r).max).toBe(DEFAULT_MAX_LINES);
});

it("--strict exits 1 when there is a finding and 0 when there is none", () => {
  const bad = writeTranscript([readUse("t1", CHANGELOG)]);
  const good = writeTranscript([readUse("t1", DOMAIN_FILE)]);
  expect(run(SCRIPT_MJS, [bad, "--strict"]).status).toBe(EXIT_STRICT_FINDING);
  expect(run(SCRIPT_MJS, [good, "--strict"]).status).toBe(EXIT_OK);
});

it("a file that is not JSONL exits 2 with a usage line", () => {
  const file = writeRaw("this is not json\n{broken\n");
  const r = run(SCRIPT_MJS, [file]);
  expect(r.status).toBe(EXIT_USAGE);
  expect(`${r.stdout}\n${r.stderr}`).toMatch(/^usage:/m);
});

it("no argument at all exits 2 with a usage line", () => {
  const r = run(SCRIPT_MJS, []);
  expect(r.status).toBe(EXIT_USAGE);
  expect(`${r.stdout}\n${r.stderr}`).toMatch(/^usage:/m);
});

it("an unreadable or missing path exits 2 with a usage line", () => {
  const r = run(SCRIPT_MJS, [MISSING_PATH]);
  expect(r.status).toBe(EXIT_USAGE);
  expect(`${r.stdout}\n${r.stderr}`).toMatch(/^usage:/m);
});

it("the .sh wrapper forwards its arguments and the exit code", () => {
  const file = writeTranscript([readUse("t1", CHANGELOG)]);
  const viaSh = run(SCRIPT_SH, [file, "--strict"]);
  const viaNode = run(SCRIPT_MJS, [file, "--strict"]);
  expect(viaSh.status).toBe(EXIT_STRICT_FINDING);
  expect(viaSh.lines[0]).toBe(viaNode.lines[0]);
});

// ---- generated table ---------------------------------------------------------------------
type Counted = { line: number; tool: string; target: string };
type CountResult = { reads: Counted[]; mainCalls: number; overLimit: number };
type CountFn = (entries: Entry[], opts: { maxLines: number }) => CountResult;

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
}

type Kind =
  | "read"
  | "cat"
  | "grepContent"
  | "grepFiles"
  | "pnpm"
  | "ghplain"
  | "ghBody"
  | "ghState"
  | "prget"
  | "prfiles"
  | "agent"
  | "task";
const KINDS: Kind[] = [
  "read",
  "cat",
  "grepContent",
  "grepFiles",
  "pnpm",
  "ghplain",
  "ghBody",
  "ghState",
  "prget",
  "prfiles",
  "agent",
  "task",
];

// Independent oracle: decides from the generator's own parameters, never from the entry shape.
function oracleCounted(kind: Kind, governed: boolean): boolean {
  if (kind === "read" || kind === "cat" || kind === "grepContent")
    return governed;
  return kind === "ghplain" || kind === "ghBody" || kind === "prget";
}
function oracleResultEligible(kind: Kind, governed: boolean): boolean {
  return oracleCounted(kind, governed) || kind === "agent" || kind === "task";
}

it("300 seeded generated cases agree with an independent oracle", async () => {
  const mod = (await import(SCRIPT_MJS)) as { countMasterReads: CountFn };
  const next = lcg(LCG_SEED);
  const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] as T;
  for (let c = 0; c < CASE_COUNT; c += 1) {
    const entries: Entry[] = [];
    let expectedN = 0;
    let expectedK = 0;
    let expectedM = 0;
    const size = 1 + Math.floor(next() * MAX_ENTRIES_PER_CASE);
    for (let i = 0; i < size; i += 1) {
      const kind = pick(KINDS);
      const sidechain = next() < SIDECHAIN_PROBABILITY;
      const governed = next() < GOVERNED_PROBABILITY;
      const prefix = next() < ABSOLUTE_PROBABILITY ? ABS_PREFIX : "";
      const target = `${prefix}${pick(governed ? GOVERNED_PATHS : OTHER_PATHS)}`;
      const id = `c${c}-${i}`;
      if (kind === "read") entries.push(readUse(id, target, sidechain));
      else if (kind === "cat")
        entries.push(bashUse(id, `cat ${target}`, sidechain));
      else if (kind === "grepContent") {
        entries.push(
          entry("tool_use", {
            id,
            name: "Grep",
            input: { pattern: "foo", output_mode: "content", path: target },
            sidechain,
          }),
        );
      } else if (kind === "grepFiles") {
        entries.push(
          entry("tool_use", {
            id,
            name: "Grep",
            input: {
              pattern: "foo",
              output_mode: "files_with_matches",
              path: target,
            },
            sidechain,
          }),
        );
      } else if (kind === "pnpm")
        entries.push(bashUse(id, "pnpm test", sidechain));
      else if (kind === "ghplain")
        entries.push(bashUse(id, `gh pr view ${PR_NUMBER}`, sidechain));
      else if (kind === "ghBody") {
        entries.push(
          bashUse(id, `gh pr view ${PR_NUMBER} --json body,title`, sidechain),
        );
      } else if (kind === "ghState") {
        entries.push(
          bashUse(
            id,
            `gh pr view ${PR_NUMBER} --json state,mergeable`,
            sidechain,
          ),
        );
      } else if (kind === "agent")
        entries.push(agentUse(id, "Agent", sidechain));
      else if (kind === "task") entries.push(agentUse(id, "Task", sidechain));
      else
        entries.push(
          prReadUse(id, kind === "prget" ? "get" : "get_files", sidechain),
        );
      if (!sidechain) {
        expectedK += 1;
        if (oracleCounted(kind, governed)) expectedN += 1;
      }
      if (next() < RESULT_PROBABILITY) {
        const lineCount = Math.floor(next() * (MAX_RESULT_LINES + 1));
        entries.push(
          entry("tool_result", { id, text: numberedLines(lineCount) }),
        );
        if (
          !sidechain &&
          oracleResultEligible(kind, governed) &&
          lineCount > DEFAULT_MAX_LINES
        ) {
          expectedM += 1;
        }
      }
    }
    const got = mod.countMasterReads(entries, { maxLines: DEFAULT_MAX_LINES });
    expect(got.reads.length, `case ${c} n`).toBe(expectedN);
    expect(got.mainCalls, `case ${c} k`).toBe(expectedK);
    expect(got.overLimit, `case ${c} m`).toBe(expectedM);
  }
});

// ---- round-2 findings (part 3) -------------------------------------------------------------
// The generated table above emits only `cat <path>`, `gh pr view N`, `--json body,title` and
// `--json state,mergeable` with a path at end of command; none of the forms below, so its oracle
// is unchanged.
const TRAILING_LINE_LIMIT = 20;
const OVER_BY_ONE_LINES = 21;
const SIX_DELIMITED_READS = 6;
const THREE_CALLS = 3;
const TWO_CALLS = 2;
const NO_ID_LINES = 30;
const ABS_REPO_DIR = "/home/user/pg-eos";
const HEREDOC_COMMIT = `git add ${CHANGELOG} && git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`;

it("a governed path followed by ; | ) < > or & is still counted", () => {
  const file = writeTranscript([
    bashUse("d1", `head -40 ${CHANGELOG}; git status`),
    bashUse("d2", `cat ${BACKLOG}|head`),
    bashUse("d3", `x=$(cat ${CHANGELOG})`),
    bashUse("d4", `head <${CHANGELOG}`),
    bashUse("d5", `cat ${CHANGELOG}>out`),
    bashUse("d6", `cat ${CHANGELOG}&`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({
    n: SIX_DELIMITED_READS,
    k: SIX_DELIMITED_READS,
  });
});

it("a read counts only when a read verb takes the governed path as its argument", () => {
  const file = writeTranscript([
    bashUse("v1", HEREDOC_COMMIT),
    bashUse("v2", `sed -i 's/a/b/' ${CHANGELOG}`),
    bashUse("v3", `sed -n 1,40p ${CHANGELOG}`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: THREE_CALLS });
});

it("a governed read after a newline or inside backticks is counted", () => {
  const file = writeTranscript([
    bashUse("s1", `git status\ncat ${CHANGELOG}`),
    bashUse("s2", `x=\`cat ${CHANGELOG}\``),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({
    n: TWO_CALLS,
    k: TWO_CALLS,
  });
});

it("sed counts unless -i or --in-place is an option, not text inside the script", () => {
  const file = writeTranscript([
    bashUse("e1", `sed -n '/x-id/p' ${CHANGELOG}`),
    bashUse("e2", `sed --in-place 's/a/b/' ${CHANGELOG}`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: TWO_CALLS });
});

it("a read verb must be a whole word and may follow an env assignment", () => {
  const file = writeTranscript([
    bashUse("w1", `category ${CHANGELOG}`),
    bashUse("w2", `unless ${CHANGELOG}`),
    bashUse("w3", `LC_ALL=C grep -n x ${CHANGELOG}`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: THREE_CALLS });
});

it("a trailing newline does not count as a line of a result", () => {
  const file = writeTranscript([
    readUse("nl20", CHANGELOG),
    readUse("nl21", BACKLOG),
    entry("tool_result", {
      id: "nl20",
      text: `${numberedLines(TRAILING_LINE_LIMIT)}\n`,
    }),
    entry("tool_result", { id: "nl21", text: numberedLines(OVER_BY_ONE_LINES) }),
  ]);
  const r = run(SCRIPT_MJS, [file, "--max-lines", String(TRAILING_LINE_LIMIT)]);
  expect(line1(r)).toMatchObject({ n: TWO_CALLS, k: TWO_CALLS, m: 1 });
});

it("--json is parsed per gh pr view command", () => {
  const file = writeTranscript([
    bashUse("j1", "gh pr view 1 --json state && gh pr view 2"),
    bashUse("j2", "gh pr view 3 --json 'state, body'"),
    bashUse("j3", "gh pr view 4 --json state,title"),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({
    n: TWO_CALLS,
    k: THREE_CALLS,
  });
});

it("git -C <dir> show and git --no-pager diff on governed paths are counted", () => {
  const file = writeTranscript([
    bashUse("g1", `git -C ${ABS_REPO_DIR} show origin/main:${CHANGELOG}`),
    bashUse("g2", `git --no-pager diff -- ${BACKLOG}`),
  ]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({
    n: TWO_CALLS,
    k: TWO_CALLS,
  });
});

it("an empty --max-lines value exits 2 with a usage line", () => {
  const file = writeTranscript([readUse("e1", CHANGELOG)]);
  const r = run(SCRIPT_MJS, [file, "--max-lines", ""]);
  expect(r.status).toBe(EXIT_USAGE);
  expect(`${r.stdout}\n${r.stderr}`).toMatch(/^usage:/m);
});

it("a JSONL line that is valid JSON but not an object exits 2 with a usage line", () => {
  const file = writeRaw("[1]\n");
  const r = run(SCRIPT_MJS, [file]);
  expect(r.status).toBe(EXIT_USAGE);
  expect(`${r.stdout}\n${r.stderr}`).toMatch(/^usage:/m);
});

it("a tool_use without id never pairs with a result without tool_use_id", () => {
  const noIdUse: Entry = {
    type: "assistant",
    isSidechain: false,
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: CHANGELOG } },
      ],
    },
  };
  const noIdResult: Entry = {
    type: "user",
    isSidechain: false,
    message: {
      content: [
        { type: "tool_result", content: numberedLines(NO_ID_LINES) },
      ],
    },
  };
  const file = writeTranscript([noIdUse, noIdResult]);
  expect(line1(run(SCRIPT_MJS, [file]))).toMatchObject({ n: 1, k: 1, m: 0 });
});

// ---- close-review pins (part 3 nits) -----------------------------------------------------
const PIN_REDIRECT_APPEND = `cat >> ${CHANGELOG} <<'EOF'\nline\nEOF`;
const PIN_REDIRECT_TARGET = `grep x a.ts > ${BACKLOG}`;
const PIN_REDIRECT_GLUED = `cat ${CHANGELOG}>out`;
const PIN_SED_E_THEN_I = `sed -e 's/a/b/' -i ${CHANGELOG}`;
const PIN_SED_PRINT = `sed -n '/x-id/p' ${CHANGELOG}`;
const PIN_HEREDOC_MESSAGE = `git commit -m "$(cat <<'EOF'\ncat ${CHANGELOG} was read\ngh pr view ${PR_NUMBER}\nEOF\n)"`;
const PIN_PR_VIEW = `gh pr view ${PR_NUMBER}`;
const PIN_THREE_CALLS = 3;
const PIN_TWO_CALLS = 2;
const PIN_ONE_CALL = 1;

it("a redirect target is never a read", () => {
  const notCounted = writeTranscript([
    bashUse("r1", PIN_REDIRECT_APPEND),
    bashUse("r2", PIN_REDIRECT_TARGET),
  ]);
  expect(line1(run(SCRIPT_MJS, [notCounted]))).toMatchObject({
    n: 0,
    k: PIN_TWO_CALLS,
  });
  const counted = writeTranscript([bashUse("r3", PIN_REDIRECT_GLUED)]);
  expect(line1(run(SCRIPT_MJS, [counted]))).toMatchObject({
    n: 1,
    k: PIN_ONE_CALL,
  });
  expect(PIN_THREE_CALLS).toBe(PIN_TWO_CALLS + PIN_ONE_CALL);
});

it("sed in-place is detected on every option token", () => {
  const notCounted = writeTranscript([bashUse("s1", PIN_SED_E_THEN_I)]);
  expect(line1(run(SCRIPT_MJS, [notCounted]))).toMatchObject({
    n: 0,
    k: PIN_ONE_CALL,
  });
  const counted = writeTranscript([bashUse("s2", PIN_SED_PRINT)]);
  expect(line1(run(SCRIPT_MJS, [counted]))).toMatchObject({
    n: 1,
    k: PIN_ONE_CALL,
  });
});

it("text inside heredocs and quoted messages is not a command", () => {
  const notCounted = writeTranscript([bashUse("h1", PIN_HEREDOC_MESSAGE)]);
  expect(line1(run(SCRIPT_MJS, [notCounted]))).toMatchObject({
    n: 0,
    k: PIN_ONE_CALL,
  });
  const counted = writeTranscript([bashUse("h2", PIN_PR_VIEW)]);
  expect(line1(run(SCRIPT_MJS, [counted]))).toMatchObject({
    n: 1,
    k: PIN_ONE_CALL,
  });
});
