import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

export interface Job {
  id: string;
  createdAt: number;
  // Mesa dona da tarefa (quem deve executar).
  deskId: string;
  // Mesa que pediu (opcional).
  requestedBy: string | null;
  title: string;
  detail: string;
  status: "pendente" | "rodando" | "concluida" | "falhou";
  updatedAt: number;
  result: string | null;
  // "Agendar": só dispara (acorda a mesa) quando this momento chega.
  scheduledAt?: number;
  // Marcado quando o agendador já acordou a mesa para esta tarefa (evita re-disparo).
  announcedAt?: number;
}

const DATA_DIR = join(homedir(), ".atlas");
const JOBS_FILE = join(DATA_DIR, "jobs.json");

function readJobs(): Job[] {
  if (!existsSync(JOBS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: Job[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export function listJobs(): Job[] {
  // Mantém as últimas 100; as antigas saem pela limpeza implícita.
  return readJobs().sort((a, b) => b.createdAt - a.createdAt);
}

export function listPendingJobs(deskId?: string): Job[] {
  return listJobs().filter((j) => j.status === "pendente" && (!deskId || j.deskId === deskId));
}

export function createJob(input: { deskId: string; title: string; detail?: string; requestedBy?: string; scheduledAt?: number }): Job {
  const job: Job = {
    id: randomUUID().slice(0, 8),
    createdAt: Date.now(),
    deskId: input.deskId,
    requestedBy: input.requestedBy ?? null,
    title: input.title,
    detail: input.detail ?? "",
    status: "pendente",
    updatedAt: Date.now(),
    result: null,
  };
  if (input.scheduledAt && Number.isFinite(input.scheduledAt)) job.scheduledAt = input.scheduledAt;
  const jobs = listJobs();
  writeJobs([job, ...jobs].slice(0, 100));
  return job;
}

export function setJobStatus(id: string, status: Job["status"], result?: string | null): Job | null {
  const jobs = listJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  job.status = status;
  job.updatedAt = Date.now();
  if (result !== undefined) job.result = result;
  writeJobs(jobs);
  return job;
}

export function deleteJob(id: string): boolean {
  const jobs = listJobs();
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  writeJobs(next);
  return true;
}

// Tarefas agendadas que venceram e ainda não foram anunciadas. Marca `announcedAt`
// para o agendador não re-disparar a mesma tarefa se rodar de novo antes da mesa atender.
export function findScheduledDueJobs(): Job[] {
  const all = listJobs();
  const now = Date.now();
  const due = all.filter((j) => j.status === "pendente" && typeof j.scheduledAt === "number" && j.scheduledAt <= now && !j.announcedAt);
  if (due.length > 0) {
    const ids = new Set(due.map((j) => j.id));
    for (const j of all) if (ids.has(j.id)) j.announcedAt = now;
    writeJobs(all);
  }
  return due;
}

// A mesa recebeu estas tarefas junto de uma mensagem (ver pendingJobsNote em lib/office.ts).
export function markJobsAnnounced(ids: string[]): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  const all = listJobs();
  const now = Date.now();
  for (const j of all) if (set.has(j.id) && !j.announcedAt) j.announcedAt = now;
  writeJobs(all);
}

// Resumo para as mesas verem numa linha só o que está esperando.
export function summaryForDesk(deskId: string): string {
  const pending = listPendingJobs(deskId);
  if (pending.length === 0) return "";
  return pending.map((j) => `#${j.id}: ${j.title}`).join(" | ");
}