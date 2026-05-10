# Configurar Portal Gâmi para permitir embed no dashboard

O portal `portal.gamidelivery.com.br` (WordPress) bloqueia ser embutido em iframes
por causa do header HTTP `X-Frame-Options: DENY`. Pra que o dashboard
(`gami-marketing.netlify.app`) consiga embutir o portal, precisamos remover esse
header e adicionar uma política CSP (`Content-Security-Policy: frame-ancestors`)
permitindo o domínio do dashboard.

## Caminho mais simples — via WordPress Admin (functions.php)

Esse é o caminho recomendado se você não quer mexer em arquivos do servidor.

1. Vai em [Softaculous](https://gamidelivery.com.br:2083/cpsess.../frontend/jupiter/softaculous/)
   → **WordPress Manager** → linha do `portal.gamidelivery.com.br` → botão **Login**
2. Já dentro do `wp-admin`, no menu lateral: **Aparência → Editor de Arquivos do Tema**
3. No painel direito (Arquivos do tema), procure **`functions.php`** do tema **ativo**
   (pode estar como `theme-functions.php` ou similar)
4. Clique no arquivo. Vai abrir o editor.
5. **No FINAL do arquivo** (depois de tudo, mas antes do `?>` se houver), cole:

```php
/* ===== Permitir embed no dashboard Gâmi ===== */
add_action('init', function () {
    // Remove X-Frame-Options (que estava setado como DENY)
    remove_action('admin_init', 'send_frame_options_header');
    remove_action('login_init', 'send_frame_options_header');
    // Garante que NENHUMA outra parte mande o header também
    if (!headers_sent()) {
        header_remove('X-Frame-Options');
    }
}, 1);

add_action('send_headers', function () {
    if (!headers_sent()) {
        header_remove('X-Frame-Options');
        header(
            "Content-Security-Policy: frame-ancestors 'self' " .
            "https://gami-marketing.netlify.app " .
            "https://*.netlify.app " .
            "https://gamidelivery.com.br " .
            "https://www.gamidelivery.com.br"
        );
    }
});
```

6. Clique em **Atualizar Arquivo** (botão azul no final).

## Caminho mais robusto — via .htaccess (recomendado se .htaccess existir)

Se o portal usa Apache (provável, é hospedagem cPanel), o `.htaccess` da pasta
do portal pode controlar headers HTTP de forma global, sem depender do tema.

1. cPanel → **Gerenciador de Arquivos** → ative **"Mostrar arquivos ocultos"**
   (ícone ⚙ Configurações no canto superior direito → marca "Show Hidden Files")
2. Navegue até a pasta do portal. Provável caminho:
   - `public_html/portal/` (se for instalação em subpasta) **OU**
   - `subdomains/portal/` ou pasta dedicada ao subdomínio
   - Se não souber, peça pra hospedagem te indicar a "document root" do
     subdomínio `portal.gamidelivery.com.br`
3. Encontre o arquivo `.htaccess` na pasta do portal. Clique com botão direito → **Edit**
4. **No início do arquivo** (antes do bloco `# BEGIN WordPress`), cole:

```apache
# ===== Permitir embed no dashboard Gâmi =====
<IfModule mod_headers.c>
    # Remove o X-Frame-Options DENY que o WordPress manda por padrão
    Header always unset X-Frame-Options
    # Política moderna (compatível com Chrome/Firefox/Safari atuais)
    Header always set Content-Security-Policy "frame-ancestors 'self' https://gami-marketing.netlify.app https://*.netlify.app https://gamidelivery.com.br https://www.gamidelivery.com.br"
</IfModule>
```

5. **Save Changes** (botão no canto superior direito do editor).

## Como testar se funcionou

Depois de aplicar UMA das duas alterações acima:

1. Abre uma aba anônima (Ctrl+Shift+N) e vai em
   `https://portal.gamidelivery.com.br/`
2. Pressiona F12 → aba **Network**
3. Recarrega a página (F5)
4. Clica na primeira request (a do HTML principal) → painel direito → aba
   **Headers**
5. Procura na seção **Response Headers**:
   - Não deve ter `X-Frame-Options: DENY` (se tiver, ainda está bloqueado)
   - Deve ter `Content-Security-Policy: frame-ancestors ...` listando
     `gami-marketing.netlify.app`

Se as duas condições estão OK, abre o dashboard `gami-marketing.netlify.app`,
vai em **🔗 Portal Gâmi** no menu, dá Ctrl+F5 e o iframe deve carregar
normalmente em vez de mostrar a tela do cadeado.

## Se algo der errado

- **Tela de erro 500 no portal:** o código colado tem typo ou conflito. Volte
  no editor e remova o que adicionou.
- **Iframe ainda bloqueia depois da mudança:** algum plugin de segurança
  (Wordfence, iThemes Security, All-in-One Security) pode estar adicionando o
  header `X-Frame-Options` em cima. Vá em **Plugins instalados** e procure plugin
  de segurança → opção "Hide Server Headers" ou "Frame Protection" → desativa
  só essa opção.
- **CSP bloqueando recursos do próprio portal:** se as imagens, JS ou CSS do
  portal pararem de carregar, abra a console do navegador (F12) e veja a
  mensagem CSP. Você pode precisar adicionar mais `frame-ancestors` ou alguma
  outra diretiva.

## Observações de segurança

A política `frame-ancestors` que estamos definindo é restritiva: só permite
que o portal seja embutido em:
- O próprio portal (`'self'`)
- O dashboard Netlify (`gami-marketing.netlify.app` e qualquer subdomínio
  Netlify, útil pra deploys de preview)
- O domínio principal (`gamidelivery.com.br` e `www.`)

Sites externos NÃO conseguem embutir o portal — proteção contra clickjacking
mantida.
