# Tracker FV — Versão web

Página HTML que reproduz o pipeline Python (`tracker_pipeline_spa.py`) inteiramente no navegador. Não precisa servidor: os cálculos rodam em JavaScript no cliente, e os dados do CSV nunca saem da máquina do usuário.

## Arquivos

| Arquivo | Função |
|---|---|
| `tracker_analyzer.html` | Página principal com interface, formulários, gráficos. |
| `spa.js` | Algoritmo SPA portado de `spa_python.py`. |
| `spa_tables.js` | Tabelas numéricas do SPA (auto-geradas — não edite à mão). |
| `pipeline.js` | Marion-Dobos, backtracking, geometria, máscara noturna. |
| `generate_spa_tables.py` | Script para regenerar `spa_tables.js` a partir do `spa_python.py`. Rodar apenas se atualizar o Python. |

## Como rodar localmente

Abra `tracker_analyzer.html` diretamente no navegador (Chrome, Firefox, Edge ou Safari recentes). A página precisa de conexão com a internet **apenas no primeiro carregamento**, para baixar Plotly e PapaParse das CDNs. Os scripts SPA e pipeline são locais.

Se preferir servir via HTTP local (alguns navegadores recusam `file://`):

```bash
cd pasta_da_pagina
python3 -m http.server 8000
# abrir http://localhost:8000/tracker_analyzer.html
```

## Como publicar online (interno)

Como toda a lógica é client-side, qualquer hospedagem estática serve:

- **GitHub Pages**: push para um repo, ative Pages na branch `main`.
- **Netlify** ou **Cloudflare Pages**: drag-and-drop da pasta.
- **Servidor interno**: qualquer servidor HTTP que sirva arquivos estáticos (Nginx, Apache, IIS).

Não há backend, banco de dados ou API a manter.

## Como usar

1. **Configurar parâmetros do sítio e do tracker** no topo da página. Os valores default são os do seu caso (São Paulo, ±60° mecânico, GCR = 0.4142).
2. **Arrastar o CSV** para a área de upload (ou clicar para selecionar).
3. A página detecta automaticamente as colunas de data/hora e inclinação. Se errar a detecção, escolher manualmente.
4. Clicar em **Calcular**. Para 1000 amostras o cálculo leva ~70 ms; para um ano de dados a 1 min (525 mil amostras) leva ~40 s no Chrome.
5. **Auto-teste**: o botão `Rodar auto-teste` executa as mesmas verificações do `--self-test` do Python, mostrando o resultado na própria página. Útil quando se desconfia do navegador ou da máquina.
6. **Exportar**: ao final do cálculo, links para baixar o CSV completo de resultados e os gráficos em PNG.

## Convenções (lembrete)

- **Timestamps no CSV**: assumidos em **hora civil local** correspondente ao fuso configurado. Se o CSV estiver em UTC, ajuste o campo de fuso para `0`.
- **Azimute do eixo**: o default é `0=N, negativo=Leste` (compatível com o pipeline Python original). Quem usar pvlib pode alternar para `0=N, positivo=Leste`.
- **Sinal do sensor**: por padrão, rotação positiva = módulo inclinado para Leste. Se seu sensor for invertido, alternar no menu.

## Verificação numérica

A versão JavaScript reproduz a Python com precisão de ponto flutuante. Validado em 18 pontos de teste no CSV `Inclinacao_200426.csv`:

- Diferença máxima em zenith, azimuth, incidência: **5×10⁻⁷ °**.
- Diferença máxima em rotação Marion-Dobos, backtracking, comando dinâmico: **5×10⁻⁷ °**.
- Caso de referência Reda &amp; Andreas (2003-10-17 Denver): bate em **<10⁻⁶ °**.

## Formatos de data/hora aceitos

- `YYYY-MM-DD HH:MM:SS` ou `YYYY-MM-DDTHH:MM:SS`
- `DD/MM/YYYY HH:MM:SS`
- Outros formatos podem funcionar via `new Date()` do navegador, mas não há garantia. Quando em dúvida, use ISO 8601.

## Limitações conhecidas

- Como o cálculo é por linha em JS escalar, datasets muito grandes (> 1 milhão de amostras) podem travar a aba alguns segundos. A barra de progresso continua animada porque o `processSamples` cede o thread periodicamente — mas a aba fica não-responsiva entre yields.
- O navegador precisa de internet no primeiro acesso para baixar Plotly (~3 MB) e PapaParse (~50 KB). Em uso offline, vendore as duas bibliotecas localmente e ajuste os `<script src=>` no HTML.
- A página não persiste configurações entre recargas. Se isso for útil, dá para adicionar `localStorage` em uma versão futura.

## Equivalência com o pipeline Python

| Recurso | Python | Web |
|---|---|---|
| SPA (Reda & Andreas) | ✓ | ✓ |
| Marion-Dobos | ✓ | ✓ |
| Backtracking flat-ground | ✓ | ✓ |
| Máscara de amostras noturnas | ✓ | ✓ |
| Self-test | `--self-test` | botão "Rodar auto-teste" |
| CSV de resultados | ✓ | ✓ |
| Excel (.xlsx) com abas | ✓ | — (CSV apenas) |
| EOT / sunrise / sunset | ✓ (com `SPA_ALL`) | — (não implementado, não é usado pelo pipeline de tracker) |
| Gráficos | matplotlib (estáticos) | Plotly (zoom, hover, exportar PNG) |
