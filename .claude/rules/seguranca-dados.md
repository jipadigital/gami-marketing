# Segurança de Dados , Diretiva Permanente (PRIORIDADE MÁXIMA)

> Decisão do dono (27/10/2026): **segurança de informação é prioridade sempre.**
> Nenhum dado pode ficar exposto a ataque. Toda feature nova nasce segura.
> Isso vale para SEMPRE e para QUALQUER agente/pessoa que mexer neste sistema.

## Princípio

A chave pública do Supabase (`sb_publishable_...`) está no fonte do `index.html`,
visível a qualquer um. Ela é **não-confiável**: trate como se um atacante a tivesse.
O servidor (Netlify functions com `SUPA_SERVICE_KEY`) é a única fronteira de confiança.

## Regras inegociáveis

1. **Escrita (INSERT/UPDATE/DELETE) NUNCA com a chave pública.** Toda escrita passa
   pelo servidor: `_syncEscrever(...)` → `supabase-write.js` (valida sessão X-Gami-Token,
   usa service key, audita). A tabela precisa estar em `TABELAS_PERMITIDAS` (e em
   `TABELAS_COLAB` se qualquer logado opera a tela).

2. **Leitura de dado sensível NUNCA com a chave pública.** Dado comercial (crm_*,
   prospeccao_*, mv_*), operacional/cliente (machine_*), financeiro (faturamento) e
   PII (pessoas, ponto_*) lê pelo proxy: `supaLer`/`supaLerRPC` ou o interceptor de
   fetch (conjuntos `_SUPA_SENSIVEL` / `_SUPA_SENSIVEL_RPC`) → `supabase-read.js`.
   Ver [documentação viva em `docs/` e a arquitetura das etapas 2/3].

3. **RLS ligada em toda tabela, sempre.** Escrita bloqueada pela ausência de policy de
   escrita; leitura sensível bloqueada dropando a policy `*_sel`. MV e RPC: controle por
   `REVOKE` (SELECT/EXECUTE) do público, `GRANT` só a `service_role`.

4. **RPC `SECURITY DEFINER` que devolve dado sensível é vazamento.** Rotear pelo proxy
   e `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`.

5. **Segredo nunca vai pro cliente nem pra tabela lida pela chave pública.** Senhas,
   `pin_hash`, tokens, chaves de API, `SUPA_SERVICE_KEY`: só em env var do servidor.
   O Cloud Mirror tem blacklist , qualquer chave `gami_*` sensível entra nela.

6. **Ritmo seguro: rotear → deploy → TESTAR a tela → só então travar (SQL).** Nunca
   travar antes de testar. O usuário roda o SQL; eu confirmo com teste direto na chave
   pública (INSERT `{}` deve dar 401; SELECT sensível deve voltar `[]` ou negado).

7. **Toda feature/tabela NOVA nasce coberta por essas regras.** Antes de subir qualquer
   coisa que leia/escreva no banco: já roteia pelo servidor e já prevê a trava. Não
   existe "depois eu fecho".

## Checklist pra qualquer mudança que toque dados

- [ ] Escrita vai pelo `supabase-write`? Tabela em PERMITIDAS/COLAB?
- [ ] Leitura sensível vai pelo proxy `supabase-read`? Tabela/RPC nas listas brancas?
- [ ] RLS ligada? Policy `*_sel` tratada? RPC com `REVOKE EXECUTE` do público?
- [ ] Nenhum segredo exposto ao cliente ou a tabela anon-legível?
- [ ] Testei a tela antes de pedir pra rodar a trava?

Ver também: `docs/seguranca-rls-*.sql` (travas aplicadas) e o histórico das etapas 2 e 3.
