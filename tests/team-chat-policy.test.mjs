import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContactNumber, resolveChatUser, visibleChatTasks, planChatTaskUpdate } from "../lib/team-chat-policy.ts";

const member = { id: "test-member", name: "موظف تجريبي", role: "member", active: 1 };
const admin = { id: "basem", name: "مدير تجريبي", role: "admin", active: 1 };
const contacts = [{ userId: member.id, number: "+1 202 555 0101" }];
const own = { id: "test-task", title: "جرد تجريبي", status: "progress", owner: member.name, suggestedOwner: member.name, archivedAt: null, updatedAt: 1234 };
const other = { ...own, id: "other-task", owner: "موظف آخر", suggestedOwner: "موظف آخر" };
const intent = action => ({ action, taskId: own.id, question: null });

test("recognizes formatted trusted numbers, never digits inside arbitrary text", () => {
  assert.equal(normalizeContactNumber("001 (202) 555-0101"), "12025550101");
  assert.equal(normalizeContactNumber("انا باسم 12025550101"), null);
  assert.equal(normalizeContactNumber("123"), null);
  assert.equal(resolveChatUser({ senderNumber: "12025550101" }, contacts, [member])?.id, member.id);
});

test("unknown, inactive and duplicate contacts cannot act", () => {
  assert.equal(resolveChatUser({ senderNumber: "12025550102" }, contacts, [member]), null);
  assert.equal(resolveChatUser({ senderNumber: "12025550101" }, contacts, [{ ...member, active: 0 }]), null);
  assert.equal(resolveChatUser({ senderNumber: "12025550101" }, [...contacts, ...contacts], [member]), null);
});

test("group messages are denied by default and require exact group allow-list", () => {
  const origin = { senderNumber: "12025550101", groupId: "test-group" };
  assert.equal(resolveChatUser(origin, contacts, [member]), null);
  assert.equal(resolveChatUser(origin, contacts, [member], ["different-group"]), null);
  assert.equal(resolveChatUser(origin, contacts, [member], ["test-group"])?.id, member.id);
  assert.equal(resolveChatUser({ ...origin, groupId: "" }, contacts, [member]), null);
});

test("members cannot see other, conflicting-owner or archived tasks", () => {
  assert.deepEqual(visibleChatTasks(member, [own, other, { ...other, suggestedOwner: member.name }, { ...own, archivedAt: 3 }]), [own]);
  assert.equal(visibleChatTasks(admin, [own, other]).length, 2);
  assert.equal(visibleChatTasks({ ...member, active: 0 }, [own]).length, 0);
});

test("an admin role without Basim's identity does not gain all-task access", () => {
  assert.deepEqual(visibleChatTasks({ ...member, role: "admin" }, [own, other]), [own]);
});

test("completion proposes pending approval, never final completion", () => {
  const result = planChatTaskUpdate(member, intent("submit"), [own], "خلصت الجرد");
  assert.equal(result.kind, "mutation");
  assert.equal(result.nextStatus, "approval");
  assert.equal(result.expectedUpdatedAt, 1234);
  assert.equal(result.originalText, "خلصت الجرد");
  assert.equal(result.actorId, member.id);
});

test("a first update on an assigned open task includes a claim proposal", () => {
  const task = { ...own, status: "open", owner: null };
  const result = planChatTaskUpdate(member, intent("update"), [task], "بلشت الجرد ولسه ناقص قسم");
  assert.equal(result.kind, "mutation");
  assert.equal(result.claimFirst, true);
  assert.equal(result.nextStatus, "progress");
  assert.equal(task.status, "open", "planning must not mutate the input or any live data");
});

test("unknown task IDs, owner changes, and unsafe actions never produce writes", () => {
  for (const action of ["approve", "delete", "reassign", "set_role"]) {
    assert.equal(planChatTaskUpdate(member, intent(action), [own], "نفذ").kind, "clarify");
  }
  assert.equal(planChatTaskUpdate(member, { ...intent("submit"), taskId: other.id }, [own, other], "خلصت").kind, "clarify");
  assert.equal(planChatTaskUpdate(member, intent("submit"), [{ ...own, owner: other.owner }], "خلصت").kind, "clarify");
  assert.equal(planChatTaskUpdate(admin, intent("submit"), [own], "خلصت").kind, "clarify");
});

test("archived, approved, pending-approval and disabled-user states fail closed", () => {
  for (const task of [{ ...own, archivedAt: 1 }, { ...own, status: "completed" }, { ...own, status: "approval" }]) {
    assert.equal(planChatTaskUpdate(member, intent("update"), [task], "تحديث").kind, "clarify");
  }
  assert.equal(planChatTaskUpdate({ ...member, active: 0 }, intent("submit"), [own], "خلصت").kind, "clarify");
});

test("summary exposes only permitted task identifiers", () => {
  assert.deepEqual(planChatTaskUpdate(member, intent("summary"), [own, other], "شو علي"), { kind: "summary", taskIds: [own.id] });
});
