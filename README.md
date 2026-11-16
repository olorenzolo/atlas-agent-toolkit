# atlas-agent-toolkit

Pequenos módulos em TypeScript, sem dependências em runtime, extraídos do **Atlas**, o painel que orquestra mais de 20 agentes de IA (Claude, Codex, OpenCode, Ollama) que uso no dia a dia. Cada módulo resolve um problema real de operar vários agentes ao mesmo tempo.

Small zero-dependency TypeScript modules extracted from **Atlas**, a production panel that orchestrates 20+ AI agents. Each one solves a real problem of running many agents at once.

| Módulo | Para que serve |
| --- | --- |
| `src/memory-search.ts` | Escolhe, por relevância, só os trechos de memória (notas) que casam com a mensagem e respeita um teto de caracteres. Evita mandar a memória inteira ao modelo e não repete o que já está na conversa. |
| `src/jobs.ts` | Fila de tarefas entre agentes com estados (`pendente`, `rodando`, `concluida`, `falhou`), agendamento e persistência em JSON. |
| `src/usage.ts` | Lê os logs de sessão do Claude Code e soma tokens por dia e por modelo, com o dia no fuso de São Paulo e leitura incremental (só o que foi acrescentado). |

## Uso

```bash
npm install
npm test        # 15 testes, runner nativo do Node
npm run typecheck
```

Requer Node 22+ (roda TypeScript direto pelo runner de testes).

## Contexto

O Atlas roda em produção atendendo um time de marketing: chat em tempo real por SSE, memória em SQLite, fila de tarefas, agendador, deploy atômico com rollback e acesso por Cloudflare Tunnel. O código do painel é privado; estes módulos são a parte que faz sentido reaproveitar.

Autor: [Lorenzo Pimentel](https://github.com/olorenzolo): full-stack e automação com IA.

## Licença

MIT
