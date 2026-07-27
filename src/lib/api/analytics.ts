/**
 * Social analytics via the social-analytics Edge Function (Apify-backed),
 * plus the helpers that build account lists and validate the Apify token.
 */

import { getSupabaseUrl, baseHeaders } from "./_shared";
import { supabase } from "@/integrations/supabase/client";

// ─── Profile URLs (per-company, stored in company_configs.profile_urls) ────

export async function getCompanyProfileUrls(companyId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.rpc("get_company_profile_urls" as never, {
    _company_id: companyId,
  } as never);
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, string>;
}

export async function setCompanyProfileUrls(
  companyId: string,
  patch: Record<string, string | null>
): Promise<Record<string, string>> {
  const { data, error } = await supabase.rpc("set_company_profile_urls" as never, {
    _company_id: companyId,
    _patch: patch,
  } as never);
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, string>;
}

/** Plataformas cujo scraper Apify EXIGE URL pública (não basta o handle do PFM). */
export const PLATFORMS_REQUIRING_URL = new Set([
  "facebook", "linkedin", "youtube", "tiktok",
]);

// TODO: no futuro, passar companyId explicitamente em cada chamada (em vez
// do setter de módulo) para evitar acoplamento global ao CompanyContext.
let _activeCompanyId: string | null = null;

export function setApifyActiveCompany(companyId: string | null) {
  _activeCompanyId = companyId;
}

export function getApifyActiveCompany(): string | null {
  return _activeCompanyId;
}

// ─── Social Analytics (Apify) ───────────────────────────────────

export interface EnrichmentComment {
  author: string;
  text: string;
  likes: number;
  date: string;
}

export interface EnrichmentMention {
  username: string;
  text: string;
  likes: number;
  comments: number;
  date: string;
  url: string;
  mediaUrl: string;
}

export interface EnrichmentTranscript {
  videoUrl: string;
  title: string;
  text: string;
}

export interface EnrichmentPost {
  text: string;
  likes: number;
  comments: number;
  shares: number;
  date: string;
  url: string;
}

export interface EnrichmentReel {
  text: string;
  likes: number;
  comments: number;
  shares: number;
  views: number;
  date: string;
  url: string;
}

export interface EnrichmentData {
  comments?: EnrichmentComment[];
  mentions?: EnrichmentMention[];
  transcripts?: EnrichmentTranscript[];
  companyPosts?: EnrichmentPost[];
  reels?: EnrichmentReel[];
  brandMentions?: EnrichmentPost[];
}

export interface ProfileAnalytics {
  platform: string;
  username: string;
  displayName: string;
  profileImageUrl: string;
  followers: number;
  following: number;
  posts: number;
  engagementRate: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  avgViews: number | null;
  recentPosts: {
    text: string;
    likes: number;
    comments: number;
    views: number;
    date: string;
    url: string;
    mediaUrl: string;
  }[];
  enrichment?: EnrichmentData;
  /** "page_likes" quando o número em `followers` é, na verdade, curtidas da página (Facebook). */
  followersSource?: "followers" | "page_likes";
  fetchedAt: string;

}

export interface AnalyticsResult {
  results: ProfileAnalytics[];
  errors: { platform: string; username: string; error: string }[];
  fetchedAt: string;
}

/**
 * Build analytics account list from PFM accounts + saved profile URLs.
 * YouTube, LinkedIn e Facebook: pass full URL (edge function handles parsing).
 * Outras plataformas: extraem username/handle da URL, ou usam o handle do PFM.
 *
 * Também retorna `missingUrl`: plataformas conectadas cujo scraper Apify
 * requer URL pública (facebook/linkedin/youtube/tiktok) mas ainda não foi
 * salva em company_configs.profile_urls — essas contas não são incluídas
 * na lista final para evitar chamadas ao Apify que voltariam com 0.
 */
export interface BuildAnalyticsResult {
  accounts: { platform: string; username: string }[];
  missingUrl: string[]; // plataformas sem URL salva mas conectadas
}

export function buildAnalyticsAccounts(
  pfmAccounts: { platform: string; username: string }[],
  profileUrls: Record<string, string>
): BuildAnalyticsResult {
  const cleanProfileValue = (value: string, platform: string) => {
    const raw = (value || "").trim();
    if (!raw) return "";
    const withoutQuery = raw.split("?")[0].split("#")[0].replace(/\/+$/, "");
    if (/^https?:\/\//i.test(withoutQuery) || /^[\w.-]+\.[a-z]{2,}\//i.test(withoutQuery)) {
      try {
        const u = new URL(withoutQuery.startsWith("http") ? withoutQuery : `https://${withoutQuery}`);
        const parts = u.pathname.split("/").filter(Boolean);
        if (platform === "youtube") return raw;
        if (platform === "linkedin" || platform === "facebook") return raw;
        const handlePart = parts.find((p) => p.startsWith("@")) || parts[parts.length - 1] || "";
        return handlePart.replace(/^@/, "");
      } catch {
        // fallback below
      }
    }
    const parts = withoutQuery.split("/").filter(Boolean);
    return (parts.find((p) => p.startsWith("@")) || parts[parts.length - 1] || withoutQuery).replace(/^@/, "");
  };

  const missingUrl = new Set<string>();
  const accounts = pfmAccounts
    .map((a) => {
      const savedUrl = (profileUrls[a.platform] || "").trim();
      let username = cleanProfileValue(a.username || "", a.platform);

      if (PLATFORMS_REQUIRING_URL.has(a.platform)) {
        if (!savedUrl) {
          missingUrl.add(a.platform);
          return null;
        }
        // Estas plataformas passam a URL completa quando o actor espera URL,
        // ou extraem o handle quando o actor espera username.
        if (a.platform === "youtube" || a.platform === "linkedin" || a.platform === "facebook") {
          username = savedUrl;
        } else {
          // tiktok: extrai handle da URL
          username = cleanProfileValue(savedUrl, a.platform) || savedUrl;
        }
      } else if (savedUrl) {
        // Plataformas em que o handle basta, mas se o usuário salvou URL, extraímos.
        const cleaned = cleanProfileValue(savedUrl, a.platform);
        if (cleaned) username = cleaned;
      }

      if (!username || username === "YouTube" || username === "Canal YouTube") return null;
      return { platform: a.platform, username };
    })
    .filter(Boolean) as { platform: string; username: string }[];

  return { accounts, missingUrl: [...missingUrl] };
}

export async function fetchAnalytics(
  accounts: { platform: string; username: string }[],
  enrich = false
): Promise<AnalyticsResult> {
  if (!_activeCompanyId) {
    throw new Error("Selecione uma empresa antes de consultar métricas.");
  }
  const url = `${getSupabaseUrl()}/functions/v1/social-analytics`;
  const headers = await baseHeaders();

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ accounts, enrich, companyId: _activeCompanyId }),
  });

  if (!response.ok) {
    let msg: string;
    try {
      const errBody = await response.json();
      msg = errBody.error || `HTTP ${response.status}`;
    } catch {
      msg = `HTTP ${response.status}: ${response.statusText}`;
    }
    throw new Error(msg);
  }

  return response.json();
}

/**
 * Valida APENAS um token recém-digitado por Dono/Admin no Setup.
 * NUNCA usar com token salvo em AppContext/company_configs.
 * TODO: migrar para Edge Function dedicada que só aceite no caminho de validação manual.
 */
export async function validateApifyToken(typedToken: string): Promise<{ valid: boolean; error?: string }> {
  const t = (typedToken || "").trim();
  if (!t) return { valid: false, error: "Token vazio" };
  try {
    const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(t)}`);
    if (res.status === 401) return { valid: false, error: "Token inválido" };
    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Erro de conexão" };
  }
}
