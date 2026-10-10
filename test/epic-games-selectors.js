// Run with: node test/epic-games-selectors.js
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNDLED_SELECTORS, mergeSelectors, loadSelectors } from '../src/epic-games-selectors.js';

// every entry used by epic-games.js exists in the bundled file
for (const k of ['nav', 'navLoggedInAttr', 'navUserAttr', 'privacyContinue', 'freeNowLinks', 'cloudflareTitle', 'cloudflareText', 'purchaseUrl', 'login', 'product', 'checkout']) assert.ok(k in BUNDLED_SELECTORS, `missing ${k}`);
for (const k of ['email', 'continue', 'password', 'signIn', 'confirmAccount', 'error', 'captcha', 'captchaIncorrect', 'mfaUrl', 'mfaCode', 'mfaSubmit']) assert.ok(k in BUNDLED_SELECTORS.login, `missing login.${k}`);
for (const k of ['cta', 'ctaLoading', 'ctaInLibrary', 'ctaRequiresBaseGame', 'matureContinue', 'ageSelect', 'bundleMarker', 'bundleTitle', 'bundleIncludes', 'title', 'baseGameLink', 'deviceContinue', 'buyAnyway', 'eulaText', 'eulaAgree', 'eulaAccept']) assert.ok(k in BUNDLED_SELECTORS.product, `missing product.${k}`);
for (const k of ['iframe', 'regionError', 'pin', 'pinInput', 'pinContinue', 'placeOrder', 'accept', 'captcha', 'captchaFailed', 'success', 'alreadyOwned']) assert.ok(k in BUNDLED_SELECTORS.checkout, `missing checkout.${k}`);
assert.ok(BUNDLED_SELECTORS.purchaseUrl.includes('{namespace}') && BUNDLED_SELECTORS.purchaseUrl.includes('{id}'));

// merge: nested objects merge, arrays/strings replace, unknown keys are added
const merged = mergeSelectors(BUNDLED_SELECTORS, { checkout: { placeOrder: ['button:has-text("Claim")'] }, nav: 'egs-nav', extra: { a: 1 } });
assert.deepEqual(merged.checkout.placeOrder, ['button:has-text("Claim")']);
assert.deepEqual(merged.checkout.success, BUNDLED_SELECTORS.checkout.success);
assert.equal(merged.nav, 'egs-nav');
assert.deepEqual(merged.extra, { a: 1 });
assert.deepEqual(mergeSelectors(BUNDLED_SELECTORS, null), BUNDLED_SELECTORS);
assert.notEqual(merged, BUNDLED_SELECTORS); // no mutation
assert.deepEqual(BUNDLED_SELECTORS.checkout.placeOrder, JSON.parse(JSON.stringify(BUNDLED_SELECTORS.checkout.placeOrder)));

// load: local override file wins, broken remote URL is ignored
const quiet = { log: () => { }, error: () => { } };
const dir = mkdtempSync(join(tmpdir(), 'fgc-sel-'));
const file = join(dir, 'epic-games-selectors.json');
writeFileSync(file, JSON.stringify({ product: { title: ['h2'] } }));
const loaded = await loadSelectors({ url: 'http://127.0.0.1:9/nope.json', file, timeoutMs: 500, log: quiet });
assert.deepEqual(loaded.product.title, ['h2']);
assert.deepEqual(loaded.login, BUNDLED_SELECTORS.login);
writeFileSync(file, '{ not json');
const broken = await loadSelectors({ url: '0', file, log: quiet });
assert.deepEqual(broken, BUNDLED_SELECTORS);
const none = await loadSelectors({ url: undefined, file: join(dir, 'missing.json'), log: quiet });
assert.deepEqual(none, BUNDLED_SELECTORS);
console.log('selector tests passed');

// optional: check the remote file that running containers will pick up
if (process.argv[2]) {
  const remote = await loadSelectors({ url: process.argv[2], log: console });
  assert.equal(typeof remote.version, 'number');
}
