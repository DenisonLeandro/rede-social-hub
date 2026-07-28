## Objetivo

Um botão "Baixar PDF" que gera **um relatório único** em PDF, com aparência de print dos cards (fiel ao design do app), reunindo: métricas por plataforma, o diagnóstico IA do Analytics (todas as abas) e os insights da página Insights.

## Como vai funcionar

1. Botão **"Baixar PDF"** no topo das páginas **Analytics** e **Insights** (mesmo relatório completo nos dois lugares).
2. Ao clicar, o app monta fora da tela um "documento de relatório" em A4 com:
   - Capa: nome da empresa, data/hora da coleta, plataformas incluídas.
   - Visão geral: seguidores totais, engajamento médio, likes/comentários médios.
   - Um bloco por plataforma com as métricas e top posts.
   - Diagnóstico IA do Analytics: conteúdo das 4 abas (Geral, Plataformas, Ações, Timing) renderizado por completo, sem precisar clicar em cada aba.
   - Insights calculados (melhor dia, melhor horário, melhor plataforma, melhor tipo de conteúdo) e, se houver, a última resposta da IA às perguntas personalizadas.
3. Esse documento é capturado com `html2canvas` e paginado em A4 no PDF, quebrando as páginas entre blocos (sem cortar card no meio).
4. Nome do arquivo: `analytics-<empresa>-<data>.pdf`. Toast de progresso ("Gerando PDF…") e de erro.

## Detalhes técnicos

- Adicionar dependência `jspdf` (o `html2canvas` já está no projeto).
- Novo componente `src/components/analytics/AnalyticsReportDocument.tsx`: recebe snapshots/analytics + resultado da IA e renderiza o layout do relatório (largura fixa 794px = A4 a 96dpi), fora do viewport.
- Novo utilitário `src/lib/analytics-report.ts`: função `downloadAnalyticsReportPdf(node, filename)` que faz html2canvas (scale 2, `backgroundColor` do tema claro) e monta as páginas no jsPDF.
- Para o diagnóstico IA das abas: reaproveitar os mesmos dados já em estado na página Analytics (resultado de `analytics-insights`, modos geral e per-platform), renderizando todas as seções empilhadas no documento do relatório.
- Na página Insights, o relatório busca os mesmos dados: `analytics_snapshots` (já carregados) + chamada a `analytics-insights` caso ainda não haja diagnóstico em cache, com estado de loading no botão.
- Nada da lógica de coleta, cálculo ou das telas atuais é alterado — apenas leitura dos dados existentes e um botão novo.

## Fora de escopo

- Não muda coleta Apify, edge functions, nem os cálculos de métricas.
- Sem envio por e-mail ou agendamento de relatório.
