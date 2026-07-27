import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUser } from "../_shared/auth.ts";
import { getCompanyOwnerConfig } from "../_shared/company-secrets.ts";

/**
 * Social Analytics Edge Function — via Apify Actors
 *
 * Verified actor IDs and input schemas (updated 2026-04-02):
 *
 * ── Profile Scrapers ──────────────────────────────────────────────
 * - Instagram:  apify~instagram-profile-scraper    → { usernames: [] }
 * - Twitter/X:  web.harvester~twitter-scraper      → { handles: [], tweetsDesired, includeUserInfo }
 * - TikTok:     apidojo~tiktok-profile-scraper     → { usernames: [], maxItems }
 * - YouTube:    streamers~youtube-channel-scraper   → { startUrls: [{ url }], maxVideos }
 * - Facebook:   apify~facebook-pages-scraper        → { startUrls: [{ url }] }
 * - Threads:    apify~threads-profile-api-scraper   → { usernames: [] }
 * - LinkedIn:   dev_fusion~linkedin-profile-scraper → { profileUrls: [] }
 * - LinkedIn Co: harvestapi~linkedin-company        → { companies: [] }  (auto /company/ URLs)
 * - Pinterest:  apivault_labs~pinterest-scraper      → { profileUrls: [] }
 *
 * ── Enrichment Actors (optional, run when enrich=true) ────────────
 * - YouTube Comments:    streamers~youtube-comments-scraper      → { startUrls, maxComments }
 * - YouTube Transcripts: pintostudio~youtube-transcript-scraper  → { videoUrl, targetLanguage }
 * - TikTok Comments:     apidojo~tiktok-comments-scraper        → { startUrls, maxItems }
 * - Instagram Mentions:  apify~instagram-tagged-scraper          → { username, resultsLimit }
 * - LinkedIn Posts:      harvestapi~linkedin-profile-posts       → { targetUrls, maxPosts }
 * - LinkedIn Brand:      harvestapi~linkedin-post-search         → { searchQueries, maxPosts }
 * - LinkedIn Co. Posts:  harvestapi~linkedin-company-posts       → { targetUrls, maxPosts, scrapeComments }
 * - Facebook Reels:      apify~facebook-reels-scraper            → { startUrls, resultsLimit }
 */

const APIFY_BASE = "https://api.apify.com/v2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Types ──────────────────────────────────────────────────────

interface ActorConfig {
  actorId: string;
  buildInput: (username: string) => Record<string, unknown>;
  normalize: (data: unknown) => ProfileAnalytics;
}

interface EnrichmentData {
  comments?: EnrichmentComment[];
  mentions?: EnrichmentMention[];
  transcripts?: EnrichmentTranscript[];
  companyPosts?: EnrichmentPost[];
  reels?: EnrichmentReel[];
  brandMentions?: EnrichmentPost[];
}

interface EnrichmentComment {
  author: string;
  text: string;
  likes: number;
  date: string;
}

interface EnrichmentMention {
  username: string;
  text: string;
  likes: number;
  comments: number;
  date: string;
  url: string;
  mediaUrl: string;
}

interface EnrichmentTranscript {
  videoUrl: string;
  title: string;
  text: string;
}

interface EnrichmentPost {
  text: string;
  likes: number;
  comments: number;
  shares: number;
  date: string;
  url: string;
}

interface EnrichmentReel {
  text: string;
  likes: number;
  comments: number;
  shares: number;
  views: number;
  date: string;
  url: string;
}

interface ProfileAnalytics {
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
  /** "page_likes" quando o número exibido em `followers` é, na verdade, curtidas da página. */
  followersSource?: "followers" | "page_likes";
  fetchedAt: string;

}

// deno-lint-ignore no-explicit-any
type A = any;

function safeNum(v: A): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return 0;

  const raw = v.trim().toLowerCase();
  if (!raw) return 0;

  const multiplier =
    /[\d.,]\s*(k|mil)\b/.test(raw) ? 1_000 :
    /[\d.,]\s*(m|mi|milhão|milhões|million|millions)\b/.test(raw) ? 1_000_000 :
    /[\d.,]\s*(b|bi|bilhão|bilhões|billion|billions)\b/.test(raw) ? 1_000_000_000 :
    1;

  const numeric = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number.parseFloat(numeric);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : 0;
}

function isObj(v: A): v is Record<string, A> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function firstValue(obj: A, keys: string[]): A {
  if (!isObj(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function firstText(obj: A, keys: string[]): string {
  const value = firstValue(obj, keys);
  if (typeof value === "string") return decodeHtmlText(value);
  if (typeof value === "number") return String(value);
  return "";
}

function firstNum(obj: A, keys: string[]): number {
  return safeNum(firstValue(obj, keys));
}

function nestedNum(obj: A, keys: string[]): number {
  if (!obj) return 0;
  const direct = firstNum(obj, keys);
  if (direct > 0) return direct;
  for (const bucket of ["stats", "statistics", "metrics", "engagement", "counts", "metadata", "about", "profile", "channel", "authorStats", "userStats"]) {
    const value = obj?.[bucket];
    if (isObj(value)) {
      const found = firstNum(value, keys);
      if (found > 0) return found;
    }
  }
  return 0;
}

function collectArraysByKey(raw: A, keys: string[], maxDepth = 5): A[][] {
  const found: A[][] = [];
  const seen = new WeakSet<object>();

  const walk = (node: A, depth: number) => {
    if (!node || depth > maxDepth) return;
    if (typeof node === "object") {
      if (seen.has(node)) return;
      seen.add(node);
    }
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (!isObj(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value) && keys.includes(key)) found.push(value);
      if (isObj(value) || Array.isArray(value)) walk(value, depth + 1);
    }
  };

  walk(raw, 0);
  return found;
}

function collectObjects(raw: A, predicate: (obj: A) => boolean, maxDepth = 5): A[] {
  const found: A[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: A, depth: number) => {
    if (!node || depth > maxDepth) return;
    if (typeof node === "object") {
      if (seen.has(node)) return;
      seen.add(node);
    }
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (!isObj(node)) return;
    if (predicate(node)) found.push(node);
    Object.values(node).forEach((value) => {
      if (isObj(value) || Array.isArray(value)) walk(value, depth + 1);
    });
  };

  walk(raw, 0);
  return found;
}

function uniquePosts(posts: A[]): A[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    if (!isObj(post)) return false;
    const textKey = firstText(post, ["title", "text", "message", "desc", "caption"]).slice(0, 120);
    const dateKey = firstText(post, ["date", "timestamp", "publishedAt", "postCreatedAt", "createTime"]);
    const keys = [
      firstText(post, ["url", "postUrl", "videoUrl", "webVideoUrl", "shortCode", "awemeId"]),
      firstText(post, ["id", "post_id", "postId"]),
      textKey ? `${textKey}:${dateKey}` : "",
      textKey ? `text:${textKey}` : "",
    ].filter(Boolean);
    if (!keys.length || keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  });
}

function metricValue(value: A): number {
  if (Array.isArray(value)) return value.length;
  const direct = safeNum(value);
  if (direct > 0) return direct;
  if (!isObj(value)) return 0;
  const counted = firstNum(value, ["count", "totalCount", "total", "value"]);
  if (counted > 0) return counted;
  if (Array.isArray(value.items)) return value.items.length;
  const numericChildren = Object.values(value).filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return numericChildren.length ? numericChildren.reduce((sum, item) => sum + item, 0) : 0;
}

function nestedMetricNum(obj: A, keys: string[]): number {
  if (!obj) return 0;
  const direct = metricValue(firstValue(obj, keys));
  if (direct > 0) return direct;
  for (const bucket of ["stats", "statistics", "metrics", "engagement", "counts", "metadata", "comments", "reactions"]) {
    const value = obj?.[bucket];
    if (isObj(value)) {
      const found = metricValue(firstValue(value, keys));
      if (found > 0) return found;
    }
  }
  return 0;
}

function hasEngagement(post: A): boolean {
  return nestedNum(post, [
    "likes", "likeCount", "likesCount", "diggCount", "reactions", "reactionCount", "reactionsCount",
    "reactions_count", "comments", "commentCount", "commentsCount", "comments_count", "replyCount",
    "shares", "shareCount", "sharesCount", "reshare_count", "views", "viewCount", "playCount",
  ]) > 0;
}

function cleanUrl(value: string): string {
  return stripQueryHash(value || "").replace(/\/$/, "").toLowerCase();
}

function objectUrl(obj: A): string {
  return firstText(obj, ["postUrl", "url", "permalinkUrl", "link", "videoUrl", "watchUrl", "webVideoUrl", "shareUrl", "tweetUrl"]) ||
    firstText(obj?.post, ["url", "postUrl", "permalinkUrl", "link"]);
}

function hasAnyText(obj: A, keys: string[]): boolean {
  return Boolean(firstText(obj, keys).trim());
}

function hasAnyDate(obj: A): boolean {
  return Boolean(firstText(obj, ["date", "timestamp", "postedAt", "createdAt", "created_at", "publishedAt", "uploadDate", "time", "createTimeISO"]));
}

function looksLikeFacebookPost(obj: A, pageUrl = ""): boolean {
  if (!isObj(obj)) return false;
  if (obj.recordType === "page_summary") return false;
  const url = objectUrl(obj);
  const sameAsPage = pageUrl && url && cleanUrl(url) === cleanUrl(pageUrl);
  const postUrl = /facebook\.com\/.+\/(posts|videos|reel|reels|photos)\b|story_fbid=|fbid=|permalink\.php/i.test(url);
  const hasNestedContent = hasAnyText(obj?.content, ["text", "message", "caption", "description"]);
  const hasPostId = Boolean(firstText(obj, ["post_id", "postId", "postID", "id"]) || firstText(obj?.post, ["id"])) &&
    (obj.recordType === "post" || obj.recordType === "facebook_post" || hasEngagement(obj));
  const profileOnly = Boolean(
    obj.pageName || obj.pageUrl || obj.profileUrl || obj.personalProfile || obj.about || obj.pageInfo ||
    obj.followers || obj.followersCount || obj.followerCount || obj.fans || obj.fanCount
  ) && !postUrl && !hasAnyDate(obj) && !hasAnyText(obj, ["text", "message", "postText", "description", "caption"]);
  if (sameAsPage || profileOnly) return false;
  return Boolean(postUrl || hasPostId || hasAnyText(obj, ["text", "message", "postText", "description", "caption", "content"]) || hasNestedContent || hasAnyDate(obj));
}

function looksLikeYouTubeVideo(obj: A): boolean {
  if (!isObj(obj)) return false;
  const url = objectUrl(obj);
  const videoUrl = /youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\//i.test(url);
  const hasVideoId = Boolean(obj.videoId || obj.id && (videoUrl || hasAnyText(obj, ["title", "name"])));
  const channelOnly = Boolean(
    obj.channelName || obj.channelTitle || obj.channelId || obj.subscriberCount || obj.subscribers || obj.channel
  ) && !videoUrl && !hasVideoId;
  if (channelOnly) return false;
  return Boolean((videoUrl || hasVideoId) && hasAnyText(obj, ["title", "name", "text", "description"]));
}

function looksLikeTikTokVideo(obj: A): boolean {
  if (!isObj(obj)) return false;
  const url = objectUrl(obj);
  const videoUrl = /tiktok\.com\/@[^/]+\/video\/|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url);
  const hasVideoId = Boolean(obj.awemeId || obj.itemId || obj.videoId || (obj.id && (videoUrl || hasEngagement(obj))));
  const profileOnly = Boolean(obj.userInfo || obj.user || obj.authorStats || obj.userStats || obj.followerCount || obj.followers) &&
    !hasVideoId && !videoUrl && !hasAnyText(obj, ["desc", "text", "description", "caption"]);
  if (profileOnly) return false;
  return Boolean(videoUrl || hasVideoId || (hasAnyText(obj, ["desc", "text", "description", "caption"]) && (hasEngagement(obj) || hasAnyDate(obj))));
}

function looksLikeTwitterTweet(obj: A): boolean {
  if (!isObj(obj)) return false;
  const url = objectUrl(obj);
  const statusUrl = /(?:x|twitter)\.com\/[^/]+\/status\//i.test(url);
  const hasTweetId = Boolean(obj.tweetId || obj.rest_id || obj.conversationId || obj.id_str || obj.id && (statusUrl || hasAnyText(obj, ["text", "full_text", "tweet"]))) ;
  const userOnly = Boolean(obj.user || obj.profile || obj.followersCount || obj.totalFollowers || obj.statusesCount) &&
    !hasTweetId && !statusUrl && !hasAnyText(obj, ["text", "full_text", "tweet"]);
  if (userOnly) return false;
  return Boolean(statusUrl || hasTweetId || hasAnyText(obj, ["text", "full_text", "tweet"]));
}

function engagementRateFrom(followers: number, likes: number | null, comments: number | null, shares = 0): number | null {
  if (followers <= 0 || likes == null) return null;
  return +(((likes ?? 0) + (comments ?? 0) + shares) / followers * 100).toFixed(2);
}

function parseApifyError(status: number, text: string): string {
  let body: A = null;
  try { body = JSON.parse(text); } catch { /* keep raw */ }
  const type = body?.error?.type || body?.type || "";
  const message = body?.error?.message || body?.message || text;
  if (type === "actor-is-not-rented" || /actor-is-not-rented|rent this actor/i.test(message)) {
    return "Scraper da Apify não está ativo/alugado para esta rede. Ative/alugue o actor na Apify ou troque o scraper configurado.";
  }
  if (status === 403) return `Apify 403: sem permissão para executar este scraper. ${String(message).slice(0, 160)}`;
  if (status === 401) return "Token da Apify inválido ou expirado.";
  return `Apify ${status}: ${String(message).slice(0, 200)}`;
}

function arr(v: A): A[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const key of ["items", "data", "results", "result", "records"]) {
      if (Array.isArray(v[key])) return v[key];
    }
  }
  return v ? [v] : [];
}

function firstObj(raw: A): A {
  const items = arr(raw);
  return items.find((x) => x && typeof x === "object") || {};
}

function stripQueryHash(value: string): string {
  try {
    const u = new URL(value.startsWith("http") ? value : `https://${value}`);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return value.split("?")[0].split("#")[0].replace(/\/+$/, "");
  }
}

function normalizeYouTubeUrl(input: string): string {
  const raw = stripQueryHash((input || "").trim());
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = raw.replace(/^@/, "").replace(/^\/+/, "");
  return `https://www.youtube.com/@${handle}`;
}

function extractTikTokHandle(input: string): string {
  const raw = stripQueryHash((input || "").trim());
  if (!raw) return "";
  if (/tiktok\.com/i.test(raw)) {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      const seg = u.pathname.split("/").filter(Boolean).find((p) => p.startsWith("@"));
      return (seg || "").replace(/^@/, "");
    } catch {
      const seg = raw.split("/").filter(Boolean).find((p) => p.startsWith("@"));
      return (seg || "").replace(/^@/, "");
    }
  }
  return raw.replace(/^@/, "");
}

function normalizeFacebookUrl(input: string): string {
  const raw = stripQueryHash((input || "").trim());
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/facebook\.com/i.test(raw)) return `https://${raw.replace(/^\/+/, "")}`;
  return `https://www.facebook.com/${raw.replace(/^@/, "").replace(/^\/+/, "")}`;
}

function isMeaningfulProfile(profile: ProfileAnalytics): boolean {
  return Boolean(
    (profile.displayName || profile.username) &&
    ((profile.followers ?? 0) > 0 || (profile.posts ?? 0) > 0 || (profile.recentPosts?.length ?? 0) > 0)
  );
}

// ─── Profile Actor Configs ──────────────────────────────────────

const PLATFORMS: Record<string, ActorConfig> = {
  instagram: {
    actorId: "apify~instagram-profile-scraper",
    buildInput: (u) => ({ usernames: [u], resultsLimit: 12 }),
    normalize: (raw) => {
      const arr = Array.isArray(raw) ? raw : [raw];
      const p = arr[0] || {};
      const posts: A[] = p.latestPosts || p.recentPosts || [];
      const totalLikes = posts.reduce((s: number, x: A) => s + safeNum(x.likesCount || x.likes), 0);
      const totalComments = posts.reduce((s: number, x: A) => s + safeNum(x.commentsCount || x.comments), 0);
      const cnt = posts.length || 1;
      const followers = safeNum(p.followersCount || p.followers);
      const avgL = Math.round(totalLikes / cnt);
      const avgC = Math.round(totalComments / cnt);
      return {
        platform: "instagram",
        username: p.username || "",
        displayName: p.fullName || p.username || "",
        profileImageUrl: p.profilePicUrl || p.profilePicUrlHD || "",
        followers,
        following: safeNum(p.followsCount || p.followingCount),
        posts: safeNum(p.postsCount || p.mediaCount),
        engagementRate: followers > 0 ? +((avgL + avgC) / followers * 100).toFixed(2) : null,
        avgLikes: avgL,
        avgComments: avgC,
        avgViews: null,
        recentPosts: posts.slice(0, 6).map((x: A) => ({
          text: x.caption || "",
          likes: safeNum(x.likesCount || x.likes),
          comments: safeNum(x.commentsCount || x.comments),
          views: safeNum(x.videoViewCount || x.playCount || x.videoPlayCount),
          date: x.timestamp || "",
          url: x.url || `https://instagram.com/p/${x.shortCode || ""}`,
          mediaUrl: x.displayUrl || x.thumbnailUrl || "",
        })),
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  twitter: {
    // UPGRADED: web.harvester~twitter-scraper (4.9★, 7.4K users)
    // Returns tweets WITH user info → enables engagement rate calculation
    actorId: "web.harvester~twitter-scraper",
    buildInput: (u) => ({
      handles: [u.replace(/^@/, "")],
      tweetsDesired: 10,
      includeUserInfo: true,
      storeUserIfNoTweets: true,
    }),
    normalize: (raw) => {
      const items: A[] = arr(raw);
      if (!items.length) {
        return {
          platform: "twitter", username: "", displayName: "", profileImageUrl: "",
          followers: 0, following: 0, posts: 0, engagementRate: null,
          avgLikes: null, avgComments: null, avgViews: null,
          recentPosts: [], fetchedAt: new Date().toISOString(),
        };
      }

      const tweetArrays = collectArraysByKey(raw, ["tweets", "items", "data", "results", "statuses", "timeline"]);
      const tweets = uniquePosts([
        ...tweetArrays.flat(),
        ...items,
        ...collectObjects(raw, looksLikeTwitterTweet),
      ]).filter(looksLikeTwitterTweet);

      // Extract user info — actors vary between user/author/profile/includes.users shapes.
      const first = tweets[0] || items[0] || firstObj(raw);
      const user = first.user || first.author || first.profile || raw?.user || raw?.profile || raw?.includes?.users?.[0] || first;
      const username = firstText(user, ["username", "screen_name", "handle"]) || firstText(first, ["username", "screenName", "handle", "authorUsername"]);
      const displayName = firstText(user, ["userFullName", "fullName", "fullname", "name", "displayName"]) || firstText(first, ["fullname", "authorName", "name"]);
      const profilePic = (firstText(user, ["avatar", "profileImageUrl", "profile_image_url_https", "profilePicture"]) || firstText(first, ["profilePicture", "avatar"]))
        .replace("_normal.", "_400x400.");

      const followers = nestedNum(user, ["totalFollowers", "followersCount", "followers", "follower_count"]) || nestedNum(first, ["followers", "followersCount"]);
      const following = nestedNum(user, ["totalFollowing", "followingCount", "friendsCount", "following"]);
      const totalTweets = nestedNum(user, ["totalTweets", "statusesCount", "tweetCount", "statuses_count"]) || tweets.length;
      const cnt = tweets.length || 1;

      // web.harvester uses: likes, replies, retweets, quotes at top level
      const totalLikes = tweets.reduce((s: number, t: A) => s + nestedNum(t, ["likes", "likeCount", "favorite_count", "favoriteCount"]), 0);
      const totalReplies = tweets.reduce((s: number, t: A) => s + nestedNum(t, ["replies", "replyCount", "reply_count", "comments", "commentCount"]), 0);
      const totalRetweets = tweets.reduce((s: number, t: A) => s + nestedNum(t, ["retweets", "retweetCount", "retweet_count", "shares", "quoteCount"]), 0);
      const totalViews = tweets.reduce((s: number, t: A) => s + nestedNum(t, ["viewCount", "views", "impressions", "view_count"]), 0);

      const avgL = tweets.length ? Math.round(totalLikes / cnt) : null;
      const avgC = tweets.length ? Math.round(totalReplies / cnt) : null;
      const avgV = totalViews > 0 ? Math.round(totalViews / cnt) : null;

      return {
        platform: "twitter",
        username,
        displayName,
        profileImageUrl: profilePic,
        followers,
        following,
        posts: totalTweets,
        engagementRate: engagementRateFrom(followers, avgL, avgC, tweets.length ? Math.round(totalRetweets / cnt) : 0),
        avgLikes: avgL,
        avgComments: avgC,
        avgViews: avgV,
        recentPosts: tweets.slice(0, 6).map((t: A) => ({
          text: firstText(t, ["text", "full_text", "tweet"]),
          likes: nestedNum(t, ["likes", "likeCount", "favorite_count", "favoriteCount"]),
          comments: nestedNum(t, ["replies", "replyCount", "reply_count", "comments", "commentCount"]),
          views: nestedNum(t, ["viewCount", "views", "impressions", "view_count"]),
          date: firstText(t, ["timestamp", "createdAt", "created_at", "date"]),
          url: objectUrl(t) || (firstText(t, ["id", "id_str", "tweetId", "rest_id"]) ? `https://x.com/${username}/status/${firstText(t, ["id", "id_str", "tweetId", "rest_id"])}` : ""),
          mediaUrl: (t.media?.[0]?.url || t.media?.[0]?.media_url_https || ""),
        })),
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  tiktok: {
    // UPGRADED: apidojo~tiktok-profile-scraper (4.4★, 2.4K users)
    // 98% success rate, 425 posts/sec, 40+ data fields per profile
    actorId: "apidojo~tiktok-profile-scraper",
    buildInput: (u) => ({ usernames: [extractTikTokHandle(u)], maxItems: 12 }),
    normalize: (raw) => {
      const arrItems: A[] = arr(raw);
      const profileCandidates = collectObjects(raw, (x) => Boolean(
        x?.uniqueId || x?.username || x?.nickname || x?.user || x?.author || x?.authorMeta ||
        nestedNum(x, ["followerCount", "followers", "fans", "videoCount"]) > 0
      ));
      const p = profileCandidates[0] || arrItems[0] || {};
      const userObj = p.user || p.author || p.authorMeta || p.userInfo?.user || p;
      const statsObj = p.stats || p.authorStats || p.userStats || p.userInfo?.stats || userObj.stats || {};

      const videoArrays = collectArraysByKey(raw, ["videos", "latestVideos", "items", "itemList", "awemeList", "posts", "data", "results"]);
      const videos = uniquePosts([
        ...videoArrays.flat(),
        ...arrItems,
        ...collectObjects(raw, (x) => Boolean(
          x?.desc || x?.text || x?.webVideoUrl || x?.videoUrl || x?.shareUrl || x?.awemeId || x?.itemId || x?.videoId || x?.id &&
          nestedNum(x, ["playCount", "viewCount", "diggCount", "likes", "commentCount"]) > 0
        )),
      ]).filter(looksLikeTikTokVideo);

      const cnt = videos.length || 1;
      const totalLikes = videos.reduce((s: number, v: A) => s + nestedNum(v, ["diggCount", "likeCount", "likes", "likesCount"]), 0);
      const totalComments = videos.reduce((s: number, v: A) => s + nestedNum(v, ["commentCount", "comments", "commentsCount"]), 0);
      const totalViews = videos.reduce((s: number, v: A) => s + nestedNum(v, ["playCount", "viewCount", "views", "plays"]), 0);

      const followers = safeNum(statsObj.followerCount || statsObj.followers || p.fans || p.followerCount || userObj.followerCount || userObj.followers);
      const avgL = Math.round(totalLikes / cnt);

      return {
        platform: "tiktok",
        username: firstText(userObj, ["uniqueId", "username", "handle"]) || firstText(p, ["uniqueId", "username", "name"]),
        displayName: firstText(userObj, ["nickname", "name", "displayName", "nickName"]) || firstText(p, ["nickname", "nickName", "name"]),
        profileImageUrl: firstText(userObj, ["avatarLarger", "avatarMedium", "avatarThumb", "avatar", "profileImageUrl"]) || firstText(p, ["avatarLarger", "avatarMedium", "avatar", "image"]),
        followers,
        following: safeNum(statsObj.followingCount || statsObj.following || p.following || p.followingCount || userObj.followingCount),
        posts: safeNum(statsObj.videoCount || statsObj.posts || p.videoCount || userObj.videoCount || videos.length),
        engagementRate: videos.length && followers > 0 && (avgL + totalComments) > 0 ? +((avgL + Math.round(totalComments / cnt)) / followers * 100).toFixed(2) : null,
        avgLikes: videos.length ? avgL : null,
        avgComments: videos.length ? Math.round(totalComments / cnt) : null,
        avgViews: videos.length ? Math.round(totalViews / cnt) : null,
        recentPosts: videos.slice(0, 6).map((v: A) => ({
          text: firstText(v, ["desc", "text", "description", "caption"]),
          likes: nestedNum(v, ["diggCount", "likeCount", "likes", "likesCount"]),
          comments: nestedNum(v, ["commentCount", "comments", "commentsCount"]),
          views: nestedNum(v, ["playCount", "viewCount", "views", "plays"]),
          date: v.createTime ? new Date((typeof v.createTime === "number" ? v.createTime * 1000 : Date.parse(v.createTime))).toISOString() : firstText(v, ["createTimeISO", "date", "createdAt", "publishedAt"]),
          url: firstText(v, ["webVideoUrl", "videoUrl", "url", "shareUrl"]),
          mediaUrl: firstText(v, ["cover", "dynamicCover", "originCover", "thumbnail", "thumbnailUrl"]),
        })),
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  youtube: {
    actorId: "streamers~youtube-channel-scraper",
    buildInput: (u) => ({
      startUrls: [{ url: normalizeYouTubeUrl(u) }],
      maxVideos: 12,
    }),
    normalize: (raw) => {
      const arrItems: A[] = arr(raw);
      const channelCandidates = collectObjects(raw, (x) => Boolean(
        x?.channelName || x?.channelId || x?.channelTitle || x?.handle || x?.subscriberCount || x?.subscribers || x?.channel
      ));
      const p = channelCandidates[0] || arrItems[0] || {};
      const channel = p.channel || p.channelInfo || p.metadata || p;
      const videoArrays = collectArraysByKey(raw, ["videos", "latestVideos", "items", "posts", "contents", "data", "results", "videoRenderer"]);
      const videos = uniquePosts([
        ...videoArrays.flat(),
        ...arrItems,
        ...collectObjects(raw, (x) => Boolean(
          (x?.title || x?.name || x?.videoId) && (x?.videoUrl || x?.url || x?.watchUrl || x?.videoId || nestedNum(x, ["viewCount", "views", "likeCount", "likes"]) > 0)
        )),
      ]).filter(looksLikeYouTubeVideo);

      const cnt = videos.length || 1;
      const totalViews = videos.reduce((s: number, v: A) => s + nestedNum(v, ["viewCount", "views", "viewCountText"]), 0);
      const totalLikes = videos.reduce((s: number, v: A) => s + nestedNum(v, ["likes", "likeCount", "likesCount"]), 0);
      const totalComments = videos.reduce((s: number, v: A) => s + nestedNum(v, ["commentsCount", "commentCount", "comments"]), 0);
      const subs = safeNum(channel.subscriberCount || channel.subscribers || channel.subscribersCount || p.subscriberCount || p.subscribers || p.stats?.subscribers);
      const avgLikes = videos.length ? Math.round(totalLikes / cnt) : null;
      return {
        platform: "youtube",
        username: firstText(channel, ["channelName", "handle", "title", "name", "channelId", "id"]) || firstText(p, ["channelName", "handle", "title", "channelId"]),
        displayName: firstText(channel, ["channelName", "title", "name"]) || firstText(p, ["channelName", "title", "name"]),
        profileImageUrl: firstText(channel, ["avatar", "thumbnailUrl", "thumbnail", "channelImage", "imageUrl"]) || firstText(p, ["avatar", "thumbnailUrl", "channelImage"]),
        followers: subs,
        following: 0,
        posts: safeNum(channel.videoCount || channel.videosCount || p.videoCount || p.videosCount || p.stats?.videoCount || videos.length),
        engagementRate: engagementRateFrom(subs, avgLikes, videos.length ? Math.round(totalComments / cnt) : null),
        avgLikes,
        avgComments: videos.length ? Math.round(totalComments / cnt) : null,
        avgViews: videos.length ? Math.round(totalViews / cnt) : null,
        recentPosts: videos.slice(0, 6).map((v: A) => ({
          text: firstText(v, ["title", "name", "text"]),
          likes: nestedNum(v, ["likes", "likeCount", "likesCount"]),
          comments: nestedNum(v, ["commentsCount", "commentCount", "comments"]),
          views: nestedNum(v, ["viewCount", "views", "viewCountText"]),
          date: firstText(v, ["date", "publishedAt", "uploadDate", "publishedTime", "publishedTimeText"]),
          url: firstText(v, ["url", "videoUrl", "watchUrl"]) || (firstText(v, ["videoId", "id"]) ? `https://www.youtube.com/watch?v=${firstText(v, ["videoId", "id"])}` : ""),
          mediaUrl: firstText(v, ["thumbnailUrl", "thumbnail", "thumbnailImage", "imageUrl"]),
        })),
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  facebook: {
    // apify~facebook-pages-scraper devolve os campos de página (followers,
    // likes, title, about) + uma lista de posts. O actor anterior
    // (calm_builder~facebook-posts-scraper) só retornava posts, sem
    // followers/likeCount, o que fazia o Analytics mostrar zerado.
    actorId: "apify~facebook-pages-scraper",
    buildInput: (u) => {
      const url = normalizeFacebookUrl(u);
      return {
        startUrls: [{ url }],
        resultsLimit: 8,
        proxyConfiguration: { useApifyProxy: true },
      };
    },
    normalize: (raw) => {
      const arrItems: A[] = arr(raw);
      const pageCandidates = collectObjects(raw, (x) => Boolean(
        x?.pageName || x?.pageUrl || x?.profileUrl || x?.followers || x?.followersCount || x?.followerCount ||
        x?.likes || x?.likesCount || x?.fanCount || x?.title || x?.name || x?.pageId
      ));
      const p = pageCandidates[0] || arrItems[0] || {};
      const profile = p.personalProfile || p.profile || p.about || p.pageInfo || {};
      const pageUrl = firstText(p, ["pageUrl", "profileUrl", "url", "link"]);

      // O apify~facebook-pages-scraper expõe `likes` (curtidas da página) e
      // `followers`. Alguns retornos usam `followersAmountForBio` /
      // `likesAmountForBio`. Consideramos ambos para robustez.
      // Seguidores REAIS (sem cair em curtidas da página).
      const followers = safeNum(
        p.followers || p.followersCount || p.followerCount || p.followers_count ||
        p.followersAmountForBio || p.followersText ||
        profile.followersCount || profile.followers || profile.followerCount || 0
      );
      const pageLikes = safeNum(
        p.likes || p.likeCount || p.likesCount || p.likesAmountForBio ||
        p.fans || p.fanCount || 0
      );


      const postArrays = collectArraysByKey(raw, ["posts", "latestPosts", "timelinePosts", "items", "reels", "data", "results"]);
      const posts = uniquePosts([
        ...postArrays.flat(),
        ...arrItems,
        ...collectObjects(raw, (x) => Boolean(
          x?.postUrl || x?.message || x?.text || x?.postText || x?.description || x?.permalinkUrl || x?.url && hasEngagement(x)
        )),
      ]).filter((x) => looksLikeFacebookPost(x, pageUrl));
      const cnt = posts.length || 1;
      const totalLikes = posts.reduce((s: number, v: A) => s + nestedMetricNum(v, ["likes", "likesCount", "likeCount", "reactions", "reactionCount", "reactionsCount", "reactions_count"]), 0);
      const totalComments = posts.reduce((s: number, v: A) => s + nestedMetricNum(v, ["comments", "commentsCount", "commentCount", "comments_count"]), 0);
      const totalShares = posts.reduce((s: number, v: A) => s + nestedMetricNum(v, ["shares", "sharesCount", "shareCount", "reshare_count"]), 0);
      const totalViews = posts.reduce((s: number, v: A) => s + nestedMetricNum(v, ["views", "viewCount", "plays", "playsCount"]), 0);
      const avgL = posts.length ? Math.round(totalLikes / cnt) : null;
      const avgC = posts.length ? Math.round(totalComments / cnt) : null;
      const avgS = posts.length ? Math.round(totalShares / cnt) : 0;

      console.info("[social-analytics][facebook] normalized", {
        pageUrl,
        followers,
        pageLikes,
        postsFound: posts.length,
        pageCandidateKeys: Object.keys(p).slice(0, 20),
      });

      return {
        platform: "facebook",
        username: firstText(p, ["pageName", "pageUrl", "profileUrl", "username", "name"]),
        displayName: firstText(p, ["title", "name", "pageName"]) || firstText(profile, ["name", "title"]),
        profileImageUrl: firstText(profile, ["profilePicLarge", "profilePicMedium", "profilePic", "imageUrl"]) || firstText(p, ["profileImage", "imageUrl", "logo", "avatar", "pageImage", "profilePhoto"]),
        // Facebook: usamos `followers` como métrica principal; se o actor só
        // devolveu `likes` (curtidas da página), sinalizamos a origem para a UI.
        followers: followers || pageLikes,
        followersSource: followers > 0 ? "followers" : "page_likes",
        following: 0,
        posts: safeNum(p.postsCollected || p.postsCount || p.postCount || profile.postsCount || posts.length || 0),
        engagementRate: engagementRateFrom(followers || pageLikes, avgL, avgC, avgS),

        avgLikes: avgL,
        avgComments: avgC,
        avgViews: totalViews > 0 ? Math.round(totalViews / cnt) : null,
        recentPosts: posts.slice(0, 6).map((v: A) => ({
          text: firstText(v, ["text", "message", "postText", "description", "caption", "content"]) || firstText(v.content, ["text", "message", "caption", "description"]),
          likes: nestedMetricNum(v, ["likes", "likesCount", "likeCount", "reactions", "reactionCount", "reactionsCount", "reactions_count"]),
          comments: nestedMetricNum(v, ["comments", "commentsCount", "commentCount", "comments_count"]),
          views: nestedMetricNum(v, ["views", "viewCount", "plays", "playsCount"]),
          date: firstText(v, ["time", "timestamp", "postedAt", "date", "createdAt", "postCreatedAt", "publishedAt"]) || firstText(v.publishedAt, ["iso", "date", "text"]),
          url: objectUrl(v),
          mediaUrl: firstText(v, ["imageUrl", "fullPicture", "thumbnailUrl", "thumbnail", "videoUrl"]) || firstText(v.media?.[0], ["url"]) || firstText(v.media, ["url", "thumbnailUrl"]),
        })),
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  threads: {
    actorId: "apify~threads-profile-api-scraper",
    buildInput: (u) => ({ usernames: [u] }),
    normalize: (raw) => {
      const arr: A[] = Array.isArray(raw) ? raw : [raw];
      const p = arr[0] || {};
      return {
        platform: "threads",
        username: p.username || "",
        displayName: p.full_name || p.fullName || "",
        profileImageUrl: p.hd_profile_pic_url_info?.url || p.profile_pic_url || "",
        followers: safeNum(p.follower_count || p.followersCount),
        following: 0,
        posts: 0,
        engagementRate: null,
        avgLikes: null,
        avgComments: null,
        avgViews: null,
        recentPosts: [],
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  linkedin: {
    // Personal profile scraper (auto-detected; for /company/ URLs see linkedin_company)
    actorId: "dev_fusion~linkedin-profile-scraper",
    buildInput: (u) => ({
      profileUrls: [u.startsWith("http") ? u : `https://www.linkedin.com/in/${u}`],
    }),
    normalize: (raw) => {
      const arr: A[] = Array.isArray(raw) ? raw : [raw];
      const p = arr[0] || {};
      if (p.error) throw new Error(p.error);
      return {
        platform: "linkedin",
        username: p.publicIdentifier || p.linkedinUrl?.split("/in/")?.[1]?.replace(/\//g, "") || "",
        displayName: p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim(),
        profileImageUrl: p.profilePicture || "",
        followers: safeNum(p.followers || p.followersCount),
        following: 0,
        posts: 0,
        engagementRate: null,
        avgLikes: null,
        avgComments: null,
        avgViews: null,
        recentPosts: [],
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  // LinkedIn Company Page — used automatically when URL contains /company/
  linkedin_company: {
    actorId: "harvestapi~linkedin-company",
    buildInput: (u) => ({
      companies: [u.startsWith("http") ? u : `https://www.linkedin.com/company/${u}/`],
    }),
    normalize: (raw) => {
      const arr: A[] = Array.isArray(raw) ? raw : [raw];
      const p = arr[0] || {};
      return {
        platform: "linkedin",
        username: p.universalName || p.companyUrl?.split("/company/")?.[1]?.replace(/\//g, "") || "",
        displayName: p.name || p.companyName || "",
        profileImageUrl: p.logo || p.logoUrl || p.avatar?.url || "",
        followers: safeNum(p.followerCount || p.followersCount || p.followers),
        following: 0,
        posts: 0,
        engagementRate: null,
        avgLikes: null,
        avgComments: null,
        avgViews: null,
        recentPosts: [],
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  pinterest: {
    actorId: "apivault_labs~pinterest-scraper",
    buildInput: (u) => ({
      profileUrls: [u.startsWith("http") ? u : `https://www.pinterest.com/${u}/`],
    }),
    normalize: (raw) => {
      const arr: A[] = Array.isArray(raw) ? raw : [raw];
      const p = arr[0] || {};
      return {
        platform: "pinterest",
        username: p.username || "",
        displayName: p.fullName || p.full_name || "",
        profileImageUrl: p.profileImage || p.image_xlarge_url || "",
        followers: safeNum(p.followerCount || p.follower_count),
        following: safeNum(p.followingCount || p.following_count),
        posts: safeNum(p.pinCount || p.pin_count),
        engagementRate: null,
        avgLikes: null,
        avgComments: null,
        avgViews: null,
        recentPosts: [],
        fetchedAt: new Date().toISOString(),
      };
    },
  },
};

// Platforms without Apify actors
const UNSUPPORTED_REASONS: Record<string, string> = {
  bluesky: "Bluesky não possui scraper disponível",
};

// ─── Enrichment Actor Configs ───────────────────────────────────

interface EnrichmentActorConfig {
  actorId: string;
  /** Return null to skip enrichment for this profile */
  buildInput: (profile: ProfileAnalytics, username: string) => Record<string, unknown> | null;
  /** Merge enrichment data into the profile */
  merge: (profile: ProfileAnalytics, data: unknown) => void;
}

const ENRICHMENTS: Record<string, EnrichmentActorConfig[] | string> = {
  youtube: [
    {
      // YouTube Comments — fetch top comments from latest video
      actorId: "streamers~youtube-comments-scraper",
      buildInput: (profile) => {
        const videoUrl = profile.recentPosts?.[0]?.url;
        if (!videoUrl) return null;
        return { startUrls: [{ url: videoUrl }], maxComments: 20, commentsSortBy: "top" };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [];
        if (!profile.enrichment) profile.enrichment = {};
        profile.enrichment.comments = items.slice(0, 20).map((c: A) => ({
          author: c.author || c.authorDisplayName || "",
          text: c.comment || c.text || c.textDisplay || "",
          likes: safeNum(c.voteCount || c.votes || c.likeCount),
          date: c.publishedAt || c.date || "",
        }));
      },
    },
    {
      // YouTube Transcript — get transcript of latest video
      actorId: "pintostudio~youtube-transcript-scraper",
      buildInput: (profile) => {
        const videoUrl = profile.recentPosts?.[0]?.url;
        if (!videoUrl) return null;
        return { videoUrl, targetLanguage: "pt" };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [raw];
        const item = items[0];
        if (!item) return;
        if (!profile.enrichment) profile.enrichment = {};
        if (!profile.enrichment.transcripts) profile.enrichment.transcripts = [];
        // pintostudio returns { searchResult: [{ start, dur, text }] } — join segments
        const segments: A[] = item.searchResult || item.captions || [];
        const text = segments.length > 0
          ? segments.map((s: A) => s.text || "").join(" ")
          : (item.transcript || item.text || item.content || "");
        if (text) {
          profile.enrichment.transcripts.push({
            videoUrl: profile.recentPosts?.[0]?.url || "",
            title: item.title || profile.recentPosts?.[0]?.text || "",
            text: typeof text === "string" ? text.slice(0, 5000) : "",
          });
        }
      },
    },
  ],

  tiktok: [
    {
      // TikTok Comments — fetch comments from latest video
      actorId: "apidojo~tiktok-comments-scraper",
      buildInput: (profile) => {
        const videoUrl = profile.recentPosts?.[0]?.url;
        if (!videoUrl) return null;
        return { startUrls: [{ url: videoUrl }], maxItems: 20 };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [];
        if (!profile.enrichment) profile.enrichment = {};
        // apidojo returns: text, likeCount, replyCount, createdAt (ISO), user.username, user.displayName
        profile.enrichment.comments = items.slice(0, 20).map((c: A) => ({
          author: c.user?.username || c.user?.displayName || c.uniqueId || c.nickname || "",
          text: c.text || c.comment || "",
          likes: safeNum(c.likeCount || c.diggCount || c.likes),
          date: c.createdAt || c.createTimeISO || "",
        }));
      },
    },
  ],

  instagram: [
    {
      // Instagram Mentions — tagged posts mentioning the user
      actorId: "apify~instagram-tagged-scraper",
      buildInput: (_profile, username) => {
        if (!username) return null;
        return { username: [username], resultsLimit: 10 };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [];
        if (!profile.enrichment) profile.enrichment = {};
        // apify~instagram-tagged-scraper: caption, commentsCount, shortCode, url, type, latestComments
        profile.enrichment.mentions = items.slice(0, 10).map((m: A) => ({
          username: m.ownerUsername || m.latestComments?.[0]?.ownerUsername || m.owner?.username || "",
          text: m.caption || m.text || "",
          likes: safeNum(m.likesCount || m.likes),
          comments: safeNum(m.commentsCount || m.comments),
          date: m.timestamp || m.takenAt || "",
          url: m.url || `https://instagram.com/p/${m.shortCode || ""}`,
          mediaUrl: m.displayUrl || m.thumbnailUrl || "",
        }));
      },
    },
  ],

  linkedin: [
    {
      // LinkedIn Profile/Company Posts — auto-detects personal vs company
      // Uses harvestapi~linkedin-profile-posts (same API as company-posts, works for both)
      actorId: "harvestapi~linkedin-profile-posts",
      buildInput: (_profile, username) => {
        let url: string;
        if (username.startsWith("http")) {
          url = username;
        } else if (username.includes("/company/")) {
          url = `https://www.linkedin.com/company/${username}/`;
        } else {
          url = `https://www.linkedin.com/in/${username}`;
        }
        return {
          targetUrls: [url],
          maxPosts: 5,
          scrapeComments: true,
          maxComments: 3,
          postNestedComments: true,
        };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [];
        if (!items.length) return;
        if (!profile.enrichment) profile.enrichment = {};
        // harvestapi returns: content, engagement.{likes,comments,shares}, postedAt.date, linkedinUrl
        profile.enrichment.companyPosts = items.slice(0, 5).map((p: A) => ({
          text: p.content || p.text || p.commentary || "",
          likes: safeNum(p.engagement?.likes || p.totalReactionCount || p.numLikes),
          comments: safeNum(p.engagement?.comments || p.numComments || p.commentCount),
          shares: safeNum(p.engagement?.shares || p.numShares || p.shareCount),
          date: p.postedAt?.date || p.postedDate || p.publishedAt || "",
          url: p.linkedinUrl || p.postUrl || p.url || "",
        }));

        // If profile scrape had no engagement data, compute from posts
        if (profile.engagementRate === null && profile.followers > 0 && items.length > 0) {
          const cnt = items.length;
          const totalLikes = items.reduce((s: number, p: A) => s + safeNum(p.engagement?.likes || p.totalReactionCount || p.numLikes), 0);
          const totalComments = items.reduce((s: number, p: A) => s + safeNum(p.engagement?.comments || p.numComments || p.commentCount), 0);
          const avgL = Math.round(totalLikes / cnt);
          const avgC = Math.round(totalComments / cnt);
          profile.avgLikes = avgL;
          profile.avgComments = avgC;
          profile.engagementRate = +((avgL + avgC) / profile.followers * 100).toFixed(2);
          profile.posts = profile.posts || cnt;
          // Populate recentPosts from enrichment if empty
          if (!profile.recentPosts.length) {
            profile.recentPosts = items.slice(0, 6).map((p: A) => ({
              text: p.content || p.text || p.commentary || "",
              likes: safeNum(p.engagement?.likes || p.totalReactionCount),
              comments: safeNum(p.engagement?.comments || p.numComments),
              views: safeNum(p.numViews || p.viewCount || p.impressionCount),
              date: p.postedAt?.date || p.postedDate || "",
              url: p.linkedinUrl || p.postUrl || p.url || "",
              mediaUrl: p.postImages?.[0] || p.images?.[0] || p.image || "",
            }));
          }
        }
      },
    },
    {
      // LinkedIn Brand Monitoring — search posts mentioning the user/brand
      actorId: "harvestapi~linkedin-post-search",
      buildInput: (profile) => {
        // Use displayName or username as search query for brand mentions
        const query = profile.displayName || profile.username;
        if (!query || query.length < 3) return null;
        return {
          searchQueries: [query],
          maxPosts: 5,
          postedLimit: "month",
          sortBy: "date",
        };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [];
        if (!items.length) return;
        if (!profile.enrichment) profile.enrichment = {};
        profile.enrichment.brandMentions = items.slice(0, 5).map((p: A) => ({
          text: p.content || p.text || p.commentary || "",
          likes: safeNum(p.engagement?.likes || p.totalReactionCount || p.numLikes),
          comments: safeNum(p.engagement?.comments || p.numComments || p.commentCount),
          shares: safeNum(p.engagement?.shares || p.numShares || p.shareCount),
          date: p.postedAt?.date || p.postedDate || p.publishedAt || "",
          url: p.linkedinUrl || p.postUrl || p.url || "",
        }));
      },
    },
  ],

  // Also apply enrichments for linkedin_company (same enrichments as personal)
  linkedin_company: "linkedin",

  facebook: [
    {
      // Facebook Reels — reels from the page
      actorId: "apify~facebook-reels-scraper",
      buildInput: (_profile, username) => {
        const url = username.startsWith("http") ? username : `https://www.facebook.com/${username}/`;
        return { startUrls: [{ url }], resultsLimit: 5 };
      },
      merge: (profile, raw) => {
        const items: A[] = Array.isArray(raw) ? raw : [];
        const pageUrl = normalizeFacebookUrl(profile.username || "");
        const posts = uniquePosts(items).filter((item) => looksLikeFacebookPost(item, pageUrl));
        if (!posts.length) return;
        if (!profile.enrichment) profile.enrichment = {};
        profile.enrichment.reels = posts.slice(0, 5).map((r: A) => ({
          text: r.text || r.postText || r.description || "",
          likes: safeNum(r.likesCount || r.likes || r.reactions),
          comments: safeNum(r.commentsCount || r.comments),
          shares: safeNum(r.sharesCount || r.shares),
          views: safeNum(r.viewCount || r.views || r.playsCount || r.plays),
          date: r.time || r.date || r.timestamp || "",
          url: r.url || r.postUrl || "",
        }));

        // Enrich Facebook engagement from reels if profile had no data
        if (profile.engagementRate === null && profile.followers > 0 && posts.length > 0) {
          const cnt = posts.length;
          const totalLikes = posts.reduce((s: number, r: A) => s + safeNum(r.likesCount || r.likes || r.reactions), 0);
          const totalComments = posts.reduce((s: number, r: A) => s + safeNum(r.commentsCount || r.comments), 0);
          const totalViews = posts.reduce((s: number, r: A) => s + safeNum(r.viewCount || r.views || r.playsCount), 0);
          profile.avgLikes = Math.round(totalLikes / cnt);
          profile.avgComments = Math.round(totalComments / cnt);
          profile.avgViews = totalViews > 0 ? Math.round(totalViews / cnt) : null;
          profile.engagementRate = +((profile.avgLikes + profile.avgComments) / profile.followers * 100).toFixed(2);
          // Populate recentPosts from reels if empty
          if (!profile.recentPosts.length) {
            profile.recentPosts = posts.slice(0, 6).map((r: A) => ({
              text: r.text || r.postText || r.description || "",
              likes: safeNum(r.likesCount || r.likes || r.reactions),
              comments: safeNum(r.commentsCount || r.comments),
              views: safeNum(r.viewCount || r.views || r.playsCount),
              date: r.time || r.date || "",
              url: r.url || r.postUrl || "",
              mediaUrl: r.thumbnailUrl || r.thumbnail || r.videoUrl || "",
            }));
          }
        }
      },
    },
  ],
};

// ─── Re-host profile images ─────────────────────────────────────

async function reHostImage(url: string, name: string): Promise<string> {
  if (!url) return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=7c3aed&color=fff`;

  if (!url.includes("cdninstagram.com") && !url.includes("tiktokcdn.com") && !url.includes("pbs.twimg.com")) {
    return url;
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    });
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const contentType = res.headers.get("content-type") || "image/jpeg";
      return `data:${contentType};base64,${base64}`;
    }
  } catch {
    // fall through
  }

  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=7c3aed&color=fff`;
}

// ─── Public-page fallbacks ───────────────────────────────────────

async function fetchPublicHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
    },
  });
  if (!res.ok) throw new Error(`Página pública HTTP ${res.status}`);
  return res.text();
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\\n/g, " ")
    .trim();
}

function extractYouTubeVideosFromHtml(html: string): ProfileAnalytics["recentPosts"] {
  const videos: ProfileAnalytics["recentPosts"] = [];
  const seen = new Set<string>();
  const chunks = html.split('"videoId":"').slice(1);
  for (const chunk of chunks) {
    const id = chunk.split('"')[0];
    if (!id || seen.has(id)) continue;
    const block = chunk.slice(0, 5000);
    const title = textFromMatch(block, [
      /"title":\{"runs":\[\{"text":"([^"]+)"/i,
      /"title":\{"simpleText":"([^"]+)"/i,
      /"headline":\{"simpleText":"([^"]+)"/i,
    ]);
    if (!title || /YouTube|Google/i.test(title)) continue;
    const viewText = textFromMatch(block, [
      /"viewCountText":\{"simpleText":"([^"]+)"/i,
      /"viewCountText":\{"runs":\[\{"text":"([^"]+)"/i,
      /"shortViewCountText":\{"simpleText":"([^"]+)"/i,
    ]);
    const date = textFromMatch(block, [
      /"publishedTimeText":\{"simpleText":"([^"]+)"/i,
      /"dateText":\{"simpleText":"([^"]+)"/i,
    ]);
    const thumbnail = decodeHtmlText(textFromMatch(block, [
      /"thumbnail":\{"thumbnails":\[\{"url":"([^"]+)"/i,
      /"thumbnails":\[\{"url":"([^"]+)"/i,
    ]));
    seen.add(id);
    videos.push({
      text: title,
      likes: 0,
      comments: 0,
      views: safeNum(viewText),
      date,
      url: `https://www.youtube.com/watch?v=${id}`,
      mediaUrl: thumbnail,
    });
    if (videos.length >= 6) break;
  }
  return videos;
}

async function extractYouTubeVideosFromRss(channelId: string): Promise<ProfileAnalytics["recentPosts"]> {
  if (!channelId) return [];
  const rss = await fetchPublicHtml(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  const entries = [...rss.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].slice(0, 6);
  const videos = await Promise.all(entries.map(async (entry) => {
    const xml = entry[1];
    const id = decodeHtmlText(xml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i)?.[1] || "");
    const title = decodeHtmlText(xml.match(/<title>([^<]+)<\/title>/i)?.[1] || "");
    const published = decodeHtmlText(xml.match(/<published>([^<]+)<\/published>/i)?.[1] || "");
    const media = decodeHtmlText(xml.match(/<media:thumbnail[^>]+url="([^"]+)"/i)?.[1] || "");
    let views = 0;
    if (id) {
      try {
        const watch = await fetchPublicHtml(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
        views = safeNum(textFromMatch(watch, [
          /"viewCount":"?(\d+)"?/i,
          /([\d.,]+\s*(?:views|visualizações))/i,
        ]));
      } catch {
        views = 0;
      }
    }
    return {
      text: title,
      likes: 0,
      comments: 0,
      views,
      date: published,
      url: id ? `https://www.youtube.com/watch?v=${id}` : "",
      mediaUrl: media,
    };
  }));
  return videos.filter(looksLikeRealFallbackPost);
}

function extractTikTokVideosFromHtml(html: string, handle: string): ProfileAnalytics["recentPosts"] {
  const sigi = html.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!sigi) return [];
  try {
    const parsed = JSON.parse(decodeHtmlText(sigi));
    const itemModule = parsed?.ItemModule || {};
    return Object.values(itemModule).slice(0, 6).map((item: A) => ({
      text: firstText(item, ["desc", "text"]),
      likes: nestedNum(item?.stats || item, ["diggCount", "likes", "likeCount"]),
      comments: nestedNum(item?.stats || item, ["commentCount", "comments"]),
      views: nestedNum(item?.stats || item, ["playCount", "views", "viewCount"]),
      date: item?.createTime ? new Date(safeNum(String(item.createTime)) * 1000).toISOString() : "",
      url: `https://www.tiktok.com/@${handle}/video/${item?.id || ""}`,
      mediaUrl: firstText(item?.video || item, ["cover", "originCover", "dynamicCover"]),
    })).filter(looksLikeRealFallbackPost);
  } catch {
    return [];
  }
}

function looksLikeRealFallbackPost(post: ProfileAnalytics["recentPosts"][number]): boolean {
  return Boolean(post?.url && (post.text || post.views || post.likes || post.comments));
}

function textFromMatch(html: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlText(match[1]);
  }
  return "";
}

async function fallbackYouTubeProfile(input: string): Promise<ProfileAnalytics | null> {
  const url = normalizeYouTubeUrl(input);
  const html = await fetchPublicHtml(url);
  let videos: ProfileAnalytics["recentPosts"] = [];
  const channelId = textFromMatch(html, [
    /"channelId":"([^"]+)"/i,
    /<meta itemprop="channelId" content="([^"]+)"/i,
    /youtube\.com\/channel\/([A-Za-z0-9_-]+)/i,
  ]);
  if (channelId) {
    try { videos = await extractYouTubeVideosFromRss(channelId); } catch { videos = []; }
  }
  try {
    const videosUrl = `${url.replace(/\/$/, "")}/videos`;
    if (!videos.length) videos = extractYouTubeVideosFromHtml(await fetchPublicHtml(videosUrl));
  } catch {
    if (!videos.length) videos = extractYouTubeVideosFromHtml(html);
  }
  const title = textFromMatch(html, [
    /<meta property="og:title" content="([^"]+)"/i,
    /"title":\{"simpleText":"([^"]+)"/i,
    /"channelMetadataRenderer":\{"title":"([^"]+)"/i,
  ]).replace(/ - YouTube$/i, "");
  const avatar = textFromMatch(html, [
    /<meta property="og:image" content="([^"]+)"/i,
    /"avatar"[^\[]*\[\{"url":"([^"]+)"/i,
  ]);
  const subscriberText = textFromMatch(html, [
    /"subscriberCountText":\{"simpleText":"([^"]+)"/i,
    /"subscriberCountText":\{"runs":\[\{"text":"([^"]+)"/i,
    /([\d.,]+\s*(?:mil|mi|k|m)?\s*(?:inscritos|subscribers))/i,
  ]);
  const videoText = textFromMatch(html, [
    /"videosCountText":\{"runs":\[\{"text":"([^"]+)"/i,
    /"videoCountText":\{"runs":\[\{"text":"([^"]+)"/i,
    /([\d.,]+\s*(?:vídeos|videos))/i,
  ]);
  const followers = safeNum(subscriberText);
  const posts = safeNum(videoText) || videos.length;
  const totalViews = videos.reduce((sum, video) => sum + (video.views || 0), 0);
  if (!title && followers === 0 && posts === 0) return null;
  return {
    platform: "youtube",
    username: title || input,
    displayName: title || input,
    profileImageUrl: avatar,
    followers,
    following: 0,
    posts,
    engagementRate: null,
    avgLikes: null,
    avgComments: null,
    avgViews: videos.length && totalViews > 0 ? Math.round(totalViews / videos.length) : null,
    recentPosts: videos,
    fetchedAt: new Date().toISOString(),
  };
}

async function fallbackTikTokProfile(input: string): Promise<ProfileAnalytics | null> {
  const handle = extractTikTokHandle(input);
  if (!handle) return null;
  const url = `https://www.tiktok.com/@${handle}`;
  const html = await fetchPublicHtml(url);
  const displayName = textFromMatch(html, [
    /<meta property="og:title" content="([^"]+)"/i,
    /"nickname":"([^"]+)"/i,
  ]).replace(/^@[^\s]+\s*-\s*/, "").replace(/ on TikTok$/i, "");
  const avatar = textFromMatch(html, [
    /<meta property="og:image" content="([^"]+)"/i,
    /"avatarLarger":"([^"]+)"/i,
    /"avatarMedium":"([^"]+)"/i,
  ]);
  const followerText = textFromMatch(html, [
    /"followerCount":(\d+)/i,
    /"followers":(\d+)/i,
    /([\d.,]+\s*(?:mil|mi|k|m)?\s*(?:seguidores|followers))/i,
  ]);
  const followingText = textFromMatch(html, [/"followingCount":(\d+)/i]);
  const videoText = textFromMatch(html, [/"videoCount":(\d+)/i]);
  const followers = safeNum(followerText);
  const videos = extractTikTokVideosFromHtml(html, handle);
  const posts = safeNum(videoText) || videos.length;
  const totalLikes = videos.reduce((sum, video) => sum + (video.likes || 0), 0);
  const totalComments = videos.reduce((sum, video) => sum + (video.comments || 0), 0);
  const totalViews = videos.reduce((sum, video) => sum + (video.views || 0), 0);
  if (!displayName && followers === 0 && posts === 0) return null;
  return {
    platform: "tiktok",
    username: handle,
    displayName: displayName || handle,
    profileImageUrl: avatar,
    followers,
    following: safeNum(followingText),
    posts,
    engagementRate: videos.length && followers > 0 ? +(((totalLikes + totalComments) / videos.length) / followers * 100).toFixed(2) : null,
    avgLikes: videos.length ? Math.round(totalLikes / videos.length) : null,
    avgComments: videos.length ? Math.round(totalComments / videos.length) : null,
    avgViews: videos.length && totalViews > 0 ? Math.round(totalViews / videos.length) : null,
    recentPosts: videos,
    fetchedAt: new Date().toISOString(),
  };
}

async function fallbackProfile(platform: string, username: string): Promise<ProfileAnalytics | null> {
  try {
    if (platform === "youtube") return await fallbackYouTubeProfile(username);
    if (platform === "tiktok") return await fallbackTikTokProfile(username);
  } catch (err) {
    console.warn(`[social-analytics] fallback failed for ${platform}/${username}:`, err);
  }
  return null;
}

// ─── Facebook: coleta das publicações do feed ───────────────────
// O actor de páginas (apify~facebook-pages-scraper) devolve apenas dados
// institucionais da página — nenhuma publicação. Por isso rodamos SEMPRE
// uma segunda coleta com o scraper de posts e preenchemos com ela os posts
// recentes, médias de likes/comentários/views e a taxa de engajamento.
const FACEBOOK_POST_ACTORS = [
  "apify~facebook-posts-scraper",
  "apify~facebook-reels-scraper",
];

function mapFacebookPost(v: A) {
  return {
    text: firstText(v, ["text", "message", "postText", "description", "caption", "content"]) ||
      firstText(v.content, ["text", "message", "caption", "description"]),
    likes: nestedMetricNum(v, ["likes", "likesCount", "likeCount", "reactions", "reactionCount", "reactionsCount", "reactions_count"]),
    comments: nestedMetricNum(v, ["comments", "commentsCount", "commentCount", "comments_count"]),
    views: nestedMetricNum(v, ["views", "viewCount", "plays", "playsCount", "videoViewCount"]),
    date: firstText(v, ["time", "timestamp", "postedAt", "date", "createdAt", "postCreatedAt", "publishedAt"]) ||
      firstText(v.publishedAt, ["iso", "date", "text"]),
    url: objectUrl(v),
    mediaUrl: firstText(v, ["imageUrl", "fullPicture", "thumbnailUrl", "thumbnail", "videoUrl"]) ||
      firstText(v.media?.[0], ["url", "thumbnail", "thumbnailUrl"]) ||
      firstText(v.media, ["url", "thumbnailUrl"]),
  };
}

async function collectFacebookPosts(
  token: string,
  pageUrl: string,
): Promise<A[]> {
  const found: A[] = [];
  for (const actorId of FACEBOOK_POST_ACTORS) {
    try {
      const raw = await runActor(
        token,
        actorId,
        { startUrls: [{ url: pageUrl }], resultsLimit: 10, proxyConfiguration: { useApifyProxy: true } },
        90,
      );
      const arrays = collectArraysByKey(raw, ["posts", "latestPosts", "timelinePosts", "items", "reels", "data", "results"]);
      const candidates = uniquePosts([...arr(raw), ...arrays.flat()])
        .filter((x: A) => looksLikeFacebookPost(x, pageUrl));
      console.info(`[social-analytics][facebook] ${actorId} -> ${candidates.length} posts`);
      found.push(...candidates);
      if (found.length >= 6) break;
    } catch (err) {
      console.warn(`[social-analytics][facebook] ${actorId} falhou:`, err instanceof Error ? err.message : err);
    }
  }
  return uniquePosts(found);
}

/**
 * Preenche posts/médias/engajamento do Facebook. Nunca zera dados já
 * existentes: se a coleta voltar vazia, o perfil segue como estava.
 */
async function applyFacebookPosts(
  token: string,
  profile: ProfileAnalytics,
  username: string,
): Promise<void> {
  if (profile.recentPosts?.length) return;
  const pageUrl = normalizeFacebookUrl(username || profile.username || "");
  if (!pageUrl) return;

  const posts = await collectFacebookPosts(token, pageUrl);
  if (!posts.length) {
    console.warn("[social-analytics][facebook] nenhuma publicação pública coletada para", pageUrl);
    return;
  }

  const mapped = posts.map(mapFacebookPost);
  const cnt = mapped.length;
  const totalLikes = mapped.reduce((s, p) => s + p.likes, 0);
  const totalComments = mapped.reduce((s, p) => s + p.comments, 0);
  const totalViews = mapped.reduce((s, p) => s + p.views, 0);
  const totalShares = posts.reduce(
    (s: number, v: A) => s + nestedMetricNum(v, ["shares", "sharesCount", "shareCount", "reshare_count"]),
    0,
  );

  profile.recentPosts = mapped.slice(0, 6);
  profile.avgLikes = Math.round(totalLikes / cnt);
  profile.avgComments = Math.round(totalComments / cnt);
  profile.avgViews = totalViews > 0 ? Math.round(totalViews / cnt) : profile.avgViews;
  profile.posts = profile.posts || cnt;
  profile.engagementRate = engagementRateFrom(
    profile.followers,
    profile.avgLikes,
    profile.avgComments,
    Math.round(totalShares / cnt),
  ) ?? profile.engagementRate;

  console.info("[social-analytics][facebook] posts aplicados", {
    pageUrl,
    postsFound: cnt,
    avgLikes: profile.avgLikes,
    avgComments: profile.avgComments,
    engagementRate: profile.engagementRate,
  });
}



// ─── Apify Runner ───────────────────────────────────────────────

async function runActor(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  timeout = 120
): Promise<unknown> {
  const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=${timeout}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(parseApifyError(res.status, text));
  }

  return res.json();
}

// ─── Enrichment Runner ──────────────────────────────────────────

async function runEnrichments(
  token: string,
  profile: ProfileAnalytics,
  username: string,
): Promise<void> {
  let enrichKey = profile.platform;
  // Resolve aliases (e.g. linkedin_company → linkedin)
  const entry = ENRICHMENTS[enrichKey];
  if (typeof entry === "string") enrichKey = entry;
  const configs = ENRICHMENTS[enrichKey];
  if (!Array.isArray(configs) || !configs.length) return;

  await Promise.allSettled(
    configs.map(async (cfg) => {
      try {
        const input = cfg.buildInput(profile, username);
        if (!input) return; // skip
        const data = await runActor(token, cfg.actorId, input, 90);
        cfg.merge(profile, data);
      } catch (err) {
        // Enrichment failures are non-fatal — log and continue
        console.warn(`Enrichment ${cfg.actorId} failed for ${profile.platform}/${username}:`, err);
      }
    })
  );
}

// ─── Handler ────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const authResult = await requireUser(req, corsHeaders);
  if (authResult instanceof Response) return authResult;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { accounts, enrich = false, companyId } = (await req.json()) as {
      accounts: { platform: string; username: string }[];
      enrich?: boolean;
      companyId?: string;
    };

    if (!companyId) {
      return new Response(
        JSON.stringify({ error: "Empresa não informada." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cfg = await getCompanyOwnerConfig(companyId, authResult.user.id, corsHeaders);
    if (cfg instanceof Response) return cfg; // 403 se não membro

    const apifyToken = cfg.config.apify_api_token;
    if (!apifyToken) {
      return new Response(
        JSON.stringify({ error: "Apify não configurado para esta empresa." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!accounts?.length) {
      return new Response(
        JSON.stringify({ error: "Missing 'accounts' array" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: ProfileAnalytics[] = [];
    const errors: { platform: string; username: string; error: string }[] = [];

    // Phase 1: Profile scraping (parallel)
    await Promise.allSettled(
      accounts.map(async ({ platform, username }) => {
        // LinkedIn auto-detection: /company/ URLs use linkedin_company actor
        let resolvedPlatform = platform;
        if (platform === "linkedin" && username.includes("/company/")) {
          resolvedPlatform = "linkedin_company";
        }
        const config = PLATFORMS[resolvedPlatform];
        if (!config) {
          const reason = UNSUPPORTED_REASONS[platform] || `Scraper não disponível para ${platform}`;
          errors.push({ platform, username, error: reason });
          return;
        }
        if (!username || username.includes("<No channel>")) {
          errors.push({ platform, username: username || "", error: "Sem perfil/canal vinculado" });
          return;
        }

        try {
          const input = config.buildInput(username);
          const data = await runActor(apifyToken, config.actorId, input);
          const normalized = config.normalize(data);
          if (!normalized.username) normalized.username = username;

          if ((platform === "youtube" || platform === "tiktok") && !(normalized.recentPosts?.length)) {
            const fallback = await fallbackProfile(platform, username);
            if (fallback && (fallback.recentPosts?.length || fallback.followers > 0 || fallback.posts > 0)) {
              normalized.recentPosts = fallback.recentPosts?.length ? fallback.recentPosts : normalized.recentPosts;
              normalized.avgLikes = fallback.avgLikes ?? normalized.avgLikes;
              normalized.avgComments = fallback.avgComments ?? normalized.avgComments;
              normalized.avgViews = fallback.avgViews ?? normalized.avgViews;
              normalized.engagementRate = fallback.engagementRate ?? normalized.engagementRate;
              normalized.followers = normalized.followers || fallback.followers;
              normalized.posts = normalized.posts || fallback.posts;
              normalized.displayName = normalized.displayName || fallback.displayName;
              normalized.username = normalized.username || fallback.username;
              normalized.profileImageUrl = normalized.profileImageUrl || fallback.profileImageUrl;
            }
          }

          if (!isMeaningfulProfile(normalized)) {
            const fallback = await fallbackProfile(platform, username);
            if (fallback && isMeaningfulProfile(fallback)) {
              fallback.profileImageUrl = await reHostImage(
                fallback.profileImageUrl,
                fallback.displayName || fallback.username
              );
              results.push(fallback);
              return;
            }
            errors.push({
              platform,
              username,
              error: "Coleta sem dados públicos suficientes. Confira se a URL do perfil está correta e pública.",
            });
            return;
          }
          normalized.profileImageUrl = await reHostImage(
            normalized.profileImageUrl,
            normalized.displayName || normalized.username
          );
          results.push(normalized);
        } catch (err) {
          const fallback = await fallbackProfile(platform, username);
          if (fallback && isMeaningfulProfile(fallback)) {
            fallback.profileImageUrl = await reHostImage(
              fallback.profileImageUrl,
              fallback.displayName || fallback.username
            );
            results.push(fallback);
            return;
          }
          errors.push({
            platform,
            username,
            error: err instanceof Error ? err.message : "Erro desconhecido",
          });
        }
      })
    );

    // Phase 2: Enrichment (parallel, only when enrich=true)
    if (enrich) {
      await Promise.allSettled(
        results.map((profile) => {
          const original = accounts.find((a) => a.platform === profile.platform);
          return runEnrichments(apifyToken, profile, original?.username || profile.username);
        })
      );
    }

    return new Response(
      JSON.stringify({ results, errors, fetchedAt: new Date().toISOString() }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("social-analytics error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
