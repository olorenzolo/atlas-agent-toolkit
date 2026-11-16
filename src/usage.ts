import { open, readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface UsageEvent {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionId: string;
  cwd: string;
}

export interface UsageSummary {
  today: { totalTokens: number; messages: number; activeMs: number };
  last7Days: { totalTokens: number; messages: number; activeMs: number };
  byModel: Record<string, { totalTokens: number; messages: number }>;
  byDay: { date: string; totalTokens: number }[];
  events: UsageEvent[];
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TZ = "America/Sao_Paulo";

// Os .jsonl do Claude passam de 1 GB e só crescem (append). Ler e dar JSON.parse em tudo a
// cada requisição levava ~50 s e travava o processo inteiro. Aqui cada arquivo guarda até
// onde já foi lido e os eventos extraídos; a próxima chamada lê só os bytes novos.
interface FileCache {
  offset: number;
  mtimeMs: number;
  events: UsageEvent[];
}

const g = globalThis as unknown as {
  __usageFiles?: Map<string, FileCache>;
  __usageInFlight?: Promise<UsageSummary> | null;
};
const files = g.__usageFiles ?? (g.__usageFiles = new Map());

async function walkJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonlFiles(full)));
    else if (e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function parseLine(line: string): UsageEvent | null {
  // Filtro barato antes do JSON.parse: a maioria das linhas (tool results, mensagens do
  // usuário) não tem uso de tokens e algumas têm megabytes.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let obj: {
    type?: string;
    timestamp?: string;
    sessionId?: string;
    session_id?: string;
    cwd?: string;
    message?: {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = obj.message?.usage;
  if (obj.type !== "assistant" || !usage || !obj.timestamp) return null;
  return {
    timestamp: obj.timestamp,
    model: obj.message?.model ?? "unknown",
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    sessionId: obj.sessionId ?? obj.session_id ?? "unknown",
    cwd: obj.cwd ?? "",
  };
}

// Lê do offset guardado até a última quebra de linha (uma linha pela metade, ainda sendo
// escrita, fica pra próxima vez).
async function refreshFile(path: string): Promise<void> {
  let s;
  try {
    s = await stat(path);
  } catch {
    files.delete(path);
    return;
  }
  let c = files.get(path);
  // Arquivo encolheu ou foi reescrito: começa de novo.
  if (c && (s.size < c.offset || s.mtimeMs < c.mtimeMs)) c = undefined;
  if (!c) c = { offset: 0, mtimeMs: 0, events: [] };
  files.set(path, c);
  if (s.size === c.offset) {
    c.mtimeMs = s.mtimeMs;
    return;
  }

  const fh = await open(path, "r");
  try {
    const chunk = 8 * 1024 * 1024;
    let pos = c.offset;
    let carry = Buffer.alloc(0);
    while (pos < s.size) {
      const buf = Buffer.alloc(Math.min(chunk, s.size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        carry = Buffer.from(data);
        continue;
      }
      for (const line of data.subarray(0, lastNl).toString("utf-8").split("\n")) {
        const e = parseLine(line);
        if (e) c.events.push(e);
      }
      carry = Buffer.from(data.subarray(lastNl + 1));
    }
    c.offset = pos - carry.length;
    c.mtimeMs = s.mtimeMs;
  } finally {
    await fh.close();
  }
}

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayKey = (ms: number) => dayFmt.format(ms);

async function computeSummary(): Promise<UsageSummary> {
  const paths = await walkJsonlFiles(PROJECTS_DIR);
  const live = new Set(paths);
  for (const p of files.keys()) if (!live.has(p)) files.delete(p);
  for (const p of paths) await refreshFile(p);

  const events: UsageEvent[] = [];
  for (const c of files.values()) events.push(...c.events);
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const now = Date.now();
  const today = dayKey(now);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const byModel: UsageSummary["byModel"] = {};
  const byDayMap = new Map<string, number>();
  let todayTokens = 0,
    todayMsgs = 0,
    weekTokens = 0,
    weekMsgs = 0,
    todayActiveMs = 0,
    weekActiveMs = 0;

  // Tempo de uso é estimado somando os intervalos entre mensagens consecutivas
  // (por sessão) quando o intervalo é curto o bastante pra ser "uso contínuo"
  // (< 5 min) — gaps maiores viram silêncio/pausa e não contam.
  const ACTIVE_GAP_MS = 5 * 60 * 1000;
  const lastTsBySession = new Map<string, number>();

  for (const e of events) {
    const t = e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;

    if (!byModel[e.model]) byModel[e.model] = { totalTokens: 0, messages: 0 };
    byModel[e.model].totalTokens += t;
    byModel[e.model].messages += 1;

    const day = dayKey(ts);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + t);

    const prevTs = lastTsBySession.get(e.sessionId);
    let gap = 0;
    if (prevTs !== undefined) {
      const delta = ts - prevTs;
      if (delta > 0 && delta <= ACTIVE_GAP_MS) gap = delta;
    }
    lastTsBySession.set(e.sessionId, ts);

    if (day === today) {
      todayTokens += t;
      todayMsgs += 1;
      todayActiveMs += gap;
    }
    if (ts >= sevenDaysAgo) {
      weekTokens += t;
      weekMsgs += 1;
      weekActiveMs += gap;
    }
  }

  const byDay = Array.from(byDayMap.entries())
    .map(([date, totalTokens]) => ({ date, totalTokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  return {
    today: { totalTokens: todayTokens, messages: todayMsgs, activeMs: todayActiveMs },
    last7Days: { totalTokens: weekTokens, messages: weekMsgs, activeMs: weekActiveMs },
    byModel,
    byDay,
    events: events.slice(-50).reverse(),
  };
}

// Duas abas abertas ao mesmo tempo dividem a mesma leitura em vez de ler tudo duas vezes.
export function getUsageSummary(): Promise<UsageSummary> {
  if (!g.__usageInFlight) {
    g.__usageInFlight = computeSummary().finally(() => {
      g.__usageInFlight = null;
    });
  }
  return g.__usageInFlight;
}
