// #101: channel_roles 曾按裸 name 绑定角色。deploy-bot 的 token 被撤销后，任何账号重铸同名 token
// 就【继承】残留的 host 角色，从而拿到 canConfigureChannel（改 charter、配 guard）等配置权。
//
// 修复：角色锚定到账号（channel_roles.owner_account）。
//   - 撤销后【他人】重铸同名 → 不继承（account 不符）。
//   - 【同账号】重铸同名 → 保留（同一信任主体轮换自己的 token，不构成越权）。
//   - 预分配（先给尚不存在的 name 分角色）仍可用：该 name 首次铸 token 时把角色绑定到铸造账号。
//
// 用例统一让「host agent」与「频道 owner」不同账号，使 canConfigureChannel 只能靠 host 角色放行
// （isChannelModerator 走不通），从而精确验证 host 角色路径本身。
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, api, createChannel, seedToken, uniq } from "./helpers";

// 经真实铸造端点铸 token（走 persistToken，触发预分配绑定逻辑）。返回可用作 Bearer 的 token。
async function mintToken(name: string, owner: string, role = "agent"): Promise<string> {
  const res = await api("/api/tokens", "unused", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ name, role, owner }),
  });
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function revokeToken(name: string): Promise<void> {
  const res = await api(`/api/tokens/${name}`, "unused", { method: "DELETE", headers: ADMIN_HEADERS });
  if (res.status !== 200) throw new Error(`revoke failed: ${res.status}`);
}

async function assignHost(slug: string, moderatorToken: string, name: string): Promise<void> {
  const res = await api(`/api/channels/${slug}/roles/${name}`, moderatorToken, {
    method: "PUT",
    body: JSON.stringify({ role: "host" }),
  });
  if (res.status !== 200) throw new Error(`assign host failed: ${res.status} ${await res.text()}`);
}

// host 加强 loop guard（enabled:true, limit:5，纯加强动作，任何 configurer 都能做）。
// 用它作为「能否行使 canConfigureChannel 配置权」的可观察探针：200 = 有配置权，403 = 无。
function tightenGuard(slug: string, token: string): Promise<Response> {
  return api(`/api/channels/${slug}/loop-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, limit: 5 }),
  });
}

describe("channel role account binding (#101)", () => {
  it("a legitimate host (different account than owner) can configure the channel", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const deployAcct = `${uniq("deploy")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAcct });
    const slug = await createChannel(human.token);

    const botName = uniq("deploy-bot");
    const botToken = await mintToken(botName, deployAcct);
    // 未分配角色 → 陌生账号无配置权
    expect((await tightenGuard(slug, botToken)).status).toBe(403);

    await assignHost(slug, human.token, botName);
    // 分配 host 后 → 配置权放行（走 canConfigureChannel 的 host 路径）
    expect((await tightenGuard(slug, botToken)).status).toBe(200);
  });

  it("after revoke, a DIFFERENT account re-minting the same name does NOT inherit the host role", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const deployAcct = `${uniq("deploy")}@example.com`;
    const attackerAcct = `${uniq("attacker")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAcct });
    const slug = await createChannel(human.token);

    const botName = uniq("deploy-bot");
    const legit = await mintToken(botName, deployAcct);
    await assignHost(slug, human.token, botName);
    expect((await tightenGuard(slug, legit)).status).toBe(200); // legit host works

    // token 轮换/撤销 → 攻击者账号重铸同名 agent
    await revokeToken(botName);
    const attacker = await mintToken(botName, attackerAcct);

    // 残留 host 角色不被继承：攻击者拿不到配置权
    const res = await tightenGuard(slug, attacker);
    expect(res.status).toBe(403);
  });

  it("the SAME account re-minting the same name KEEPS the host role", async () => {
    // 语义决定：角色锚定的是【账号】而非某一次铸造。同账号轮换自己的 token 是同一信任主体，
    // 不是越权，故保留角色，避免每次轮换都要重分配的运维摩擦。
    const ownerAcct = `${uniq("owner")}@example.com`;
    const deployAcct = `${uniq("deploy")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAcct });
    const slug = await createChannel(human.token);

    const botName = uniq("deploy-bot");
    await mintToken(botName, deployAcct);
    await assignHost(slug, human.token, botName);

    await revokeToken(botName);
    const rotated = await mintToken(botName, deployAcct); // 同账号重铸

    expect((await tightenGuard(slug, rotated)).status).toBe(200);
  });

  it("pre-allocation still works: assign a role before the token exists, first mint claims it", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const futureAcct = `${uniq("future")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAcct });
    const slug = await createChannel(human.token);

    const botName = uniq("future-bot");
    // 先分工：给尚不存在的 name 分 host（owner_account 记为 null，待认领）
    await assignHost(slug, human.token, botName);
    // 再铸 token：首次铸造把预分配角色绑定到铸造账号
    const botToken = await mintToken(botName, futureAcct);

    expect((await tightenGuard(slug, botToken)).status).toBe(200);
  });

  it("a pre-allocated role, once claimed, is NOT inherited by another account after revoke", async () => {
    // 预分配 → 首次铸造绑定 → 撤销 → 他人重铸同名：仍然不继承（绑定已落到首铸账号）。
    const ownerAcct = `${uniq("owner")}@example.com`;
    const firstAcct = `${uniq("first")}@example.com`;
    const attackerAcct = `${uniq("attacker")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerAcct });
    const slug = await createChannel(human.token);

    const botName = uniq("future-bot");
    await assignHost(slug, human.token, botName);
    const first = await mintToken(botName, firstAcct);
    expect((await tightenGuard(slug, first)).status).toBe(200); // claimed by firstAcct

    await revokeToken(botName);
    const attacker = await mintToken(botName, attackerAcct);
    expect((await tightenGuard(slug, attacker)).status).toBe(403); // not inherited
  });
});
