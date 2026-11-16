import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "office-usage-"));
process.env.HOME = home;
const { getUsageSummary } = await import("../src/usage.ts");
const dir = join(home, ".claude", "projects", "proj");
mkdirSync(dir, { recursive: true });
const file = join(dir, "s.jsonl");
after(() => rmSync(home, { recursive: true, force: true }));

const line = (timestamp: string, tokens: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "s1",
    message: { model: "claude-opus-5-5", usage: { input_tokens: tokens, output_tokens: 0 } },
  }) + "\n";

test("dia de uso segue o fuso de São Paulo, não o UTC", async () => {
  // 02:30 UTC de 05/10 ainda é 23:30 de 04/10 em Brasília.
  writeFileSync(file, line("2026-10-05T02:30:00.000Z", 10) + line("2026-10-05T12:00:00.000Z", 5));
  const s = await getUsageSummary();
  assert.deepEqual(s.byDay, [
    { date: "2026-10-04", totalTokens: 10 },
    { date: "2026-10-05", totalTokens: 5 },
  ]);
  assert.equal(s.byModel["claude-opus-5-5"].messages, 2);
});

test("lê só o que foi acrescentado e espera a linha terminar", async () => {
  const next = line("2026-10-06T15:00:00.000Z", 7);
  appendFileSync(file, '{"type":"user","message":"sem usage"}\n' + next.slice(0, 20));
  let s = await getUsageSummary();
  assert.equal(s.byDay.length, 2, "linha pela metade não pode contar");

  appendFileSync(file, next.slice(20));
  s = await getUsageSummary();
  assert.deepEqual(s.byDay.at(-1), { date: "2026-10-06", totalTokens: 7 });
  assert.equal(s.byModel["claude-opus-5-5"].messages, 3);
});

test("arquivo reescrito menor é lido de novo do zero", async () => {
  writeFileSync(file, line("2026-10-07T15:00:00.000Z", 1));
  const s = await getUsageSummary();
  assert.deepEqual(s.byDay, [{ date: "2026-10-07", totalTokens: 1 }]);
});
