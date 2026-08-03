import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUser } from "../_shared/auth.ts";
import { logGatewayChat } from "../_shared/usage-log.ts";

/**
 * Autopilot Parse — cola → grade estruturada.
 *
 * Recebe o plano de conteúdo colado em QUALQUER formato (tabela, lista, texto
 * corrido) e devolve linhas { date, theme, category }. Síncrono: o usuário cola
 * e vê a grade em segundos. A pessoa revisa/edita a grade antes de gerar.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Row {
  date: string | null; // YYYY-MM-DD ou null
  theme: string;
  category: string | null;
}

const SYSTEM = `Você extrai um plano de conteúdo de redes sociais de um texto colado (pode vir como tabela, lista, ou texto corrido, bagunçado, copiado de ChatGPT/Excel/Word).

HOJE É {{TODAY}}. Quando o texto não trouxer o ano, use o ano que faz a data cair em HOJE ou no futuro — nunca no passado.

Para CADA post identificado, produza:
- "date": a data no formato "YYYY-MM-DD". Interprete datas em português (dd/mm/aaaa é dia/mês/ano). Se a linha não tiver data, use null.
- "theme": o tema/assunto do post (obrigatório, string curta).
- "category": a categoria, se houver; senão null.

Regras:
- Preserve a ORDEM original das linhas.
- NÃO invente posts que não estão no texto. NÃO complete datas que faltam.
- Ignore cabeçalhos de tabela ("Data", "Tema", "Categoria", "Dia da Semana") — não são posts.
- Responda APENAS JSON válido, sem markdown: {"rows":[{"date":"YYYY-MM-DD"|null,"theme":"...","category":"..."|null}]}`;

/** Corrige datas que caíram em um ano passado (LLM chuta o ano errado). */
function normalizeYear(date: string | null): string | null {
  if (!date) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) return date;
  const [y, rest] = [Number(date.slice(0, 4)), date.slice(4)];
  const currentYear = new Date().getUTCFullYear();
  if (y >= currentYear) return date; // passado recente do ano corrente: mantém
  const shifted = `${currentYear}${rest}`;
  return shifted >= today ? shifted : `${currentYear + 1}${rest}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await requireUser(req, corsHeaders);
  if (auth instanceof Response) return auth;

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text || !text.trim()) return json({ error: "Cole o plano de conteúdo." }, 400);

    const lovableKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableKey) return json({ error: "LOVABLE_API_KEY não configurada." }, 500);

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text.slice(0, 20000) },
        ],
        temperature: 0.1,
        max_tokens: 8192,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 429) return json({ error: "Limite de uso da IA atingido. Tente novamente em instantes." }, 429);
      if (resp.status === 402) return json({ error: "Créditos de IA esgotados." }, 402);
      return json({ error: `IA ${resp.status}: ${errText.slice(0, 200)}` }, 502);
    }

    const data = await resp.json();
    await logGatewayChat(data, { feature: "autopilot_parse", model: "google/gemini-3-flash-preview", userId: auth.user.id });
    const raw = (data.choices?.[0]?.message?.content || "")
      .replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let rows: Row[] = [];
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.rows;
      if (Array.isArray(list)) {
        rows = list
          .map((r: Record<string, unknown>) => ({
            date: typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
            theme: typeof r.theme === "string" ? r.theme.trim() : "",
            category: typeof r.category === "string" && r.category.trim() ? r.category.trim() : null,
          }))
          .filter((r: Row) => r.theme.length > 0);
      }
    } catch {
      return json({ error: "Não consegui interpretar o plano. Tente colar em um formato mais claro (uma linha por dia)." }, 422);
    }

    if (rows.length === 0) return json({ error: "Nenhum post encontrado no texto colado." }, 422);

    return json({ rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[autopilot-parse] Error:", message);
    return json({ error: message }, 502);
  }
});
