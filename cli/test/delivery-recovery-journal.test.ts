import { afterEach, describe, expect, test } from "bun:test";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryRecoveryJournal } from "../src/delivery-recovery-journal";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const now = Date.now();
  const delivery: DirectedDelivery = {
    id: "delivery-recovery-1",
    message_seq: 41,
    target_name: "front",
    cause: "mention",
    state: "claimed",
    attempt: 3,
    lease_epoch: 7,
    lease_token: "lease-token-old",
    lease_until: now + 90_000,
    work_id: "work-1",
    continuation_ref: "continuation-1",
    reply_seq: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  const message: MsgFrame = {
    type: "msg",
    seq: 41,
    sender: { name: "owner", kind: "human" },
    kind: "message",
    body: "@front continue",
    mentions: ["front"],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: now,
  };
  return { delivery, message };
}

describe("DeliveryRecoveryJournal", () => {
  test("persists claim and next token before recovery so ACK-loss restart is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "ap-delivery-journal-"));
    roots.push(root);
    const path = join(root, "journal.json");
    const { delivery, message } = fixture();
    const first = new DeliveryRecoveryJournal(path, "dev", "claude");
    first.recordClaim(delivery, message);
    const recover = first.prepareRecovery(delivery.id);

    const onDiskBeforeAck = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Array<{ nextLeaseToken: string }>;
    };
    expect(onDiskBeforeAck.entries[0]!.nextLeaseToken).toBe(recover.next_lease_token);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const restarted = new DeliveryRecoveryJournal(path, "dev", "claude");
    const retry = restarted.prepareRecovery(delivery.id);
    expect(retry.lease_token).toBe(recover.lease_token);
    expect(retry.next_lease_token).toBe(recover.next_lease_token);
    restarted.acceptRecovery({
      type: "delivery_recovery",
      delivery_id: delivery.id,
      request_id: retry.request_id,
      result: "recovered",
      state: "running",
      attempt: delivery.attempt,
      lease_epoch: delivery.lease_epoch!,
      lease_token: retry.next_lease_token,
      lease_until: Date.now() + 90_000,
    });

    const afterAckRestart = new DeliveryRecoveryJournal(path, "dev", "claude");
    expect(afterAckRestart.get(delivery.id)).toMatchObject({
      phase: "claimed",
      nextLeaseToken: null,
      delivery: {
        state: "running",
        lease_token: retry.next_lease_token,
      },
    });
  });

  test("records pre-injection and accepted phases across process restart", () => {
    const root = mkdtempSync(join(tmpdir(), "ap-delivery-journal-"));
    roots.push(root);
    const path = join(root, "journal.json");
    const { delivery, message } = fixture();
    const journal = new DeliveryRecoveryJournal(path, "dev", "codex");
    journal.recordClaim(delivery, message);
    journal.update(delivery.id, { phase: "running_authorized" });
    journal.update(delivery.id, { phase: "harness_issued", threadId: "thread-1" });

    const restarted = new DeliveryRecoveryJournal(path, "dev", "codex");
    expect(restarted.get(delivery.id)).toMatchObject({
      phase: "harness_issued",
      threadId: "thread-1",
    });
    restarted.update(delivery.id, {
      phase: "harness_accepted",
      turnId: "turn-1",
    });
    expect(new DeliveryRecoveryJournal(path, "dev", "codex").get(delivery.id)).toMatchObject({
      phase: "harness_accepted",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  test("a failed recovery-token flush rolls back memory and retry commits the same disk-visible token", () => {
    const root = mkdtempSync(join(tmpdir(), "ap-delivery-journal-"));
    roots.push(root);
    const path = join(root, "journal.json");
    const { delivery, message } = fixture();
    new DeliveryRecoveryJournal(path, "dev", "claude").recordClaim(delivery, message);

    let failNextCommit = true;
    const journal = new DeliveryRecoveryJournal(path, "dev", "claude", {
      persist(commit) {
        if (failNextCommit) {
          failNextCommit = false;
          throw Object.assign(new Error("simulated journal disk full"), { code: "ENOSPC" });
        }
        commit();
      },
    });
    expect(() => journal.prepareRecovery(delivery.id)).toThrow("simulated journal disk full");
    expect(journal.get(delivery.id)?.nextLeaseToken).toBeNull();
    expect(
      new DeliveryRecoveryJournal(path, "dev", "claude").get(delivery.id)?.nextLeaseToken,
    ).toBeNull();

    const retry = journal.prepareRecovery(delivery.id);
    expect(journal.get(delivery.id)?.nextLeaseToken).toBe(retry.next_lease_token);
    expect(
      new DeliveryRecoveryJournal(path, "dev", "claude").get(delivery.id)?.nextLeaseToken,
    ).toBe(retry.next_lease_token);
  });

  test("a stale pre-harness snapshot cannot publish replay_safe after the phase advances", () => {
    const root = mkdtempSync(join(tmpdir(), "ap-delivery-journal-"));
    roots.push(root);
    const path = join(root, "journal.json");
    const { delivery, message } = fixture();
    const journal = new DeliveryRecoveryJournal(path, "dev", "claude");
    const before = journal.recordClaim(delivery, message);
    journal.update(delivery.id, { phase: "harness_accepted" });

    expect(() => journal.prepareRecovery(delivery.id, {
      replaySafe: true,
      expected: {
        phase: before.phase,
        updatedAt: before.updatedAt,
        attempt: before.delivery.attempt,
        leaseEpoch: before.delivery.lease_epoch!,
        leaseToken: before.delivery.lease_token!,
      },
    })).toThrow("changed while recovery was being prepared");
    expect(journal.get(delivery.id)).toMatchObject({
      phase: "harness_accepted",
      nextLeaseToken: null,
    });
    expect(
      new DeliveryRecoveryJournal(path, "dev", "claude").get(delivery.id),
    ).toMatchObject({
      phase: "harness_accepted",
      nextLeaseToken: null,
    });
  });

  test("recordClaim rejects identity drift without mutating memory or disk", () => {
    const root = mkdtempSync(join(tmpdir(), "ap-delivery-journal-identity-"));
    roots.push(root);
    const path = join(root, "journal.json");
    const { delivery, message } = fixture();
    const journal = new DeliveryRecoveryJournal(path, "dev", "claude");
    const original = journal.recordClaim(delivery, message);
    const diskBefore = readFileSync(path, "utf8");
    const variants: Array<{
      name: string;
      delivery: DirectedDelivery;
      message: MsgFrame;
    }> = [
      {
        name: "message sequence",
        delivery: { ...delivery, message_seq: delivery.message_seq + 1 },
        message,
      },
      {
        name: "cause",
        delivery: { ...delivery, cause: "owner_answer" },
        message,
      },
      {
        name: "lease token",
        delivery: { ...delivery, lease_token: "different-token" },
        message,
      },
      {
        name: "message body",
        delivery,
        message: { ...message, body: "@front changed body" },
      },
      {
        name: "work id",
        delivery: { ...delivery, work_id: "different-work" },
        message,
      },
      {
        name: "continuation ref",
        delivery: { ...delivery, continuation_ref: "different-continuation" },
        message,
      },
    ];
    for (const variant of variants) {
      expect(
        () => journal.recordClaim(variant.delivery, variant.message),
        variant.name,
      ).toThrow();
      expect(journal.get(delivery.id), variant.name).toEqual(original);
      expect(readFileSync(path, "utf8"), variant.name).toBe(diskBefore);
    }
  });
});
