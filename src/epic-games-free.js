// Free (PC) games on the Epic Games Store from the JSON that the free-games page is built from.
// Static, cached by Akamai, not behind Cloudflare and stable across Epic's frequent UI redesigns - unlike the HTML which broke the claimer every few months.
// Pure function in its own module so it can be unit tested (test/epic-games-free.js) without launching a browser.

export const URL_STORE = 'https://store.epicgames.com';
export const URL_FREE_GAMES_API = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';

// Extract the URLs of the games that are free right now from Epic's freeGamesPromotions JSON.
// Only offers with an active (startDate <= now <= endDate) 100% discount are returned, upcoming ones are ignored.
// Shared with the HTML fallback below so the per-game loop always receives the same URL format.
export const freeGameUrlsFromJson = (body, now = new Date()) => {
  const slug = ({ catalogNs, offerMappings, productSlug, urlSlug }) => catalogNs?.mappings?.find(m => m.pageType === 'productHome')?.pageSlug ?? catalogNs?.mappings?.[0]?.pageSlug
    ?? offerMappings?.find(m => m.pageType === 'productHome')?.pageSlug ?? offerMappings?.[0]?.pageSlug
    ?? productSlug?.replace(/\/home$/, '')
    ?? urlSlug;
  const urls = (body?.data?.Catalog?.searchStore?.elements ?? [])
    .filter(e => e.promotions?.promotionalOffers?.some(({ promotionalOffers }) => promotionalOffers?.some(({ startDate, endDate, discountSetting }) => discountSetting?.discountPercentage === 0 && new Date(startDate) <= now && now <= new Date(endDate))))
    .map(slug)
    .filter(Boolean)
    .map(s => `${URL_STORE}/en-US/p/${s}`);
  return [...new Set(urls)]; // dedupe, e.g. base game + its add-on may map to the same product page
};

