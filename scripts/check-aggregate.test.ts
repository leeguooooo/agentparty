// #247：`check` 被拆成 check:scripts / :cli / :shared / :web / :worker，
// 好让 CI 按变更 area 只跑对应的一段（CLI 改动不再等全套 worker vitest）。
//
// 这里守一个不变量：聚合的 `check` 必须跑**每一个** check:* 子脚本。
// 最危险的失败模式是「加了 check:foo 却忘了接进 check」——CI 全套会漏掉那段，
// 显示绿、实际没测。这个守卫让那种漂移在 CI 里直接红。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("check 聚合完整性 (#247)", () => {
  const subChecks = Object.keys(pkg.scripts).filter((k) => k.startsWith("check:"));

  test("至少拆出了各 workspace 的 check（不是空拆）", () => {
    for (const area of ["check:scripts", "check:cli", "check:shared", "check:web", "check:worker"]) {
      expect(subChecks).toContain(area);
    }
  });

  test("聚合的 `check` 跑了每一个 check:*（没有孤儿子检查）", () => {
    const check = pkg.scripts.check ?? "";
    for (const sub of subChecks) {
      // `bun run check:cli` —— 聚合必须按名字引用每个子检查
      expect(check).toContain(`run ${sub}`);
    }
  });

  test("`check` 不引用任何不存在的 check:*（防止改名后留悬空引用）", () => {
    const check = pkg.scripts.check ?? "";
    const referenced = [...check.matchAll(/run (check:[a-z]+)/g)].map((m) => m[1]);
    for (const ref of referenced) {
      expect(subChecks).toContain(ref);
    }
  });

  test("`release:verify` / `release:deploy` 仍走全量 `check`（拆分不能弱化发布门禁）", () => {
    expect(pkg.scripts["release:verify"]).toContain("run check");
    expect(pkg.scripts["release:deploy"]).toContain("run check");
  });
});
