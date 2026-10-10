import { chromium } from 'patchright'; // patchright patches Chromium to bypass bot detection (captcha, Cloudflare)
import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, jsonDb, datetime, stealth, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT, clearBrowserLock, writeLastRun, withRetry, generateFingerprint, dataDir } from './src/util.js';
import { cfg } from './src/config.js';
import { getMobileGames } from './src/epic-games-mobile.js';
import { freeGamesFromJson, URL_STORE, URL_FREE_GAMES_API } from './src/epic-games-free.js';
import { loadSelectors, anyOf } from './src/epic-games-selectors.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = URL_STORE + '/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;

console.log(datetime(), 'started checking epic-games');

const db = await jsonDb('epic-games.json', {});

// Locators are data, not code: bundled json <- EG_SELECTORS_URL <- data/epic-games-selectors.json, see src/epic-games-selectors.js
const S = await loadSelectors({ url: cfg.eg_selectors_url, file: dataDir('epic-games-selectors.json') });
const $ = (scope, sel) => anyOf(scope, sel); // one locator matching any of the candidate selectors

// Fetch free games from node (no browser involved, so this also works when the store page itself is behind a Cloudflare challenge).
// Falls back to fetching from inside the page (uses the browser's IP/cookies) if the direct request fails.
const getFreeGames = async page => {
  try {
    const res = await fetch(URL_FREE_GAMES_API, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return freeGamesFromJson(await res.json());
  } catch (e) {
    console.error('Failed to fetch free games JSON from node:', e.message, '- trying from inside the browser...');
  }
  const body = await page.evaluate(url => fetch(url).then(r => r.json()), URL_FREE_GAMES_API);
  return freeGamesFromJson(body);
};

// Cloudflare (used by store.epicgames.com since 2025) sometimes shows a challenge page, e.g. for datacenter/VPN IPs or when headless.
const isCloudflareChallenge = async page => {
  const title = await page.title().catch(_ => '');
  if (new RegExp(S.cloudflareTitle, 'i').test(title)) return true;
  return await $(page, S.cloudflareText).count().catch(_ => 0) > 0;
};
class CloudflareError extends Error {}

// Save what the page looked like when a step failed: screenshot + HTML + the visible buttons. Makes fixing the selectors a 1-minute job instead of guesswork.
const dumpDiagnostics = async (page, name) => {
  const dir = screenshot('debug');
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${filenamify(name)}_${filenamify(datetime())}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(_ => { });
    writeFileSync(`${base}.html`, await page.content().catch(_ => ''));
    const buttons = await page.evaluate(() => [...document.querySelectorAll('button, a[role="button"]')] // eslint-disable-line no-undef
      .filter(b => b.offsetParent !== null)
      .map(b => `${b.textContent.trim().slice(0, 40)}${b.dataset.testid ? ` [data-testid=${b.dataset.testid}]` : ''}`)
      .filter(Boolean)).catch(_ => []);
    console.error(`  Saved diagnostics to ${base}.{png,html}. Visible buttons: ${JSON.stringify(buttons)}`);
    console.error('  If Epic changed the page, adjust the selector in data/epic-games-selectors.json (see README) - no rebuild needed.');
  } catch (e) {
    console.error('  Failed to save diagnostics:', e.message);
  }
};

if (cfg.time) console.time('startup');

clearBrowserLock(cfg.dir.browser);

const fp = generateFingerprint(cfg.width, cfg.height);

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  userAgent: fp.fingerprint.navigator.userAgent,
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/eg-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  args: [
    '--disable-blink-features=AutomationControlled', // extra stealth on top of patchright patches
  ],
});

handleSIGINT(context);

// Without stealth plugin, the website shows an hcaptcha on login with username/password and in the last step of claiming a game. It may have other heuristics like unsuccessful logins as well. After <6h (TBD) it resets to no captcha again. Getting a new IP also resets.
await stealth(context, fp);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
if (cfg.headless) console.warn('Running headless (SHOW=0). Epic/Cloudflare are more likely to show captchas or block headless browsers - use SHOW=1 if you run into problems.');

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it

// some debug info about the page (screen dimensions, user agent, platform)
// eslint-disable-next-line no-undef
if (cfg.debug) console.debug(await page.evaluate(() => [(({ width, height, availWidth, availHeight }) => ({ width, height, availWidth, availHeight }))(window.screen), navigator.userAgent, navigator.platform, navigator.vendor])); // deconstruct screen needed since `window.screen` prints {}, `window.screen.toString()` '[object Screen]', and can't use some pick function without defining it on `page`
if (cfg.debug_network) {
  // const filter = _ => true;
  const filter = r => r.url().includes('store.epicgames.com');
  page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
  page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
let user;

// The store's web component <egs-navigation> tells us if we are logged in. It is missing on error pages (Cloudflare challenge, 404, maintenance).
const nav = $(page, S.nav).first();
const waitForNav = async () => {
  if (await nav.count()) return;
  await nav.waitFor({ state: 'attached' }).catch(async e => {
    if (await isCloudflareChallenge(page)) {
      console.error('Got a Cloudflare challenge ("Just a moment..." / "One more step") instead of the store page!');
      console.error('Epic blocks this IP/browser as a bot. Solve the challenge in the browser (noVNC), use a residential IP (no datacenter/VPN) and run with SHOW=1.');
      await notify('epic-games: got Cloudflare challenge. Solve it in the browser or get a new IP address.');
      if (!cfg.headless) { // give the user some time to solve the challenge manually
        console.info(`Waiting ${cfg.login_timeout / 1000} seconds for the challenge to be solved...`);
        await nav.waitFor({ state: 'attached', timeout: cfg.login_timeout }).catch(_ => { });
        if (await nav.count()) return;
      }
      throw new CloudflareError('Blocked by Cloudflare challenge on store.epicgames.com');
    }
    console.error('Store page did not load properly (no <egs-navigation>). Page title:', await page.title().catch(_ => '?'), 'URL:', page.url());
    await dumpDiagnostics(page, 'no-navigation');
    throw e;
  });
};

const login = async () => {
  while (await nav.getAttribute(S.navLoggedInAttr) != 'true') {
    console.error('Not signed in anymore. Please login in the browser or here in the terminal.');
    if (cfg.novnc_port) console.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const notifyBrowserLogin = async () => {
      console.log('Waiting for you to login in the browser.');
      await notify('epic-games: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node epic-games` to login in the opened browser.');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    };
    const email = cfg.eg_email || await prompt({ message: 'Enter email' });
    if (!email) await notifyBrowserLogin();
    else {
      $(page, S.login.captcha).waitFor().then(async () => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      $(page, S.login.captchaIncorrect).waitFor().then(() => console.error('Incorrect response for captcha!')).catch(_ => { });
      await $(page, S.login.email).first().fill(email);
      // Two-step login: click Continue after email, wait for password field. Epic switched between one and two steps several times, so the selectors match both.
      const submitBtn = $(page, S.login.continue).first();
      await submitBtn.waitFor({ state: 'visible' });
      await submitBtn.click({ delay: 111 });
      const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        const pw = $(page, S.login.password).first();
        await pw.waitFor({ state: 'visible' }).catch(_ => { });
        await pw.fill(password);
        const signInBtn = $(page, S.login.signIn).first();
        await signInBtn.waitFor({ state: 'visible' });
        await signInBtn.click({ delay: 111 });
      }
      const error = $(page, S.login.error).first();
      error.waitFor().then(async () => {
        console.error('Login error:', await error.innerText());
        console.log('Please login in the browser!');
      }).catch(_ => { });
      // Handle "Is this the right account?" confirmation prompt (PR #583)
      $(page, S.login.confirmAccount).first().waitFor({ timeout: 30000 }).then(async () => {
        console.log('Got "Is this the right account?" prompt, clicking Yes...');
        await $(page, S.login.confirmAccount).first().click({ delay: 111 });
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL(S.login.mfaUrl).then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location. A security code has been sent to your email address at ...');
        // TODO locator for text (email or app?)
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await $(page, S.login.mfaCode).first().pressSequentially(otp.toString());
        await page.waitForTimeout(500);
        const otpBtn = $(page, S.login.mfaSubmit).first();
        await otpBtn.waitFor({ state: 'visible' });
        await otpBtn.click({ delay: 111 });
      }).catch(_ => { });
    }
    await page.waitForURL(URL_CLAIM);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
    await waitForNav();
  }
};

// Detect free games via Epic's JSON. The old approach of scraping `a:has(span:text-is("Free Now"))` broke every time Epic redesigned the page (and gave 404s for a while), so it's only a fallback now.
const detectFreeGames = async () => {
  let games = [];
  try {
    games = await getFreeGames(page);
    console.log('Found free games via JSON:', games.map(g => g.url));
  } catch (e) {
    console.error('Failed to fetch free games from JSON:', e.message);
  }
  if (!games.length) {
    console.log('JSON did not return any free games, trying HTML selector on the free-games page...');
    if (!page.url().startsWith(URL_CLAIM)) await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
    const game_loc = $(page, S.freeNowLinks);
    await game_loc.last().waitFor({ timeout: 10000 }).catch(_ => { });
    const hrefs = await Promise.all((await game_loc.all()).map(a => a.getAttribute('href')));
    const urls = [...new Set(hrefs.filter(Boolean).map(s => s.startsWith('http') ? s : URL_STORE + s))];
    games = urls.map(url => ({ url }));
    console.log('Found free games via HTML selector:', urls);
  }
  if (!games.length) console.error('Seems like currently there are no free games available in your region...'); // see https://github.com/vogler/free-games-claimer/issues/210#issuecomment-1727420943

  // Free mobile games (Android/iOS), https://github.com/vogler/free-games-claimer/issues/474 - opt-in via EG_MOBILE=1
  if (cfg.eg_mobile) {
    console.log('Including mobile games (EG_MOBILE=1)...');
    try {
      const mobileGames = await getMobileGames(context);
      console.log('Free mobile games:', mobileGames);
      games.push(...mobileGames.filter(m => !games.some(g => g.url == m.url)));
    } catch (e) {
      console.error('Failed to get mobile games:', e.message);
    }
  }
  return games;
};

// The checkout form - either inside the iframe on the product page or the standalone purchase page (direct checkout fallback).
// Returns the final status: 'claimed', 'skipped', 'unavailable-in-region', 'existed' or 'failed'.
const checkout = async (scope, game, url) => {
  const order = $(scope, S.checkout.placeOrder);
  // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
  if (await $(scope, S.checkout.regionError).count() > 0) {
    console.error('  This product is unavailable in your region!');
    return 'unavailable-in-region';
  }
  $(scope, S.checkout.pin).first().waitFor().then(async () => {
    if (!cfg.eg_parentalpin) {
      console.error('  EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
      notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
    }
    await $(scope, S.checkout.pinInput).first().pressSequentially(cfg.eg_parentalpin);
    await $(scope, S.checkout.pinContinue).first().click({ delay: 11 });
  }).catch(_ => { });

  // wait for the order button; on the standalone purchase page an owned game shows a notice instead
  try {
    await order.first().waitFor();
  } catch (e) {
    if (await $(scope, S.checkout.alreadyOwned).count() > 0) {
      console.log('  Already in library! Nothing to claim.');
      return 'existed';
    }
    throw e;
  }

  if (cfg.debug) await page.pause();
  if (cfg.dryrun) {
    console.log('  DRYRUN=1 -> Skip order!');
    return 'skipped';
  }
  if (cfg.interactive && !await confirm()) {
    console.log('  Skipped by user.');
    return 'skipped';
  }

  // Playwright clicked before button was ready to handle event, https://github.com/vogler/free-games-claimer/issues/84#issuecomment-1474346591
  // Button was renamed from "Place Order" to "Add to library" in 2025, selectors match both.
  await order.first().click({ delay: 11 });

  // I Agree button is only shown for EU accounts! https://github.com/vogler/free-games-claimer/pull/7#issuecomment-1038964872
  const btnAgree = $(scope, S.checkout.accept).first();
  btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { }); // EU: wait for and click 'I Agree'
  $(scope, S.checkout.captcha).first().waitFor().then(async () => { // don't await, since element may not be shown
    console.error('  Got hcaptcha challenge! Lost trust due to too many login attempts? You can solve the captcha in the browser or get a new IP address.');
    await notify(`epic-games: got captcha challenge for ${game.title ?? url}.\nGame link: ${url}`);
  }).catch(_ => { }); // may time out if not shown
  $(scope, S.checkout.captchaFailed).first().waitFor().then(async () => {
    console.error('  Failed to challenge captcha, please try again later.');
    await notify('epic-games: failed to challenge captcha. Please check.');
  }).catch(_ => { });
  // Success text changed several times: "Thanks for your order!" -> "It's all yours" -> "Download the Epic Games Launcher to play" -> "Is Epic Games Launcher installed?"
  // The confirmation may be rendered in the checkout frame or in the surrounding page, so look in both.
  await Promise.any([$(page, S.checkout.success), ...scope === page ? [] : [$(scope, S.checkout.success)]].map(l => l.first().waitFor({ state: 'attached' })));
  console.log('  Claimed successfully!');
  return 'claimed';
};

// Record the outcome of a checkout in the db entry and the notification. 'existed' never overwrites 'claimed'/'failed' (a failed game that is now in the library was claimed manually).
const applyStatus = (game, notify_game, status) => {
  notify_game.status = status;
  if (status == 'existed') {
    game.status ??= 'existed';
    if (game.status.startsWith('failed')) game.status = 'manual';
  } else {
    game.status = status;
    if (status == 'claimed') game.time = datetime(); // claimed time overwrites failed/dryrun time
  }
};

// Claim one game. Never throws for a single broken game (except Cloudflare blocks), so the other games are still processed.
const claimGame = async (gameInfo, games) => {
  const { url } = gameInfo;
  const game_id = url.split('/').pop();
  let game = db.data[user][game_id]; // undefined for new game, set below
  if (game?.status == 'claimed') { // no need to load the page again (and risk a captcha) for a game this user already claimed
    console.log('Already claimed, skipping:', url);
    notify_games.push({ title: game.title, url, status: 'existed' });
    return;
  }
  const notify_game = { title: gameInfo.title ?? game_id, url, status: 'failed' };
  notify_games.push(notify_game); // status is updated below
  const existedInDb = Boolean(game);
  try {
    await withRetry(`goto ${url}`, () => page.goto(url), { retries: 3, delayMs: 15000 });
    if (await isCloudflareChallenge(page)) throw new CloudflareError(`Blocked by Cloudflare challenge on ${url}`);

    // when loading, the button text is empty or 'Loading' -> need to wait for some text {'get', 'in library', 'requires base game'} -> wait for e or i to not be too specific - https://github.com/vogler/free-games-claimer/issues/375
    const purchaseBtn = $(page, S.product.cta).first();
    const ctaReady = async () => {
      const t = (await purchaseBtn.innerText({ timeout: 1000 }).catch(_ => '')).trim();
      return (/[ei]/i).test(t) && !new RegExp(S.product.ctaLoading, 'i').test(t);
    };
    let btnText = null;
    const deadline = Date.now() + cfg.timeout;
    while (Date.now() < deadline) {
      if (await ctaReady()) {
        btnText = (await purchaseBtn.innerText()).toLowerCase().trim(); break;
      }
      await page.waitForTimeout(250);
    }

    let title = gameInfo.title;
    if (btnText === null) {
      // Product page changed (or didn't load). Fallback: Epic's standalone checkout URL built from the offer's namespace + id, which doesn't depend on the product page's markup at all.
      console.error('  Could not find the purchase button on the product page.');
      await dumpDiagnostics(page, `${game_id}_no-cta`);
      if (!gameInfo.namespace || !gameInfo.id) throw new Error('Purchase button not found and no offer id for direct checkout');
      const purchaseUrl = S.purchaseUrl.replace('{namespace}', gameInfo.namespace).replace('{id}', gameInfo.id);
      console.log('  Trying direct checkout:', purchaseUrl);
      await page.goto(purchaseUrl);
      game = db.data[user][game_id] ??= { title, time: datetime(), url };
      console.log('Current free game:', chalk.blue(title));
      applyStatus(game, notify_game, await checkout(page, gameInfo, url));
      return;
    }

    // click Continue if 'This game contains mature content recommended only for ages 18+'
    if (await $(page, S.product.matureContinue).count() > 0) {
      console.log('  This game contains mature content recommended only for ages 18+');
      if (await $(page, S.product.ageSelect).count()) {
        console.error('  Got "To continue, please provide your date of birth" - This shouldn\'t happen due to cookie set above. Please report to https://github.com/vogler/free-games-claimer/issues/275');
        await page.locator(S.product.ageMonth).click();
        await page.locator(S.product.ageMonthItem).click();
        await page.locator(S.product.ageDay).click();
        await page.locator(S.product.ageDayItem).click();
        await page.locator(S.product.ageYear).click();
        await page.locator(S.product.ageYearItem).click();
      }
      await $(page, S.product.matureContinue).first().click({ delay: 111 });
      await page.waitForTimeout(2000);
    }

    let bundle_includes;
    if (await $(page, S.product.bundleMarker).count()) {
      title = (await $(page, S.product.bundleTitle).first().innerText().catch(_ => title ?? '')).replace('Buy ', '') || title;
      // h1 first didn't exist for bundles but now it does... However h1 would e.g. be 'Fallout® Classic Collection' instead of 'Fallout Classic Collection'
      bundle_includes = await Promise.all((await $(page, S.product.bundleIncludes).all()).map(b => b.innerText())).catch(e => console.error('Failed to get "Bundle Includes":', e.message));
    } else {
      title = await $(page, S.product.title).first().innerText({ timeout: 5000 }).catch(_ => title) || title || game_id;
    }
    game = db.data[user][game_id] ??= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
    notify_game.title = title;
    console.log('Current free game:', chalk.blue(title));
    if (bundle_includes) console.log('  This bundle includes:', bundle_includes);

    if (btnText == S.product.ctaInLibrary) {
      console.log('  Already in library! Nothing to claim.');
      if (!existedInDb) await notify(`Game already in library: ${url}`);
      notify_game.status = 'existed';
      game.status ??= 'existed'; // does not overwrite claimed or failed
      if (game.status.startsWith('failed')) game.status = 'manual'; // was failed but now it's claimed
    } else if (btnText == S.product.ctaRequiresBaseGame) {
      console.log('  Requires base game! Nothing to claim.');
      notify_game.status = 'requires base game';
      game.status ??= 'failed:requires-base-game';
      const baseHref = await $(page, S.product.baseGameLink).first().getAttribute('href').catch(_ => null);
      const baseUrl = baseHref && (baseHref.startsWith('http') ? baseHref : URL_STORE + baseHref);
      if (baseUrl && !games.some(g => g.url == baseUrl)) {
        console.log('  Base game:', baseUrl);
        games.push({ url: baseUrl }); // add base game to the list of games to claim
        games.push(gameInfo); // add add-on itself again (once, after the base game)
      } else {
        console.error('  Could not find the base game or it was already processed. Please claim the base game manually.');
      }
    } else { // GET
      console.log('  Not in library yet! Click', btnText);
      await purchaseBtn.click({ delay: 11 }); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      $(page, S.product.deviceContinue).first().click().catch(_ => { });
      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      $(page, S.product.buyAnyway).first().click().catch(_ => { });
      // Accept End User License Agreement (only needed once)
      $(page, S.product.eulaText).first().waitFor().then(async () => {
        console.log('  Accept End User License Agreement (only needed once)');
        await $(page, S.product.eulaAgree).first().check();
        await $(page, S.product.eulaAccept).first().click();
      }).catch(_ => { });

      // it then creates an iframe for the purchase
      await $(page, S.checkout.iframe).first().waitFor();
      const scope = page.frameLocator([].concat(S.checkout.iframe).join(', ')); // FrameLocator has no .or(), but a CSS selector list works
      applyStatus(game, notify_game, await checkout(scope, gameInfo, url));
    }
  } catch (e) {
    if (e instanceof CloudflareError) throw e; // the other games will be blocked as well
    console.error(`  Failed to claim ${url}:`, e.message?.split('\n')[0]);
    console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
    await dumpDiagnostics(page, `${game_id}_failed`);
    game = db.data[user][game_id] ??= { title: notify_game.title, time: datetime(), url };
    game.status = notify_game.status = 'failed';
  } finally {
    const p = screenshot(`${game_id}.png`);
    if (p && !existsSync(p) && notify_game.status != 'failed') await page.screenshot({ path: p, fullPage: false }).catch(_ => { }); // fullPage is quite long...
  }
};

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  // page.click('button:has-text("Accept All Cookies")').catch(_ => { }); // Not needed anymore since we set the cookie above. Clicking this did not always work since the message was animated in too slowly.
  $(page, S.privacyContinue).first().click({ timeout: 5000 }).catch(_ => { }); // already logged in, but need to accept updated "Epic Games Privacy Policy" - short timeout so this doesn't click a Continue button on the login page later

  await waitForNav();
  await login();
  user = await nav.getAttribute(S.navUserAttr); // 'null' if !isloggedin
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  const games = await detectFreeGames();
  for (const gameInfo of games) { // games may grow while iterating (base game of an add-on)
    if (cfg.time) console.time('claim game');
    await claimGame(gameInfo, games);
    if (cfg.time) console.timeEnd('claim game');
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
  if (cfg.time) console.timeEnd('claim all games');
  await db.write(); // write out json db
  writeLastRun('epic-games');
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) { // don't notify if all have status 'existed', 'manual', 'requires base game', 'unavailable-in-region', 'skipped'
    notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
