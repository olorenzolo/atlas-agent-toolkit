import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, formatExcerpts, pickExcerpts, terms } from "../src/memory-search.ts";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Linha de contexto geral número ${i} sobre rotina da mesa.`).join("\n");

const notes = [
  {
    id: "black-friday",
    body: `# Black Friday Menopausa Cancelada\n\n${filler(20)}\n\nOferta da Black Friday: Kit de suplementos de R$900 por R$579, só na live de 10/11.\n\n${filler(20)}`,
  },
  { id: "mc-obrigado", body: "# Página de obrigado\n\nRotas /, /v2, /kit e /shot. Mídia com cache immutable, usar ?v=N." },
  { id: "checkout", body: "---\nname: suplementos-checkout\ndescription: checkout dos suplementos\n---\n# Checkout\n\nCAPI sem token no checkout dos suplementos." },
];

test("terms: sem acento, sem palavras vazias e cortadas em 5 letras", () => {
  assert.deepEqual(terms("Qual é o preço das Campanhas da Black Friday?"), ["preco", "campa", "black", "frida"]);
  assert.deepEqual(terms("campanha"), terms("campanhas"));
});

test("escolhe a nota certa e só o trecho que casa, dentro do teto", () => {
  const got = pickExcerpts(notes, "qual era o preço do kit na black friday?", { maxChars: 700 });
  assert.equal(got[0].id, "black-friday");
  assert.match(got[0].text, /R\$579/);
  assert.ok(got.reduce((n, e) => n + e.text.length, 0) <= 700);
  assert.ok(got[0].text.length < notes[0].body.length / 2, "não deve mandar a nota inteira");
});

test("título e frontmatter contam na escolha", () => {
  assert.equal(pickExcerpts(notes, "como está o checkout?")[0].id, "checkout");
});

test("a fala atual pesa mais que a anterior", () => {
  const got = pickExcerpts(notes, [
    { text: "pra que serve a rota do kit e do checkout dos suplementos?", weight: 0.35 },
    { text: "por que usar ?v=N nas mídias com cache?", weight: 1 },
  ]);
  assert.equal(got[0].id, "mc-obrigado");
});

test("skip pula pedaços que já estão na conversa", () => {
  const first = pickExcerpts(notes, "preço do kit na black friday", { maxChars: 700 });
  const again = pickExcerpts(notes, "preço do kit na black friday", { maxChars: 700, skip: (c) => first[0].text.includes(c) });
  assert.ok(!again.some((e) => e.text && first[0].text.includes(e.text)));
});

test("sem palavra que case, não manda nada", () => {
  assert.deepEqual(pickExcerpts(notes, "oi, tudo bem?"), []);
  assert.deepEqual(pickExcerpts([], "black friday"), []);
  assert.equal(formatExcerpts([]), "");
});

test("chunkText respeita o tamanho e não perde texto", () => {
  const text = `${"a".repeat(50)}\n\n${"b".repeat(1500)}\n\n${"c".repeat(30)}`;
  const chunks = chunkText(text, 600);
  assert.ok(chunks.every((c) => c.length <= 600));
  assert.equal(chunks.join("").replace(/\n/g, "").length, 1580);
});
