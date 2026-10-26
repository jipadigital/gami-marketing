# Robô de atendimento — Instagram DM (FAQ)

Função: `ig-webhook.js`. Recebe DM do Instagram, responde dúvidas frequentes com IA. **Nunca fala preço.** Fora do FAQ, passa pra um humano.

URL do webhook (depois do deploy):
```
https://gami-marketing.netlify.app/.netlify/functions/ig-webhook
```

## Como ativar

### 1. Variáveis de ambiente no Netlify
- `META_VERIFY_TOKEN` = um texto que você inventa (ex.: `gami-atende-2026`). Vai repetir na Meta.
- `IG_BOT_ATIVO` = `false` por enquanto (deixa o robô recebendo mas **sem responder**, pra testar). Troca pra `true` quando quiser ligar de verdade.
- `META_USER_TOKEN` e `ANTHROPIC_API_KEY` já existem.

### 2. Permissões na Meta (developers.facebook.com → seu app)
O token precisa das permissões de mensagem do Instagram:
- `instagram_manage_messages`
- `pages_messaging`
- `pages_show_list`, `instagram_basic` (já usadas)

Gere um token novo com essas permissões (Graph API Explorer) e atualize `META_USER_TOKEN` no Netlify.

### 3. Configurar o Webhook (produto "Webhooks" ou "Instagram" no app da Meta)
- **Callback URL:** a URL acima.
- **Verify token:** o mesmo valor de `META_VERIFY_TOKEN`.
- Clique em **Verificar e salvar** (a Meta chama o GET; a função responde o challenge).
- **Assinar o campo:** `messages` (e opcionalmente `messaging_postbacks`).
- Em **Instagram → Webhooks**, assine a conta/página de cada cidade que terá o robô.

### 4. Ligar a conta IG à Página do Facebook
Cada conta Instagram Business precisa estar ligada a uma Página do Facebook (já estão, pois aparecem em `list_accounts`). O envio de mensagem usa o token da Página.

### 5. Testar
1. Com `IG_BOT_ATIVO=false`: mande uma DM pra conta. Nos logs da função (Netlify → Functions → ig-webhook) deve aparecer o evento. Nada é respondido ainda.
2. Troque `IG_BOT_ATIVO=true` e redeploy. Mande "como faço pra ser entregador?" → deve responder o FAQ. Mande "quanto custa a entrega?" → deve responder que um atendente passa os valores, **sem dizer número**.

## Editar o que o robô sabe
Tudo no topo do `ig-webhook.js`, na constante `FAQ`. É texto puro, fácil de mexer.

## Limites (importante)
- A Meta só deixa responder **dentro de 24h** depois que o cliente mandou mensagem. Serve bem pra atendimento, não serve pra abordar quem não falou primeiro.
- Não dá pra sair seguindo empresas nem mandar DM em massa pela API oficial (isso é contra as regras do Instagram e derruba a conta). Para abordagem ativa, use WhatsApp + o CRM.
