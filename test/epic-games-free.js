// Run with: node test/epic-games-free.js [path/to/freeGamesPromotions.json]
// Without an argument, fetches the live JSON from Epic and prints the current free games.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freeGameUrlsFromJson, freeGamesFromJson, URL_FREE_GAMES_API } from '../src/epic-games-free.js';

const offer = (slug, start, end, pct = 0, extra = {}) => ({
  title: slug,
  id: `id-${slug}`,
  namespace: `ns-${slug}`,
  offerType: 'BASE_GAME',
  urlSlug: slug,
  catalogNs: { mappings: [{ pageSlug: slug, pageType: 'productHome' }] },
  promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: start, endDate: end, discountSetting: { discountType: 'PERCENTAGE', discountPercentage: pct } }] }], upcomingPromotionalOffers: [] },
  ...extra,
});
const now = new Date('2026-10-09T12:00:00Z');
const body = { data: { Catalog: { searchStore: { elements: [
  offer('free-now', '2026-10-08T15:00:00.000Z', '2026-10-15T15:00:00.000Z'),
  offer('expired', '2026-09-01T15:00:00.000Z', '2026-09-08T15:00:00.000Z'),
  offer('upcoming', '2026-10-15T15:00:00.000Z', '2026-10-22T15:00:00.000Z'),
  offer('only-50-off', '2026-10-08T15:00:00.000Z', '2026-10-15T15:00:00.000Z', 50),
  { title: 'no promotions', urlSlug: 'none', promotions: null },
  { title: 'home slug', productSlug: 'home-slug/home', promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-10-08T15:00:00.000Z', endDate: '2026-10-15T15:00:00.000Z', discountSetting: { discountPercentage: 0 } }] }] } },
  offer('add-on-page', '2026-10-08T15:00:00.000Z', '2026-10-15T15:00:00.000Z', 0, { catalogNs: { mappings: [{ pageSlug: 'offer-slug', pageType: 'offer' }, { pageSlug: 'product-slug', pageType: 'productHome' }] } }),
  offer('free-now', '2026-10-08T15:00:00.000Z', '2026-10-15T15:00:00.000Z'), // duplicate
] } } } };

assert.deepEqual(freeGameUrlsFromJson(body, now), [
  'https://store.epicgames.com/en-US/p/free-now',
  'https://store.epicgames.com/en-US/p/home-slug',
  'https://store.epicgames.com/en-US/p/product-slug',
]);
assert.deepEqual(freeGamesFromJson(body, now)[0], { title: 'free-now', url: 'https://store.epicgames.com/en-US/p/free-now', slug: 'free-now', namespace: 'ns-free-now', id: 'id-free-now', offerType: 'BASE_GAME' });
assert.deepEqual(freeGameUrlsFromJson({}, now), []);
assert.deepEqual(freeGameUrlsFromJson(null, now), []);
console.log('unit tests passed');

const file = process.argv[2];
const json = file ? JSON.parse(readFileSync(file, 'utf8')) : await (await fetch(URL_FREE_GAMES_API)).json();
const urls = freeGameUrlsFromJson(json);
console.log(file ? `free games in ${file}:` : 'free games right now:', urls);
assert.ok(Array.isArray(urls));
