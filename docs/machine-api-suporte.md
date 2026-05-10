# Solicitação à Machine / Gaudium — chave de produção

## Resumo do bloqueio

A integração entre o dashboard interno da Gâmi Delivery (gami-marketing.netlify.app)
e a Machine API atualmente retorna **HTTP 401 — "Access credentials are invalid"**
em todas as chamadas a `https://api.taximachine.com.br/api/integracao`.

O ambiente de homologação (`https://api-trial.taximachine.com.br`) está caído
(503) e as chaves no formato `mch_api_*` que estão configuradas hoje aparentam
ser de homologação — funcionavam no `api-trial` mas não em produção.

## Template de e-mail / chamado

> **Assunto:** Solicitação de chave de produção da API — Central 4012 (Gâmi Delivery)
>
> Olá, equipe Machine / Gaudium,
>
> Sou Cleyton Frank, marketing da Gâmi Delivery (central 4012, conta
> jipadigital@gmail.com no painel meupaineldegestao.com.br).
>
> Estamos integrando nosso dashboard interno (Netlify Functions, server-side)
> com a API de integração de vocês para puxar dados de corridas, condutores e
> empresas das nossas 10 cidades operantes.
>
> Atualmente recebemos **401 Access credentials are invalid** em
> `https://api.taximachine.com.br/api/integracao/<endpoint>` usando o header
> `api-key: mch_api_*` que está cadastrado no painel.
>
> Suspeitamos que essas chaves são de homologação, já que o ambiente
> `api-trial.taximachine.com.br` aceitava as mesmas chaves antes de ficar
> indisponível (503 nos últimos dias).
>
> Pedimos por favor:
>
> 1. Confirmação de que precisamos de **chaves de produção distintas** para
>    cada cidade (uma chave por filial), e como solicitá-las;
> 2. Ou — se a chave do painel já é a única — quais permissões/escopos
>    precisamos liberar para conseguir consumir os endpoints
>    `empresa`, `condutor`, `consultarSolicitacao` em produção;
> 3. Documentação atualizada do header de autenticação aceito em produção
>    (estamos usando `api-key: <chave>`, descoberto na documentação pública).
>
> Cidades que dependem dessa chave:
> Fortaleza, Maceió, João Pessoa, Recife, Natal, Aracaju, São Luís, Cuiabá,
> Teresina, Vitória, e em breve Campo Grande.
>
> Obrigado!
> Cleyton Frank — Marketing Gâmi Delivery — jipadigital@gmail.com

## Como testar quando a chave nova chegar

1. **Atualizar env vars no Netlify** (Site settings → Environment variables):
   - Trocar cada `MACHINE_API_KEY_<CIDADE>` para a nova chave de produção
   - Confirmar que `MACHINE_BASE_URL=https://api.taximachine.com.br/api/integracao`
2. **Triggerar redeploy** — Site → Deploys → Trigger deploy → Clear cache and deploy.
3. **Testar uma cidade**:

   ```
   https://gami-marketing.netlify.app/.netlify/functions/machine?cidade=fortaleza&endpoint=empresa
   ```

   Resposta esperada: JSON com dados da empresa. Se ainda vier 401, o campo
   `gami_hint` na resposta vai indicar exatamente o que checar.
4. **Sincronizar os contadores de corridas no dashboard** (aba Cidades →
   Insights por cidade → "Buscar dados Machine").

## Referência rápida — endpoints suportados

A function `netlify/functions/machine.js` é proxy genérico. Qualquer endpoint
da Machine pode ser chamado com:

```
GET /.netlify/functions/machine?cidade=<slug>&endpoint=<endpoint>&<params>
```

Os principais usados pelo dashboard são `empresa`, `condutor`,
`consultarSolicitacao`. Cada `cidade` mapeia para uma env var distinta
(ver `CITY_KEY_MAP` em `machine.js`).
