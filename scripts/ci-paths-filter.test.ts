// #247 phase 2：release.yml 用 paths-filter 让纯 CLI 的 PR 只跑 check:cli（秒级）。
//
// workflow 是最容易配错、且配错会「漏测但显示绿」的地方。这里守几个不变量：
//   1. required 门禁 job 名字仍是 "full check"（分支保护映射的就是它，改名=required check 消失=误合）
//   2. 快路径只由 changes.cli_only 决定，且 cli_only 是 fail-safe 的（要求 non_cli == false）
//   3. 非 PR（tag/main push）永不走快路径
//   4. 全量 check 的 fallback 还在（cli_only 为假时跑 `bun run check`）
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const yml = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");

describe("release.yml CI 拆分不变量 (#247 phase 2)", () => {
  test('required 门禁 job 名字仍是 "full check"（改名会让分支保护的 required check 消失）', () => {
    expect(yml).toContain("name: full check");
  });

  test("cli_only 是 fail-safe 的：要求 PR 事件 + cli 变更 + 没有任何非 cli 变更", () => {
    // 三个条件缺一不可，否则快路径可能在不该走时走
    expect(yml).toContain("github.event_name == 'pull_request'");
    expect(yml).toContain("steps.filter.outputs.cli == 'true'");
    expect(yml).toContain("steps.filter.outputs.non_cli == 'false'");
  });

  test("paths-filter 的 non_cli 匹配 cli/ 之外的一切（任何非 cli 文件都翻回全量）", () => {
    expect(yml).toContain("non_cli:");
    expect(yml).toContain("'!cli/**'");
  });

  test("快路径跑 check:cli，fallback 跑全量 check（漏配置也不漏测）", () => {
    expect(yml).toContain("bun run check:cli");
    expect(yml).toContain("bun run check\n"); // 全量 fallback 仍在
  });

  test("check job 依赖 changes job（否则拿不到 cli_only）", () => {
    expect(yml).toMatch(/check:\s*\n\s*name: full check\s*\n\s*needs: changes/);
  });
});
