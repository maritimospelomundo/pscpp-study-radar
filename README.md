# PSCPP Study Radar

Painel interativo de estudo e revisão adaptativa para o Processo Seletivo à Categoria de Praticante de Prático (PSCPP/DPC).

## Versão operacional

- questões de múltipla escolha com correção imediata;
- comentários técnicos de todas as alternativas;
- referência bibliográfica detalhada revelada após a resposta;
- avaliação de domínio de 0 a 3;
- revisão adaptativa com FSRS 6 (`ts-fsrs`);
- mapa dos sete eixos oficiais e das 85 referências recomendadas;
- relatório JSON exportável para leitura pelo GPT;
- histórico offline em IndexedDB (`Dexie.js`), com contingência em `localStorage`;
- PWA instalável e operacional offline (`vite-plugin-pwa`);
- tela de acesso pessoal com senha validada por hash e sessão temporária;
- publicação automática no GitHub Pages.
- progressão em espiral intercalada com composição diária 4–3–2–1;
- modos Estudo (correção imediata) e Simulado (correção ao final);
- registro do tempo de resposta e da causa provável dos erros;
- rotação planejada entre os sete eixos oficiais.

## Estado inicial importado

- percurso principal: Resolução MSC.137(76), início dos padrões de manobrabilidade;
- conteúdo consolidado: IMO A.601(15), Apêndice 3, §§5–7;
- última rodada registrada: 30/30;
- rodada diária: 4 revisões, 3 questões do tema principal, 2 matérias alternadas e 1 questão oficial histórica.

## Persistência e sincronização

As respostas são preservadas no próprio dispositivo mesmo sem conexão. A próxima etapa conectará o painel ao Cloudflare Worker + D1 para sincronização entre dispositivos e leitura automática pela tarefa diária.

O bloqueio de acesso é deliberadamente simples e executado no navegador. Como o código do GitHub Pages é público, ele reduz acessos casuais, mas não constitui autenticação segura de servidor.

## Publicação

O workflow `Deploy GitHub Pages` instala as dependências, gera a PWA com Vite e publica a pasta `dist`.

## Desenvolvimento

```bash
npm install
npm run dev
```
