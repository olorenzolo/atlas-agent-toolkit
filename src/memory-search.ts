// Busca automática nas notas de memória de uma mesa, para o motor ollama: o Qwen não tem
// ferramentas nem espaço para ler as notas inteiras (a memória da Olívia passa de 70 mil
// caracteres e o contexto dele é de uns 16 mil), então o Office escolhe as notas mais
// ligadas à mensagem e manda só os trechos que mais casam com ela, dentro de um teto.
// Pontuação BM25 simples sobre palavras sem acento, cortadas em 5 letras para juntar
// singular/plural ("campanha"/"campanhas"). Sem dependências, para testar sem o banco.

export interface NoteLike {
  id: string;
  title?: string;
  body: string;
}

export interface NoteExcerpt {
  id: string;
  text: string;
}

const STOPWORDS = new Set(
  (
    "que com para por mais como mas dos das nos nas num numa uma uns umas pelo pela pelos pelas " +
    "este esta estes estas esse essa esses essas isso isto aquilo aquele aquela ele ela eles elas " +
    "voce voces seu sua seus suas meu minha meus minhas nosso nossa tem ter tinha temos sao ser foi " +
    "era esta estao estava ficar fica vai vou pode posso pra pro qual quais quando onde quem sobre " +
    "entre ate apos sem tambem muito muita bem aqui ali agora entao ainda depois antes sempre nunca " +
    "nao sim faz fazer feito quero queria preciso precisa me mim lhe ela eles todo toda todos todas " +
    "cada outro outra outros outras algum alguma qualquer coisa coisas tipo assim dai tudo nada " +
    "oque ola obrigado valeu beleza the and"
  ).split(" ")
);

export function terms(text: string): string[] {
  const words = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.slice(0, 5));
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

// Tira o frontmatter (--- ... ---) do começo da nota: ele entra só na pontuação do título.
function splitFrontmatter(body: string): { head: string; text: string } {
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { head: m[1], text: body.slice(m[0].length) } : { head: "", text: body };
}

// Pedaços de até `size` caracteres: parágrafos inteiros quando cabem, linhas quando não,
// e corte seco só para uma linha maior que o pedaço.
export function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) {
      pieces.push(p);
      continue;
    }
    for (const line of p.split("\n")) {
      for (let i = 0; i < line.length; i += size) pieces.push(line.slice(i, i + size));
    }
  }
  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + piece.length + 1 > size) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// `query` pode vir em partes com peso (a fala atual pesa mais que a anterior, que só ajuda
// em continuações curtas). `skip` descarta pedaços que já estão na conversa (o motor ollama
// guarda os trechos no histórico e não manda o mesmo pedaço duas vezes).
export function pickExcerpts(
  notes: NoteLike[],
  query: string | { text: string; weight: number }[],
  {
    maxNotes = 2,
    maxChars = 2500,
    chunkChars = 600,
    skip,
  }: { maxNotes?: number; maxChars?: number; chunkChars?: number; skip?: (chunk: string) => boolean } = {}
): NoteExcerpt[] {
  const weight = new Map<string, number>();
  for (const part of typeof query === "string" ? [{ text: query, weight: 1 }] : query) {
    for (const t of terms(part.text)) weight.set(t, Math.max(weight.get(t) ?? 0, part.weight));
  }
  const q = Array.from(weight.keys());
  if (!q.length || !notes.length) return [];

  const docs = notes.map((n) => {
    const { head, text } = splitFrontmatter(n.body);
    const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
    return { id: n.id, text, tf: counts(terms(text)), title: new Set(terms(`${n.id.replace(/-/g, " ")} ${n.title ?? ""} ${head} ${firstLine}`)) };
  });
  const lengths = docs.map((d) => Array.from(d.tf.values()).reduce((a, b) => a + b, 0));
  const avgLen = lengths.reduce((a, b) => a + b, 0) / docs.length || 1;
  // Já multiplicado pelo peso da parte da pergunta de onde o termo veio.
  const idf = new Map(
    q.map((t) => {
      const df = docs.filter((d) => d.tf.has(t) || d.title.has(t)).length;
      return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * (weight.get(t) ?? 1)];
    })
  );

  const k1 = 1.2;
  const b = 0.75;
  const scored = docs
    .map((d, i) => {
      let score = 0;
      for (const t of q) {
        const tf = d.tf.get(t) ?? 0;
        const w = idf.get(t) ?? 0;
        score += w * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[i]) / avgLen)));
        if (d.title.has(t)) score += 2 * w;
      }
      return { d, score };
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, maxNotes);
  if (!scored.length) return [];

  // Pedaços das notas escolhidas, do que mais casa para o que menos; fica só o que tem
  // pelo menos um terço da força do melhor, até o teto de caracteres.
  const candidates = scored.flatMap(({ d }, rank) =>
    chunkText(d.text, chunkChars).map((text, index) => {
      const tf = counts(terms(text));
      let score = 0;
      for (const t of q) score += (idf.get(t) ?? 0) * Math.min(tf.get(t) ?? 0, 3);
      return { id: d.id, rank, index, text, score };
    })
  );
  const best = Math.max(0, ...candidates.map((c) => c.score));
  if (best <= 0) return [];
  const chosen: typeof candidates = [];
  let total = 0;
  for (const c of candidates.filter((c) => c.score >= best / 3).sort((x, y) => y.score - x.score)) {
    if (total + c.text.length > maxChars || skip?.(c.text)) continue;
    chosen.push(c);
    total += c.text.length;
  }

  return scored
    .map(({ d }) => {
      const parts = chosen.filter((c) => c.id === d.id).sort((x, y) => x.index - y.index);
      return { id: d.id, text: parts.map((p) => p.text).join("\n[…]\n") };
    })
    .filter((e) => e.text);
}

export function formatExcerpts(excerpts: NoteExcerpt[]): string {
  if (!excerpts.length) return "";
  const body = excerpts.map((e) => `### nota ${e.id}.md\n${e.text}`).join("\n\n");
  return `[Trechos da memória desta mesa, escolhidos automaticamente pelo Atlas para esta mensagem. Use-os como fonte se ajudarem; se a resposta não estiver neles, diga que não sabe em vez de inventar.]\n${body}\n\n[Mensagem do Lorenzo:]`;
}
