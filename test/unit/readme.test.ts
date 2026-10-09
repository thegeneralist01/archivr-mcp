import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLSETS } from "../../src/config";
import { toolModules } from "../../src/tools";
import type { ToolDef } from "../../src/tools/registry";

/**
 * The README's tool catalogue is maintained by hand. This test keeps it honest: every
 * registered tool must have exactly one row, in the table of its toolset, with the role and
 * class the code declares. Failure messages say which README line to change.
 */

const README = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");

interface Row {
  name: string;
  role: string;
  classes: string[];
  /** The toolset whose `### Heading` table the row sits in. */
  toolset: string;
  line: number;
}

interface Section {
  toolset: string;
  declaredCount: number;
  rows: Row[];
  line: number;
}

const HEADING = /^### (\w+) \((\d+) tools?\b/;

function parseCatalogue(markdown: string): { sections: Section[]; problems: string[] } {
  const sections: Section[] = [];
  const problems: string[] = [];
  const lines = markdown.split("\n");
  let current: Section | undefined;
  lines.forEach((text, index) => {
    const line = index + 1;
    const heading = HEADING.exec(text);
    if (heading !== null) {
      current = { toolset: (heading[1] ?? "").toLowerCase(), declaredCount: Number(heading[2]), rows: [], line };
      sections.push(current);
      return;
    }
    if (text.startsWith("#")) {
      current = undefined; // any other heading ends the catalogue section
      return;
    }
    if (current === undefined || !text.startsWith("|")) return;
    const cells = text.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "Tool" || cells.every((c) => /^-+$/.test(c))) return; // header and separator rows
    const name = /^`([a-z0-9_]+)`$/.exec(cells[0] ?? "")?.[1];
    if (name === undefined || cells.length !== 4) {
      problems.push(`README.md:${line}: cannot parse this tool-table row (expected | \`tool_name\` | Role | Class | Description |)`);
      return;
    }
    current.rows.push({
      name,
      role: cells[1] ?? "",
      classes: (cells[2] ?? "").split(",").map((c) => c.trim()).filter((c) => c !== ""),
      toolset: current.toolset,
      line,
    });
  });
  return { sections, problems };
}

/** The Class column value implied by a tool's annotations. */
function expectedClasses(tool: ToolDef): string[] {
  const a = tool.annotations;
  const base = a.readOnlyHint ? "read" : a.destructiveHint ? "destructive" : "write";
  return a.openWorldHint ? [base, "open-world"] : [base];
}

/** `module` file each tool comes from, for pointing at the code in messages. */
function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [module, make] of Object.entries(toolModules)) {
    for (const tool of make()) files.set(tool.name, `src/tools/${module}.ts`);
  }
  return files;
}

/** Every tool of every toolset and role: no filtering at all. */
function everyTool(): ToolDef[] {
  return Object.values(toolModules).flatMap((make) => make());
}

describe("README tool catalogue matches the registered tools", () => {
  const tools = everyTool();
  const files = sourceFiles();
  const { sections, problems: parseProblems } = parseCatalogue(README);
  const rows = sections.flatMap((s) => s.rows);

  test("has one table per toolset and every row parses", () => {
    expect(parseProblems).toEqual([]);
    const found = sections.map((s) => s.toolset).sort();
    expect(found, "README.md needs exactly one `### <Toolset> (N tools, ...)` section per toolset").toEqual([...TOOLSETS].sort());
  });

  test("every registered tool has exactly one row, and every row is a registered tool", () => {
    const problems: string[] = [];
    const byName = new Map<string, Row[]>();
    for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);

    for (const tool of tools) {
      const found = byName.get(tool.name) ?? [];
      if (found.length === 0) {
        problems.push(`README.md: add a row for \`${tool.name}\` to the "${tool.toolset}" table (it is registered in ${files.get(tool.name)})`);
      } else if (found.length > 1) {
        problems.push(`README.md: \`${tool.name}\` has ${found.length} rows (lines ${found.map((r) => r.line).join(", ")}); keep one`);
      }
    }
    const registered = new Set(tools.map((t) => t.name));
    for (const row of rows) {
      if (!registered.has(row.name)) {
        problems.push(`README.md:${row.line}: row for \`${row.name}\` has no matching tool in src/tools; remove or rename the row`);
      }
    }
    expect(problems.join("\n")).toBe("");
  });

  test("toolset, role and class columns match the code", () => {
    const problems: string[] = [];
    for (const tool of tools) {
      const row = rows.find((r) => r.name === tool.name);
      if (row === undefined) continue; // reported by the previous test
      const where = `README.md:${row.line}: \`${tool.name}\``;
      if (row.toolset !== tool.toolset) {
        problems.push(`${where} is listed under "${row.toolset}" but toolset is "${tool.toolset}" in ${files.get(tool.name)}; move the row to the "${tool.toolset}" table`);
      }
      if (row.role !== tool.minRole) {
        problems.push(`${where} Role column says "${row.role}" but minRole is "${tool.minRole}" in ${files.get(tool.name)}; change the Role cell to "${tool.minRole}"`);
      }
      const want = expectedClasses(tool);
      if (row.classes.join(", ") !== want.join(", ")) {
        problems.push(`${where} Class column says "${row.classes.join(", ")}" but annotations imply "${want.join(", ")}" in ${files.get(tool.name)}; change the Class cell`);
      }
    }
    expect(problems.join("\n")).toBe("");
  });

  test("section headings state the right tool counts", () => {
    const problems: string[] = [];
    for (const section of sections) {
      const actual = tools.filter((t) => t.toolset === section.toolset).length;
      if (section.declaredCount !== actual) {
        problems.push(`README.md:${section.line}: the "${section.toolset}" heading says ${section.declaredCount} tools but ${actual} are registered; change the heading to "(${actual} tools, ...)"`);
      }
    }
    expect(problems.join("\n")).toBe("");
  });

  test("the prose totals (all, default, credentials, destructive) are current", () => {
    const total = tools.length;
    const credentials = tools.filter((t) => t.toolset === "credentials").length;
    const destructive = tools.filter((t) => t.annotations.destructiveHint).length;
    const problems: string[] = [];

    const totals = /There are (\d+) tools in total\. (\d+) are registered by default and the (\d+) `credentials` tools are opt-in\./.exec(README);
    if (totals === null) {
      problems.push('README.md: the sentence "There are N tools in total. N are registered by default and the N `credentials` tools are opt-in." is missing or reworded; restore it (this test reads it)');
    } else {
      const [, t, d, c] = totals.map(Number);
      if (t !== total) problems.push(`README.md: "There are ${t} tools in total" should say ${total}`);
      if (d !== total - credentials) problems.push(`README.md: "${d} are registered by default" should say ${total - credentials}`);
      if (c !== credentials) problems.push(`README.md: "the ${c} \`credentials\` tools" should say ${credentials}`);
    }

    const destructiveCount = /The (\d+) destructive tools require `confirm: true`/.exec(README);
    if (destructiveCount === null) {
      problems.push('README.md: the sentence "The N destructive tools require `confirm: true`" is missing or reworded; restore it (this test reads it)');
    } else if (Number(destructiveCount[1]) !== destructive) {
      problems.push(`README.md: "The ${destructiveCount[1]} destructive tools" should say ${destructive}`);
    }
    expect(problems.join("\n")).toBe("");
  });
});
