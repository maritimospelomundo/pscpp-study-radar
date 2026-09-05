import test from "node:test";
import assert from "node:assert/strict";
import { aggregateAttempts, createSessionToken, sanitizeLatestReport, validateSyncPayload, verifySessionToken } from "../src/index.js";

test("token de sessão é válido e rejeita adulteração ou expiração", async () => {
  const now = Date.UTC(2026, 8, 5);
  const token = await createSessionToken("gustavo", "segredo-de-teste", now);
  assert.equal((await verifySessionToken(token, "segredo-de-teste", now)).sub, "gustavo");
  assert.equal(await verifySessionToken(`${token}x`, "segredo-de-teste", now), null);
  assert.equal(await verifySessionToken(token, "segredo-de-teste", now + 31 * 24 * 60 * 60 * 1000), null);
});

test("payload de sincronização v3 é validado", () => {
  const payload = { deviceId: "phone-1", report: { schema: "pscpp-study-report/v3", roundId: "2026-09-05" }, rawAttempts: { q1: { correct: true, selected: 2 } } };
  assert.equal(validateSyncPayload(payload).attempts.length, 1);
  assert.throws(() => validateSyncPayload({ ...payload, report: { schema: "v2", roundId: "x" } }), /incompatível/);
});

test("agregação calcula acurácia, revisões e fraquezas", () => {
  const rows = [
    { round_id: "r1", question_id: "q1", axis: "1", category: "review", correct: 1, mastery: 3, next_review: "2026-09-08T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z", payload_json: "{}" },
    { round_id: "r1", question_id: "q2", axis: "2", category: "current", correct: 0, mastery: 0, error_cause: "content", next_review: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z", payload_json: "{}" }
  ];
  const result = aggregateAttempts(rows, new Date("2026-09-05T12:00:00.000Z"));
  assert.equal(result.accuracy, 50);
  assert.equal(result.dueReviews.length, 1);
  assert.equal(result.weakest[0].questionId, "q2");
  assert.equal(result.byErrorCause.content, 1);
});

test("relatório adaptativo remove identidade e tentativas brutas", () => {
  const result = sanitizeLatestReport({
    student: "Nome privado",
    roundId: "r1",
    generatedAt: "2026-09-05T12:00:00.000Z",
    currentPath: "Eixo I",
    mode: "study",
    attempts: [{ selected: "b", answer: "a" }],
    summary: { answered: 10, correct: 8, wrong: 2, dueReviews: 2, byCategory: { review: { answered: 4, correct: 3 } } }
  });
  assert.equal(result.roundId, "r1");
  assert.equal(result.summary.wrong, 2);
  assert.equal("student" in result, false);
  assert.equal("attempts" in result, false);
});
