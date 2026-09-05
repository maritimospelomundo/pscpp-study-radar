# PSCPP Study Radar

Painel interativo de estudo e revisão adaptativa para o Processo Seletivo à Categoria de Praticante de Prático (PSCPP/DPC).

## Versão operacional

- questões de múltipla escolha com correção imediata;
- comentários técnicos de todas as alternativas;
- referência bibliográfica detalhada revelada após a resposta;
- avaliação de domínio de 0 a 3;
- revisão adaptativa com FSRS 6 (`ts-fsrs`);
- mapa dos sete eixos oficiais e das 85 referências recomendadas;
- biblioteca pesquisável com os 85 recortes oficiais, prioridades e duplicações;
- identificação `referenceId` e evidência verificável em cada questão;
- bloqueio automático de publicação para rodada ou referência inconsistente;
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

As respostas são preservadas no próprio dispositivo mesmo sem conexão. O projeto inclui uma API separada em Cloudflare Worker + D1 para:

- sincronizar tentativas entre celular e computador;
- conservar o histórico fora do navegador;
- produzir um relatório consolidado para a tarefa diária do GPT;
- autenticar a sincronização no servidor, sem publicar credenciais no GitHub Pages.

### Relatório para a automação diária

O endpoint `/api/automation-report` disponibiliza publicamente o relatório completo de progresso para a tarefa diária do GPT. Essa publicação foi autorizada pelo proprietário do projeto e não contém senha, token de sessão, `REPORT_READ_TOKEN` nem credenciais do Cloudflare. O endpoint `/api/report` permanece autenticado para compatibilidade administrativa.

Enquanto `data/config.json` estiver com `enabled: false`, o portal continua integralmente funcional em modo local. A sincronização só é ativada depois que o Worker, o D1 e os segredos forem configurados.

### Ativação do Worker

1. Crie no Cloudflare o banco D1 `pscpp-study-radar-db`.
2. Cadastre no repositório os segredos de Actions `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_D1_DATABASE_ID`.
3. Execute manualmente o workflow `Deploy Study Sync Worker`.
4. No Worker `pscpp-study-sync`, cadastre os segredos `PASSWORD_HASH`, `SESSION_SECRET` e `REPORT_READ_TOKEN`.
5. Confirme `GET /health` e altere `data/config.json` para `enabled: true`.

O token da API do Cloudflare precisa somente de permissões de edição de Workers Scripts e D1. Tokens e segredos nunca devem ser incluídos em commits.

O bloqueio de acesso é deliberadamente simples e executado no navegador. Como o código do GitHub Pages é público, ele reduz acessos casuais, mas não constitui autenticação segura de servidor.

## Publicação

O workflow `Deploy GitHub Pages` instala as dependências, valida a rodada e gera a PWA com Vite. O deploy é interrompido se não houver exatamente 10 questões no mix 4–3–2–1, se um `referenceId` não existir ou se faltar evidência bibliográfica.

## Protocolo de geração das questões

1. O gerador lê `data/bibliography.json`, `data/generation-policy.json` e o relatório adaptativo.
2. Seleciona três eixos simultâneos: principal, consolidação e rotação.
3. Localiza a publicação no Google Drive pelo título e consulta somente o recorte do Anexo 2-B.
4. Usa provas históricas para estilo e armadilhas, não como autoridade técnica.
5. Preenche publicação, edição, seção, item programático, `referenceId` e evidência.
6. Executa `npm run validate`; somente uma rodada aprovada segue para o Pages.

Os PDFs e livros não são copiados para o repositório público. O catálogo contém metadados; os arquivos permanecem na pasta conectada do Google Drive.

## Desenvolvimento

```bash
npm install
npm run dev
# antes de publicar
npm run validate
```
