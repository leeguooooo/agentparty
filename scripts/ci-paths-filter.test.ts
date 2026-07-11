// #247 phase 2 + 并行门禁：release.yml 把 full check 拆成并行 per-workspace job，
// 并保留 paths-filter 让纯 CLI 的 PR 只跑 check:cli（秒级）。
//
// workflow 是最容易配错、且配错会「漏测但显示绿」的地方。这里守几个不变量：
//   1. required 门禁 job 名字仍是 "full check"（分支保护映射的就是它，改名=required check 消失=误合）
//   2. 快路径只由 changes.cli_only 决定，且 cli_only 是 fail-safe 的（要求 non_cli == false）
//   3. 非 PR（tag/main push）永不走快路径
//   4. 5 个 workspace（cli/worker/web/shared/scripts）都有人跑，且非 cli 的靠 cli_only 跳过
//   5. 聚合门禁把 workspace job 的 failure 变成自己失败，skipped 才算通过（漏配不漏测）
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const yml = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");

describe("release.yml 并行门禁 + CI 拆分不变量 (#247 phase 2)", () => {
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

  test("5 个 workspace 各自 check:* 都在 workflow 里（漏配某个 = 漏测该 workspace）", () => {
    expect(yml).toContain("bun run check:cli");
    // worker/web/shared/scripts 走 matrix：bun run check:${{ matrix.ws }}
    expect(yml).toContain("bun run check:${{ matrix.ws }}");
    for (const ws of ["worker", "web", "shared", "scripts"]) {
      expect(yml).toContain(ws);
    }
  });

  test("非 cli 的 workspace 靠 cli_only 跳过（快路径下只有 check-cli 真跑）", () => {
    expect(yml).toContain("if: needs.changes.outputs.cli_only != 'true'");
  });

  test("check-cli 无条件跑（cli 在快路径与全量下都要测）", () => {
    expect(yml).toMatch(/check-cli:\s*\n\s*needs: changes\s*\n\s*runs-on:/);
  });

  test('聚合 "full check" needs 全部 workspace job，且 if: always()（上游跳过/失败都要能裁决）', () => {
    expect(yml).toMatch(/check:\s*\n\s*name: full check/);
    for (const dep of ["check-cli", "check-rest", "version-contract"]) {
      expect(yml).toContain(`- ${dep}`);
    }
    expect(yml).toContain("if: always()");
  });

  test("聚合门禁把 failure/cancelled 变成自己失败，只有 success|skipped 通过（漏配不漏测）", () => {
    expect(yml).toContain("success|skipped");
    expect(yml).toContain("required check job did not pass");
  });

  test("build/desktop 仍 needs: check（聚合门禁是发布前置）", () => {
    expect(yml).toMatch(/needs: check\b/);
  });
});
