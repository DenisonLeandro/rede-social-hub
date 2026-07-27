## O problema (confirmado no log da coleta real)

Na última coleta da sua página (`facebook.com/denisonleandro.adv`), a função `social-analytics` registrou:

```text
[social-analytics][facebook] normalized
  followers: 1434
  pageLikes: 1434
  postsFound: 0
```

Três consequências, exatamente as que você vê na tela:

1. **Nenhum post é coletado.** O actor usado hoje (`apify~facebook-pages-scraper`) devolve só os dados da página (título, curtidas, categorias, telefone…) — nenhuma publicação. Por isso a lista de posts fica vazia.
2. **Likes/comentários/engajamento ficam zerados ou nulos**, porque são calculados a partir dessa lista de posts que veio vazia.
3. **"Seguidores" está mostrando curtidas.** O actor não devolveu `followers`, então o código cai no fallback `pageLikes` (1.434). Não dá para saber se está certo sem o dado real.

Existe hoje um coletor de posts do Facebook (`apify~facebook-reels-scraper`), mas ele só roda quando o modo "enriquecer" está ligado — e mesmo assim traz apenas Reels, não as publicações do feed.

## O que vou fazer

### 1. Confirmar o formato real dos dados antes de codar
Rodar uma chamada única ao Apify com o actor de posts do Facebook para a sua página e inspecionar o JSON retornado (nomes exatos dos campos de likes, comentários, compartilhamentos, data, URL). Só depois escrevo o mapeamento — sem chutar nomes de campo.

### 2. Passar a coletar as publicações do feed sempre
No `social-analytics`, o Facebook passa a rodar **duas coletas**: a da página (seguidores/curtidas/nome/foto, como já é) **+** uma de publicações do feed, sempre — não só no modo enriquecer. As publicações alimentam:
- a lista de posts recentes,
- média de likes, comentários e visualizações,
- a taxa de engajamento,
- a contagem de posts.

### 3. Separar "seguidores" de "curtidas"
Parar de exibir curtidas silenciosamente como seguidores. Quando o actor não devolver seguidores, a tela mostra o número com a indicação de que é curtidas da página, em vez de um dado que parece errado.

### 4. Não sobrescrever dados bons com coleta vazia
Se a coleta de publicações voltar vazia (página sem posts públicos, bloqueio do Facebook), manter os últimos valores válidos e registrar o motivo em log/erro visível, em vez de zerar tudo.

### 5. Validar de ponta a ponta
Rodar a coleta real da sua página depois do deploy e conferir nos logs que `postsFound > 0` e que likes/comentários batem com o que aparece na página.

## Detalhes técnicos

- Arquivo principal: `supabase/functions/social-analytics/index.ts` — bloco `PLATFORMS.facebook` (linhas ~670-759) e o loop da Fase 1 (linhas ~1507-1587).
- A coleta de posts vira uma etapa secundária do Facebook, no mesmo padrão do fallback já existente para YouTube/TikTok (`fallbackProfile`), reaproveitando `uniquePosts`, `looksLikeFacebookPost` e `nestedMetricNum`.
- Frontend (`src/pages/Analytics.tsx`) só muda no rótulo de seguidores/curtidas quando o dado for curtidas — nenhuma mudança de layout ou de fluxo.
- Nenhuma outra plataforma é tocada.

## O que não muda
Instagram, YouTube, TikTok, LinkedIn e X continuam exatamente como estão. Nenhuma alteração de UI além do rótulo citado.
