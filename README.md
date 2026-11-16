# FM Drops

App Android simples e 100% local para consultar **onde cada carta dropa** no
*Yu-Gi-Oh! Forbidden Memories* (PS1, versão USA `SLUS-01411`), incluindo mods.

- Grade com a foto de todas as 722 cartas; toque em uma para ver quais duelistas
  dropam, em qual rank (S/A POW, B/C/D, S/A TEC) e a chance.
- Lista de duelistas com tudo que cada um dropa.
- Fusões: quais pares geram a carta e o que ela gera com outras.
- ⚙ → **Procurar atualização** baixa o APK mais novo da release.
- Sem servidor, sem banco, sem internet.

## Como os dados entram

O repositório **não contém nada do jogo** (nem fotos, nem tabelas). Na primeira
abertura o app pede a imagem do jogo (`.bin` ou `.iso`) e lê tudo direto dela:
nomes, atributos, artes das cartas e tabelas de drop. Os dados ficam guardados
só no aparelho.

Por isso ele funciona com **qualquer mod** que mantenha o formato original: os
drops mostrados são sempre os da imagem que você importou.

## Instalar

1. Baixe `fmdrops.apk` em **Releases → FM Drops (último build)**.
2. Abra o arquivo no celular e permita instalar de fonte desconhecida.
3. Extraia o `.7z`/`.zip` do jogo (ex.: com o ZArchiver) para ter o `.bin`.
4. Abra o app → **Escolher arquivo** → selecione o `.bin`.

Em ⚙ dá para informar quantas cartas o seu mod dropa por duelo; o app passa a
mostrar a chance de a carta sair pelo menos uma vez no duelo.

## Atualizar os drops (mod novo ou alterado)

⚙ → **Importar outra imagem / mod** e escolha o `.bin` novo. Não precisa de APK novo.

## Estrutura

| Pasta | O que é |
|---|---|
| `web/` | O app (HTML/CSS/JS puro). `fm.js` é o leitor dos arquivos do jogo. |
| `android/` | Casca Android mínima (uma WebView) que empacota `web/` no APK. |
| `tools/extract.js` | Mesma leitura pela linha de comando: `node tools/extract.js jogo.bin drops.json` |
| `tools/make-fixture.js` | Gera uma imagem de CD falsa (sem conteúdo do jogo) para testes. |
| `.github/workflows/apk.yml` | Compila o APK a cada push e publica na release `latest`. |

Para testar no computador: abra `web/index.html` no navegador.

## Formato lido

Offsets da versão USA, conforme o projeto aberto
[fmlib-cpp](https://github.com/forbidden-memories-coding/fmlib-cpp):

| Dado | Arquivo | Offset |
|---|---|---|
| ATK/DEF/tipo | `SLUS_014.11` | `0x1C4A44` (4 bytes por carta) |
| Nível | `SLUS_014.11` | `0x1C5B33` |
| Nomes de cartas / duelistas | `SLUS_014.11` | ponteiros em `0x1C6002` / `0x1C6652` |
| Artes (102×96, 8 bits + paleta) | `WA_MRG.MRG` | `0x169000` + `0x3800` por carta |
| Deck e drops de cada duelista | `WA_MRG.MRG` | `0xE9B000` + `0x1800` por duelista (`+0x5B4` POW, `+0xB68` BCD, `+0x111C` TEC) |
| Custo em estrelas / senha | `WA_MRG.MRG` | `0xFB9808` |
| Fusões | `WA_MRG.MRG` | `0xB87800` (`0x10000` bytes) |

As chances são em 2048 avos por tabela.

## Aviso

Projeto de fã, sem vínculo com a Konami. Use com a sua própria cópia do jogo.
