import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// lib/jobs.ts lê o homedir() ao carregar: o HOME falso precisa vir antes do import.
const home = mkdtempSync(join(tmpdir(), "office-jobs-"));
process.env.HOME = home;
const jobs = await import("../src/jobs.ts");
const file = join(home, ".atlas", "jobs.json");

before(() => rmSync(file, { force: true }));
after(() => rmSync(home, { recursive: true, force: true }));

test("cria, lista e conclui uma tarefa", () => {
  const job = jobs.createJob({ deskId: "mateus", title: "relatório de CPL", detail: "semana 44" });
  assert.equal(job.status, "pendente");
  assert.deepEqual(jobs.listPendingJobs("mateus").map((j) => j.id), [job.id]);
  assert.equal(jobs.listPendingJobs("outra").length, 0);
  assert.equal(jobs.summaryForDesk("mateus"), `#${job.id}: relatório de CPL`);

  const done = jobs.setJobStatus(job.id, "concluida", "CPL R$ 12");
  assert.equal(done?.status, "concluida");
  assert.equal(done?.result, "CPL R$ 12");
  assert.equal(jobs.listPendingJobs("mateus").length, 0);
  assert.equal(jobs.setJobStatus("nao-existe", "falhou"), null);
});

test("guarda só as 100 mais recentes", () => {
  for (let i = 0; i < 105; i++) jobs.createJob({ deskId: "x", title: `t${i}` });
  assert.equal(jobs.listJobs().length, 100);
  assert.equal(JSON.parse(readFileSync(file, "utf-8")).length, 100);
});

test("agendada só vence uma vez", () => {
  const past = jobs.createJob({ deskId: "a", title: "vencida", scheduledAt: Date.now() - 1000 });
  jobs.createJob({ deskId: "a", title: "futura", scheduledAt: Date.now() + 3_600_000 });
  assert.deepEqual(jobs.findScheduledDueJobs().map((j) => j.id), [past.id]);
  assert.equal(jobs.findScheduledDueJobs().length, 0);
});

test("deleteJob remove e avisa quando não acha", () => {
  const job = jobs.createJob({ deskId: "d", title: "apagar" });
  assert.equal(jobs.deleteJob(job.id), true);
  assert.equal(jobs.deleteJob(job.id), false);
});

test("arquivo corrompido não derruba a fila", () => {
  mkdirSync(join(home, ".atlas"), { recursive: true });
  writeFileSync(file, '[{"id": "pela met');
  assert.deepEqual(jobs.listJobs(), []);
});
