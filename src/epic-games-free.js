// Free (PC) games on the Epic Games Store from the JSON that the free-games page is built from.
// Static, cached by Akamai, not behind Cloudflare and stable across Epic's frequent UI redesigns - unlike the HTML which broke the claimer every few months.
// Pure function in its own module so it can be unit tested (test/epic-games-free.js) without launching a browser.

export const URL_STORE = 'https://store.epicgames.com';
export const URL_FREE_GAMES_API = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';

// The games that are free right now from Epic's freeGamesPromotions JSON, as { title, url, slug, namespace, id, offerType }.
// Only offers with an active (startDate <= now <= endDate) 100% discount are returned, upcoming ones are ignored.
// namespace + id allow building the direct checkout URL as a fallback when the product page can't be parsed.
export const freeGamesFromJson = (body, now = new Date()) => {
  const slugOf = ({ catalogNs, offerMappings, productSlug, urlSlug }) => catalogNs?.mappings?.find(m => m.pageType === 'productHome')?.pageSlug ?? catalogNs?.mappings?.[0]?.pageSlug
    ?? offerMappings?.find(m => m.pageType === 'productHome')?.pageSlug ?? offerMappings?.[0]?.pageSlug
    ?? productSlug?.replace(/\/home$/, '')
    ?? urlSlug;
  const isFreeNow = e => e.promotions?.promotionalOffers?.some(({ promotionalOffers }) => promotionalOffers?.some(({ startDate, endDate, discountSetting }) => discountSetting?.discountPercentage === 0 && new Date(startDate) <= now && now <= new Date(endDate)));
  const seen = new Set();
  const games = [];
  for (const e of body?.data?.Catalog?.searchStore?.elements ?? []) {
    if (!isFreeNow(e)) continue;
    const slug = slugOf(e);
    if (!slug || seen.has(slug)) continue; // dedupe, e.g. base game + its add-on may map to the same product page
    seen.add(slug);
    games.push({ title: e.title, url: `${URL_STORE}/en-US/p/${slug}`, slug, namespace: e.namespace, id: e.id, offerType: e.offerType });
  }
  return games;
};

export const freeGameUrlsFromJson = (body, now = new Date()) => freeGamesFromJson(body, now).map(g => g.url);
