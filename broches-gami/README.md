# Gâmi Dashboard — Broches PNG

Pacote completo com 23 broches organizados + código HTML/CSS/JS pronto para integrar no dashboard.

## Conteúdo do pacote

```
broches-gami/
├── README.md                          (este arquivo)
├── gami-broches-dashboard.html        (código pronto para colar no index.html)
├── senioridade/                       (10 broches)
│   ├── junior-1.png
│   ├── junior-2.png
│   ├── junior-3.png
│   ├── pleno-1.png
│   ├── pleno-2.png
│   ├── pleno-3.png
│   ├── senior-1.png
│   ├── senior-2.png
│   ├── senior-3.png
│   └── gerente.png
├── setores/                           (2 broches)
│   ├── marketing.png
│   └── comercial.png
└── cidades/                           (11 broches)
    ├── maceio.png
    ├── cuiaba.png
    ├── fortaleza.png
    ├── vitoria.png
    ├── sao-luis.png
    ├── joao-pessoa.png
    ├── recife.png
    ├── teresina.png
    ├── natal.png
    ├── aracaju.png
    └── campo-grande.png
```

## Passo a passo de instalação

### 1. Copiar os PNGs para o projeto

No seu projeto local (`C:\Users\Rapha\OneDrive\Documentos\GitHub\gami-marketing\`):

1. Crie a pasta `img/broches/` se não existir
2. Copie as 3 pastas (`senioridade`, `setores`, `cidades`) inteiras pra dentro de `img/broches/`

Estrutura final no projeto:
```
gami-marketing/
└── img/
    └── broches/
        ├── senioridade/
        ├── setores/
        └── cidades/
```

### 2. Integrar no index.html

Abra o arquivo `gami-broches-dashboard.html` deste pacote. Ele tem 3 blocos comentados:

- **Bloco 1 (`<style>`)** → cole dentro do `<head>` do `index.html`
- **Bloco 2 (HTML dos broches)** → cole onde os broches devem aparecer (provavelmente na aba Pessoas ou no modal de cadastro)
- **Bloco 3 (`<script>`)** → cole antes do `</body>`

### 3. Caminho dos PNGs

Se a estrutura do projeto for diferente (ex: `/assets/img/broches/`), edite a constante no script:

```js
const BROCHE_BASE_PATH = '/img/broches/';
```

### 4. Commit e deploy

1. GitHub Desktop → commit com mensagem tipo "Adicionar broches Gâmi"
2. Push pro GitHub
3. Netlify publica sozinho

## Como integrar com Supabase

### Salvar uma pessoa (tabela `pessoas`)

```js
const dados = {
  nivel_senioridade: document.getElementById('gx-input-nivel').value,
  setor: document.getElementById('gx-input-setor').value,
  cidade_atuacao: document.getElementById('gx-input-cidade').value
};
await supabase.from('pessoas').update(dados).eq('id', pessoaId);
```

### Carregar valores ao editar uma pessoa

```js
gxSetSelection('nivel', pessoa.nivel_senioridade);
gxSetSelection('setor', pessoa.setor);
gxSetSelection('cidade', pessoa.cidade_atuacao);
```

### Escutar mudanças em tempo real

```js
document.addEventListener('gx:change', (e) => {
  console.log(e.detail.group, e.detail.value);
  // ex: "setor", "Marketing"
});
```

## Comportamento visual

- **Não selecionado** → broche desbotado (cinza, opacidade 70%)
- **Hover** → cor cheia + sobe levemente + tooltip com nome
- **Selecionado** → cor cheia + anel branco com borda azul + sombra

## Personalização

### Tamanho do broche
No CSS, ajuste:
```css
.gx-broche { width: 84px; height: 84px; }
```

### Cor do anel de seleção (atualmente azul Gâmi)
```css
.gx-broche.active {
  box-shadow: 0 0 0 3px white, 0 0 0 5px #1d4ed8, ...;
}
```
Troque `#1d4ed8` pela cor desejada (ex: `#3dd3f5` pro ciano da logo).

## Adicionar novos broches no futuro

1. Salve o PNG na pasta correta (`senioridade/`, `setores/` ou `cidades/`)
2. No HTML, duplique uma linha de botão e ajuste:
   - `aria-label` (nome que aparece no tooltip)
   - `data-value` (valor salvo no Supabase)
   - `data-img` (caminho do PNG)

Exemplo:
```html
<button type="button" class="gx-broche"
        aria-label="Diretor"
        data-group="nivel"
        data-value="Diretor"
        data-img="senioridade/diretor.png"></button>
```
