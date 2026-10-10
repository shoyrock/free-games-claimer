// Free mobile games (Android/iOS) on the Epic Games Store - https://github.com/vogler/free-games-claimer/issues/474
// The free-games page only lists PC games, mobile games come from the discover API:
// https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=US&locale=en&platform=android&start=0&store=EGS
// $ jq '.data[] | select(.type == "freeGame") | .offers[].content | {title, slug: .mapping.slug, price: (.purchase[] | {decimal: .price.decimalPrice, type: .purchaseType})}'

const url = s => `https://store.epicgames.com/en-US/p/${s}`;

const get = async (page, platform = 'android', country = 'US') => { // platform: android or ios
  // fetched via the page instead of node's fetch since the API returned HTML instead of JSON without browser cookies
  await page.goto(`https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=${country}&locale=en&platform=${platform}&start=0&store=EGS`);
  return JSON.parse(await page.innerText('body'));
};

export const getPlatformGames = async (page, platform, country) => {
  const json = await get(page, platform, country);
  const free_game = (json.data ?? []).find(x => x.type == 'freeGame');
  if (!free_game) return [];
  return (free_game.offers ?? [])
    .filter(offer => offer.content?.mapping?.slug)
    .filter(offer => !offer.content.purchase || offer.content.purchase.some(p => p.purchaseType == 'Claim' || p.price?.decimalPrice === 0)) // only free ones
    .map(offer => ({ title: offer.content.title, url: url(offer.content.mapping.slug) }));
};

export const getMobileGames = async (context, country = 'US') => {
  const page = await context.newPage();
  try {
    return [...await getPlatformGames(page, 'android', country), ...await getPlatformGames(page, 'ios', country)];
  } finally {
    await page.close();
  }
};
