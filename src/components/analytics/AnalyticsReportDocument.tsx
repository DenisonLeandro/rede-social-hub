/**
 * Documento visual do relatório de Analytics + Insights IA.
 *
 * Renderizado fora da tela (largura fixa A4 @96dpi = 794px) e capturado com
 * html2canvas para gerar o PDF. Usa estilos inline (sem tokens CSS) para que a
 * captura fique idêntica independentemente do tema claro/escuro do app.
 */

export interface ReportProfile {
  platform: string;
  username: string;
  displayName?: string;
  followers?: number | null;
  following?: number | null;
  posts?: number | null;
  engagementRate?: number | null;
  avgLikes?: number | null;
  avgComments?: number | null;
  avgViews?: number | null;
  followersSource?: "followers" | "page_likes";
  recentPosts?: Array<{
    text?: string;
    likes?: number;
    comments?: number;
    views?: number;
    date?: string;
    url?: string;
  }>;
}

export interface ReportInsights {
  general?: {
    resumoExecutivo?: string;
    scoreGeral?: number;
    melhorPlataforma?: { nome?: string; motivo?: string };
    piorPlataforma?: { nome?: string; motivo?: string };
    melhorDiaParaPostar?: { dia?: string; motivo?: string };
    melhorHorario?: { horario?: string; motivo?: string };
    analiseEngajamento?: { status?: string; detalhes?: string; comparacaoSetor?: string };
    topInsights?: Array<{ titulo?: string; descricao?: string; prioridade?: string; categoria?: string }>;
    planoAcao?: Array<{ acao?: string; plataforma?: string; impactoEsperado?: string; prazo?: string }>;
    oportunidades?: string[];
    riscos?: string[];
  } | null;
  platforms?: Record<string, {
    score?: number;
    status?: string;
    resumo?: string;
    pontoForte?: string;
    pontoFraco?: string;
    acoes?: string[];
    frequenciaIdeal?: string;
    tipoConteudoRecomendado?: string;
    benchmarkSetor?: string;
  }> | null;
  computed?: {
    bestDays?: Array<{ day: string; avgEng: number; posts: number }>;
    bestHours?: Array<{ hour: string; avgEng: number; posts: number }>;
    totalFollowers?: number;
    avgEngagement?: string;
    totalPosts?: number;
  } | null;
}

export interface ReportData {
  companyName: string;
  generatedAt: Date;
  profiles: ReportProfile[];
  insights: ReportInsights;
  /** Última resposta da IA às perguntas personalizadas da página Insights. */
  aiAnswer?: string;
}

const C = {
  text: "#12121a",
  muted: "#6b7280",
  border: "#e5e7eb",
  violet: "#7c3aed",
  pink: "#db2777",
  orange: "#ea580c",
  green: "#16a34a",
  blue: "#2563eb",
  bg: "#ffffff",
  soft: "#f8f7ff",
};

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok",
  youtube: "YouTube", linkedin: "LinkedIn", twitter: "X (Twitter)",
  x: "X (Twitter)", threads: "Threads", pinterest: "Pinterest", bluesky: "Bluesky",
};

const label = (p: string) => PLATFORM_LABEL[p] ?? (p.charAt(0).toUpperCase() + p.slice(1));

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

/** Extrai o handle legível a partir de um username ou URL de perfil. */
function handle(value: string): string {
  const raw = (value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(raw)) return raw.replace(/^@/, "");
  const parts = raw.split("?")[0].split("/").filter(Boolean);
  return (parts.find((p) => p.startsWith("@")) || parts[parts.length - 1] || raw).replace(/^@/, "");
}


/** Score de completude para escolher o melhor snapshot quando há duplicatas. */
function richness(p: ReportProfile): number {
  return (p.followers ?? 0) + (p.posts ?? 0) * 10 + (p.recentPosts?.length ?? 0) * 100 +
    (p.engagementRate ? 1000 : 0);
}

function dedupeProfiles(profiles: ReportProfile[]): ReportProfile[] {
  const byPlatform = new Map<string, ReportProfile>();
  for (const p of profiles) {
    const cur = byPlatform.get(p.platform);
    if (!cur || richness(p) > richness(cur)) byPlatform.set(p.platform, p);
  }
  return [...byPlatform.values()];
}


function num(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

function Block({ children }: { children: React.ReactNode }) {
  return (
    <div data-report-block="1" style={{ marginBottom: 18 }}>
      {children}
    </div>
  );
}

function SectionTitle({ children, color = C.violet }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <div style={{ width: 4, height: 18, borderRadius: 2, background: color }} />
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: C.text }}>{children}</h2>
    </div>
  );
}

function Card({ children, accent = C.border }: { children: React.ReactNode; accent?: string }) {
  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 10,
      padding: 12,
      background: C.bg,
    }}>
      {children}
    </div>
  );
}

function Kv({ k, v, color = C.text }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 0 }}>
      <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{k}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{v}</div>
    </div>
  );
}

export function AnalyticsReportDocument({ data }: { data: ReportData }) {
  const { companyName, generatedAt, insights, aiAnswer } = data;
  // Dedupe: a mesma plataforma pode ter snapshots com handle e URL; mantém o mais completo.
  const profiles = dedupeProfiles(data.profiles);

  const totalFollowers = profiles.reduce((s, p) => s + (p.followers ?? 0), 0);
  const withRate = profiles.filter((p) => p.engagementRate != null);
  const avgEng = withRate.length
    ? withRate.reduce((s, p) => s + (p.engagementRate ?? 0), 0) / withRate.length
    : null;
  const totalPosts = profiles.reduce((s, p) => s + (p.posts ?? 0), 0);
  const avgLikes = profiles.reduce((s, p) => s + (p.avgLikes ?? 0), 0);
  const g = insights.general;

  return (
    <div
      style={{
        width: 794,
        padding: "36px 40px",
        boxSizing: "border-box",
        background: C.bg,
        color: C.text,
        fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {/* Capa */}
      <Block>
        <div style={{
          borderRadius: 14,
          padding: 22,
          background: `linear-gradient(135deg, ${C.violet}, ${C.pink})`,
          color: "#ffffff",
        }}>
          <div style={{ fontSize: 11, opacity: 0.85, letterSpacing: 1, textTransform: "uppercase" }}>
            Relatório de Redes Sociais
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{companyName || "Minha empresa"}</div>
          <div style={{ fontSize: 11, opacity: 0.9, marginTop: 8 }}>
            Gerado em {generatedAt.toLocaleDateString("pt-BR")} às {generatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </div>
          <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>
            Plataformas: {profiles.length ? profiles.map((p) => label(p.platform)).join(" · ") : "—"}
          </div>
        </div>
      </Block>

      {/* Visão geral */}
      <Block>
        <SectionTitle>Visão Geral</SectionTitle>
        <div style={{ display: "flex", gap: 10 }}>
          {[
            { k: "Seguidores", v: num(totalFollowers), c: C.violet },
            { k: "Engajamento médio", v: avgEng != null ? `${avgEng.toFixed(2)}%` : "—", c: C.pink },
            { k: "Posts publicados", v: num(totalPosts), c: C.orange },
            { k: "Média de likes", v: num(avgLikes), c: C.green },
          ].map((m) => (
            <div key={m.k} style={{
              flex: 1, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, background: C.soft,
            }}>
              <Kv k={m.k} v={m.v} color={m.c} />
            </div>
          ))}
        </div>
      </Block>

      {/* Diagnóstico IA — resumo */}
      {g && (
        <Block>
          <SectionTitle>Diagnóstico IA — Visão Geral</SectionTitle>
          <Card accent={C.violet}>
            {g.scoreGeral != null && (
              <div style={{ fontSize: 12, fontWeight: 700, color: C.violet, marginBottom: 6 }}>
                Score geral: {g.scoreGeral}/100
              </div>
            )}
            <div style={{ whiteSpace: "pre-wrap" }}>{g.resumoExecutivo}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              {g.melhorPlataforma?.nome && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>Melhor plataforma</div>
                  <div style={{ fontWeight: 700, color: C.green }}>{g.melhorPlataforma.nome}</div>
                  <div style={{ color: C.muted }}>{g.melhorPlataforma.motivo}</div>
                </div>
              )}
              {g.piorPlataforma?.nome && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>Precisa de atenção</div>
                  <div style={{ fontWeight: 700, color: C.orange }}>{g.piorPlataforma.nome}</div>
                  <div style={{ color: C.muted }}>{g.piorPlataforma.motivo}</div>
                </div>
              )}
            </div>
            {g.analiseEngajamento && (
              <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>
                  Engajamento — {g.analiseEngajamento.status}
                </div>
                <div>{g.analiseEngajamento.detalhes}</div>
                {g.analiseEngajamento.comparacaoSetor && (
                  <div style={{ color: C.muted, marginTop: 4 }}>{g.analiseEngajamento.comparacaoSetor}</div>
                )}
              </div>
            )}
          </Card>
        </Block>
      )}

      {/* Timing */}
      {(g?.melhorDiaParaPostar || g?.melhorHorario || insights.computed) && (
        <Block>
          <SectionTitle color={C.blue}>Melhores Momentos para Publicar</SectionTitle>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Card accent={C.blue}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>Melhor dia</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.blue }}>
                  {g?.melhorDiaParaPostar?.dia || insights.computed?.bestDays?.[0]?.day || "—"}
                </div>
                {g?.melhorDiaParaPostar?.motivo && (
                  <div style={{ color: C.muted, marginTop: 2 }}>{g.melhorDiaParaPostar.motivo}</div>
                )}
                {insights.computed?.bestDays?.slice(0, 5).map((d, i) => (
                  <div key={d.day} style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span>#{i + 1} {d.day}</span>
                    <span style={{ color: C.muted }}>{Math.round(d.avgEng)} eng · {d.posts} posts</span>
                  </div>
                ))}
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card accent={C.orange}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>Melhor horário</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.orange }}>
                  {g?.melhorHorario?.horario || insights.computed?.bestHours?.[0]?.hour || "—"}
                </div>
                {g?.melhorHorario?.motivo && (
                  <div style={{ color: C.muted, marginTop: 2 }}>{g.melhorHorario.motivo}</div>
                )}
                {insights.computed?.bestHours?.slice(0, 5).map((h, i) => (
                  <div key={h.hour} style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span>#{i + 1} {h.hour}</span>
                    <span style={{ color: C.muted }}>{Math.round(h.avgEng)} eng · {h.posts} posts</span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </Block>
      )}

      {/* Métricas por plataforma */}
      <Block>
        <SectionTitle color={C.pink}>Métricas por Plataforma</SectionTitle>
      </Block>
      {profiles.map((p) => {
        const pi = insights.platforms?.[p.platform];
        const followersLabel = p.followersSource === "page_likes" ? "Curtidas da página" : "Seguidores";
        const posts = (p.recentPosts ?? []).slice(0, 3);
        return (
          <Block key={`${p.platform}:${p.username}`}>
            <Card accent={C.pink}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{label(p.platform)}</div>
                <div style={{ color: C.muted }}>@{handle(p.username)}</div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <Kv k={followersLabel} v={num(p.followers)} color={C.violet} />
                <Kv k="Engajamento" v={p.engagementRate != null ? `${p.engagementRate.toFixed(2)}%` : "—"} color={C.pink} />
                <Kv k="Média likes" v={num(p.avgLikes)} color={C.green} />
                <Kv k="Média coment." v={num(p.avgComments)} color={C.blue} />
                <Kv k="Média views" v={num(p.avgViews)} color={C.orange} />
                <Kv k="Posts" v={num(p.posts)} />
              </div>

              {pi && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.violet }}>
                    Diagnóstico IA {pi.score != null ? `· ${pi.score}/100` : ""} {pi.status ? `· ${pi.status}` : ""}
                  </div>
                  {pi.resumo && <div style={{ marginTop: 4 }}>{pi.resumo}</div>}
                  {pi.pontoForte && <div style={{ marginTop: 4, color: C.green }}>✓ {pi.pontoForte}</div>}
                  {pi.pontoFraco && <div style={{ marginTop: 2, color: C.orange }}>! {pi.pontoFraco}</div>}
                  {!!pi.acoes?.length && (
                    <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                      {pi.acoes.map((a, i) => <li key={i} style={{ marginTop: 2 }}>{a}</li>)}
                    </ul>
                  )}
                  <div style={{ color: C.muted, marginTop: 6 }}>
                    {pi.frequenciaIdeal ? `Frequência ideal: ${pi.frequenciaIdeal}. ` : ""}
                    {pi.tipoConteudoRecomendado ? `Conteúdo recomendado: ${pi.tipoConteudoRecomendado}. ` : ""}
                    {pi.benchmarkSetor || ""}
                  </div>
                </div>
              )}

              {!!posts.length && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", marginBottom: 4 }}>
                    Posts recentes
                  </div>
                  {posts.map((post, i) => (
                    <div key={i} style={{ marginTop: 6 }}>
                      <div>
                        {truncate(post.text || "(sem legenda)", 170)}
                      </div>

                      <div style={{ color: C.muted, fontSize: 10 }}>
                        {post.date ? new Date(post.date).toLocaleDateString("pt-BR") : "—"} ·{" "}
                        {num(post.likes)} likes · {num(post.comments)} comentários
                        {post.views ? ` · ${num(post.views)} views` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </Block>
        );
      })}

      {/* Plano de ação */}
      {!!g?.planoAcao?.length && (
        <>
          <Block>
            <SectionTitle color={C.green}>Plano de Ação</SectionTitle>
          </Block>
          {g.planoAcao.map((a, i) => (
            <Block key={i}>
              <Card accent={C.green}>
                <div style={{ fontWeight: 700 }}>{i + 1}. {a.acao}</div>
                <div style={{ color: C.muted, marginTop: 3 }}>
                  {a.plataforma ? `${label(a.plataforma)} · ` : ""}{a.prazo || ""}
                </div>
                {a.impactoEsperado && <div style={{ marginTop: 3 }}>Impacto esperado: {a.impactoEsperado}</div>}
              </Card>
            </Block>
          ))}
        </>
      )}

      {/* Top insights */}
      {!!g?.topInsights?.length && (
        <>
          <Block>
            <SectionTitle color={C.violet}>Principais Insights</SectionTitle>
          </Block>
          {g.topInsights.map((t, i) => (
            <Block key={i}>
              <Card accent={C.violet}>
                <div style={{ fontWeight: 700 }}>{t.titulo}</div>
                <div style={{ color: C.muted, fontSize: 10 }}>
                  {[t.categoria, t.prioridade ? `prioridade ${t.prioridade}` : ""].filter(Boolean).join(" · ")}
                </div>
                <div style={{ marginTop: 4 }}>{t.descricao}</div>
              </Card>
            </Block>
          ))}
        </>
      )}

      {/* Oportunidades e riscos */}
      {(!!g?.oportunidades?.length || !!g?.riscos?.length) && (
        <Block>
          <SectionTitle color={C.orange}>Oportunidades e Riscos</SectionTitle>
          <div style={{ display: "flex", gap: 10 }}>
            {!!g?.oportunidades?.length && (
              <div style={{ flex: 1 }}>
                <Card accent={C.green}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>Oportunidades</div>
                  <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                    {g.oportunidades.map((o, i) => <li key={i} style={{ marginTop: 3 }}>{o}</li>)}
                  </ul>
                </Card>
              </div>
            )}
            {!!g?.riscos?.length && (
              <div style={{ flex: 1 }}>
                <Card accent={C.orange}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>Riscos</div>
                  <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                    {g.riscos.map((r, i) => <li key={i} style={{ marginTop: 3 }}>{r}</li>)}
                  </ul>
                </Card>
              </div>
            )}
          </div>
        </Block>
      )}

      {/* Resposta da IA (perguntas personalizadas) */}
      {aiAnswer && (
        <Block>
          <SectionTitle color={C.blue}>Análise Personalizada da IA</SectionTitle>
          <Card accent={C.blue}>
            <div style={{ whiteSpace: "pre-wrap" }}>{aiAnswer}</div>
          </Card>
        </Block>
      )}

      <Block>
        <div style={{ textAlign: "center", color: C.muted, fontSize: 9, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          Relatório gerado automaticamente a partir dos dados reais coletados das redes sociais.
        </div>
      </Block>
    </div>
  );
}

export default AnalyticsReportDocument;
