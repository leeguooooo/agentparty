// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { ChannelStrings } from "./Channel";

// 任务面板整组文案接进字符串表（#149 / #132）。这里守 en/zh 双语齐备——
// 少任何一条翻译，这个测试就红，避免又出现「新文案从未进字符串表」。
const TASK_KEYS = [
  "Channel.tasks.title",
  "Channel.tasks.subtitle",
  "Channel.tasks.total",
  "Channel.tasks.filterAria",
  "Channel.tasks.filterAll",
  "Channel.tasks.filterUnassigned",
  "Channel.tasks.expand",
  "Channel.tasks.collapse",
  "Channel.tasks.expandAria",
  "Channel.tasks.detailAria",
  "Channel.tasks.detailOpenAria",
  "Channel.tasks.detailClose",
  "Channel.tasks.detailBack",
  "Channel.tasks.detailNoDesc",
  "Channel.tasks.solution",
  "Channel.tasks.detail.priority",
  "Channel.tasks.detail.assignee",
  "Channel.tasks.detail.createdBy",
  "Channel.tasks.detail.labels",
  "Channel.tasks.detail.parent",
  "Channel.tasks.detail.msgs",
  "Channel.tasks.detail.blockedReason",
  "Channel.tasks.detail.externalRef",
  "Channel.tasks.detail.created",
  "Channel.tasks.detail.updated",
  "Channel.tasks.detail.completed",
  "Channel.tasks.refresh",
  "Channel.tasks.refreshing",
  "Channel.tasks.panelAria",
  "Channel.tasks.boardAria",
  "Channel.tasks.columnAria",
  "Channel.tasks.columnEmpty",
  "Channel.tasks.empty",
  "Channel.tasks.new",
  "Channel.tasks.newTitlePlaceholder",
  "Channel.tasks.newDescPlaceholder",
  "Channel.tasks.newTitleAria",
  "Channel.tasks.newDescAria",
  "Channel.tasks.newSubmit",
  "Channel.tasks.newSubmitting",
  "Channel.tasks.newCancel",
  "Channel.tasks.action.claim",
  "Channel.tasks.action.block",
  "Channel.tasks.action.done",
  "Channel.tasks.action.approve",
  "Channel.tasks.action.reject",
  "Channel.tasks.action.assign",
  "Channel.tasks.assignPlaceholder",
  "Channel.tasks.assignAria",
  "Channel.tasks.kindAria",
  "Channel.tasks.kind.agent",
  "Channel.tasks.kind.human",
  "Channel.tasks.kind.squad",
  "Channel.tasks.meta.parent",
  "Channel.tasks.meta.msg",
  "Channel.tasks.summaryAria",
  "Channel.tasks.summary.open",
  "Channel.tasks.summary.review",
  "Channel.tasks.summary.blocked",
  "Channel.tasks.summary.mine",
  "Channel.tasks.state.triage",
  "Channel.tasks.state.backlog",
  "Channel.tasks.state.assigned",
  "Channel.tasks.state.in_progress",
  "Channel.tasks.state.needs_review",
  "Channel.tasks.state.done",
  "Channel.tasks.state.blocked",
  "Channel.tasks.error.notVisible",
  "Channel.tasks.error.loadFailed",
  "Channel.tasks.error.updateForbidden",
  "Channel.tasks.error.updateRejected",
  "Channel.tasks.error.updateFailed",
  "Channel.tasks.error.assigneeRequired",
  "Channel.tasks.error.noReviewable",
  "Channel.tasks.error.reviewForbidden",
  "Channel.tasks.error.reviewRejected",
  "Channel.tasks.error.reviewFailed",
  "Channel.tasks.error.createForbidden",
  "Channel.tasks.error.createRejected",
  "Channel.tasks.error.createFailed",
  "Channel.tasks.rejectPrompt",
  "Channel.reject.confirm",
  "Channel.reject.cancel",
] as const;

describe("Channel task-panel strings", () => {
  test("every task key exists in both en and zh", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const key of TASK_KEYS) {
        expect(ChannelStrings[locale][key], `${locale} missing ${key}`).toBeTruthy();
      }
    }
  });

  test("en and zh diverge for the human-facing state labels (not left as English)", () => {
    const stateKeys = TASK_KEYS.filter((k) => k.startsWith("Channel.tasks.state."));
    for (const key of stateKeys) {
      expect(ChannelStrings.zh[key]).not.toBe(ChannelStrings.en[key]);
    }
  });
});
