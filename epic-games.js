import { chromium } from 'patchright'; // patchright patches Chromium to bypass bot detection (captcha, Cloudflare)
import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { resolve, jsonDb, datetime, stealth, filenamify, prompt, notify, html_game_list, handleSIGINT, clearBrowserLock, writeLastRun, withRetry, generateFingerprint } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = 'https://store.epicgames.com/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;

console.log(datetime(), 'started checking epic-games');

const db = await jsonDb('epic-games.json', {});

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

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  // page.click('button:has-text("Accept All Cookies")').catch(_ => { }); // Not needed anymore since we set the cookie above. Clicking this did not always work since the message was animated in too slowly.

  while (await page.locator('egs-navigation').getAttribute('isloggedin') != 'true') {
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
      // await page.click('text=Sign in with Epic Games');
      page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
        console.error('Incorrect response for captcha!');
      }).catch(_ => { });
      await page.fill('#email', email);
      // Two-step login: click Continue after email, wait for password field
      const submitBtn = page.locator('button[type="submit"]');
      await submitBtn.waitFor({ state: 'visible' });
      await submitBtn.click({ delay: 111 });
      const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        await page.waitForSelector('#password', { state: 'visible' }).catch(_ => { });
        await page.fill('#password', password);
        const signInBtn = page.locator('button[type="submit"]');
        await signInBtn.waitFor({ state: 'visible' });
        await signInBtn.click({ delay: 111 });
      }
      const error = page.locator('#form-error-message');
      error.waitFor().then(async () => {
        console.error('Login error:', await error.innerText());
        console.log('Please login in the browser!');
      }).catch(_ => { });
      // Handle "Is this the right account?" confirmation prompt (PR #583)
      page.waitForSelector('button#yes, button[aria-label="Yes, continue"]', { timeout: 30000 }).then(async (btn) => {
        console.log('Got "Is this the right account?" prompt, clicking Yes...');
        await btn.click({ delay: 111 });
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL('**/id/login/mfa**').then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location. A security code has been sent to your email address at ...');
        // TODO locator for text (email or app?)
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.waitForTimeout(500);
        const otpBtn = page.locator('button[type="submit"]');
        await otpBtn.waitFor({ state: 'visible' });
        await otpBtn.click({ delay: 111 });
      }).catch(_ => { });
    }
    await page.waitForURL(URL_CLAIM);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('egs-navigation').getAttribute('displayname'); // 'null' if !isloggedin
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  // Detect free games
  let urls = [];
  
  // Try old HTML selector first (for backwards compatibility)
  const game_loc = page.locator('a:has(span:text-is("Free Now"))');
  try {
    await game_loc.last().waitFor({ timeout: 10000 });
    const urlSlugs = await Promise.all((await game_loc.elementHandles()).map(a => a.getAttribute('href')));
    urls = urlSlugs.filter(Boolean).map(s => 'https://store.epicgames.com' + s);
    console.log('Found free games via HTML selector:', urls);
  } catch (e) {
    console.log('HTML selector did not find games, trying Epic API...');
  }
  
  // Fallback: use Epic's API to detect free games (more reliable, works with UI changes)
  if (urls.length === 0) {
    try {
      const apiUrl = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
      const response = await page.evaluate(async (url) => {
        const res = await fetch(url);
        return res.json();
      }, apiUrl);
      
      const elements = response.data?.Catalog?.searchStore?.elements || [];
      console.log(`API returned ${elements.length} games, filtering for current promotions...`);
      
      for (const game of elements) {
        const promotions = game.promotions?.promotionalOffers;
        if (promotions && promotions.length > 0 && promotions[0].promotionalOffers?.length > 0) {
          // Get the URL slug - prefer pageSlug from mappings, fallback to urlSlug
          const slug = game.catalogNs?.mappings?.[0]?.pageSlug || game.urlSlug;
          if (slug) {
            const url = `https://store.epicgames.com/en-US/p/${slug}`;
            if (!urls.includes(url)) urls.push(url);
          }
        }
      }
      console.log('Found free games via API:', urls);
    } catch (e) {
      console.error('Failed to fetch free games from API:', e.message);
    }
  }
  
  if (urls.length === 0) {
    console.error('No free games found. There may be no free games available in your region, or Epic changed their UI again.');
  }

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    await withRetry(`goto ${url}`, () => page.goto(url), { retries: 3, delayMs: 15000 });
    const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').filter({ hasText: /[ei]/i }); // when loading, the button text is empty -> need to wait for some text {'get', 'in library', 'requires base game'} -> just wait for e or i to not be too specific; >> selector was deprecated in Playwright - https://github.com/vogler/free-games-claimer/issues/375
    await purchaseBtn.waitFor();
    const btnText = (await purchaseBtn.innerText()).toLowerCase(); // barrier to block until page is loaded

    // click Continue if 'This game contains mature content recommended only for ages 18+'
    if (await page.locator('button:has-text("Continue")').count() > 0) {
      console.log('  This game contains mature content recommended only for ages 18+');
      if (await page.locator('[data-testid="AgeSelect"]').count()) {
        console.error('  Got "To continue, please provide your date of birth" - This shouldn\'t happen due to cookie set above. Please report to https://github.com/vogler/free-games-claimer/issues/275');
        await page.locator('#month_toggle').click();
        await page.locator('#month_menu li:has-text("01")').click();
        await page.locator('#day_toggle').click();
        await page.locator('#day_menu li:has-text("01")').click();
        await page.locator('#year_toggle').click();
        await page.locator('#year_menu li:has-text("1987")').click();
      }
      await page.click('button:has-text("Continue")', { delay: 111 });
      await page.waitForTimeout(2000);
    }

    let title;
    let bundle_includes;
    if (await page.locator('span:text-is("About Bundle")').count()) {
      title = (await page.locator('span:has-text("Buy"):left-of([data-testid="purchase-cta-button"])').first().innerText()).replace('Buy ', '');
      // h1 first didn't exist for bundles but now it does... However h1 would e.g. be 'Fallout® Classic Collection' instead of 'Fallout Classic Collection'
      try {
        bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
      } catch (e) {
        console.error('Failed to get "Bundle Includes":', e);
      }
    } else {
      title = await page.locator('h1').first().innerText();
    }
    const game_id = page.url().split('/').pop();
    const existedInDb = db.data[user][game_id];
    db.data[user][game_id] ||= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
    console.log('Current free game:', chalk.blue(title));
    if (bundle_includes) console.log('  This bundle includes:', bundle_includes);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game); // status is updated below

    if (btnText == 'in library') {
      console.log('  Already in library! Nothing to claim.');
      if (!existedInDb) await notify(`Game already in library: ${url}`);
      notify_game.status = 'existed';
      db.data[user][game_id].status ||= 'existed'; // does not overwrite claimed or failed
      if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual'; // was failed but now it's claimed
    } else if (btnText == 'requires base game') {
      console.log('  Requires base game! Nothing to claim.');
      notify_game.status = 'requires base game';
      db.data[user][game_id].status ||= 'failed:requires-base-game';
      // TODO claim base game if it is free
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      console.log('  Base game:', baseUrl);
      // await page.click('a:has-text("Overview")');
      // TODO handle this via function call for base game above since this will never terminate if DRYRUN=1
      urls.push(baseUrl); // add base game to the list of games to claim
      urls.push(url); // add add-on itself again
    } else { // GET
      console.log('  Not in library yet! Click', btnText);
      await purchaseBtn.click({ delay: 11 }); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      page.click('button:has-text("Continue")').catch(_ => { }); // needed since change from Chromium to Firefox?

      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      page.click('button:has-text("Yes, buy now")').catch(_ => { });

      // Accept End User License Agreement (only needed once)
      page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
        console.log('  Accept End User License Agreement (only needed once)');
        console.log(await page.innerHTML('body'));
        console.log('Please report the HTML above here: https://github.com/vogler/free-games-claimer/issues/371');
        await page.locator('input#agree').check(); // TODO Bundle: got stuck here; likely unrelated to bundle and locator just changed: https://github.com/vogler/free-games-claimer/issues/371
        await page.locator('button:has-text("Accept")').click();
      }).catch(_ => { });

      // it then creates an iframe for the purchase
      await page.waitForSelector('#webPurchaseContainer iframe'); // TODO needed?
      const iframe = page.frameLocator('#webPurchaseContainer iframe');
      // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
      if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
        console.error('  This product is unavailable in your region!');
        db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      iframe.locator('.payment-pin-code').waitFor().then(async () => {
        if (!cfg.eg_parentalpin) {
          console.error('  EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
          notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
        }
        await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
        await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
      }).catch(_ => { });

      if (cfg.debug) await page.pause();
      if (cfg.dryrun) {
        console.log('  DRYRUN=1 -> Skip order!');
        notify_game.status = 'skipped';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      // Playwright clicked before button was ready to handle event, https://github.com/vogler/free-games-claimer/issues/84#issuecomment-1474346591
      await iframe.locator('button:has-text("Place Order"):not(:has(.payment-loading--loading))').click({ delay: 11 });

      // I Agree button is only shown for EU accounts! https://github.com/vogler/free-games-claimer/pull/7#issuecomment-1038964872
      const btnAgree = iframe.locator('button:has-text("I Accept")');
      btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { }); // EU: wait for and click 'I Agree'
      try {
        // context.setDefaultTimeout(100 * 1000); // give time to solve captcha, iframe goes blank after 60s?
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => { // don't await, since element may not be shown
          // console.info('  Got hcaptcha challenge! NopeCHA extension will likely solve it.')
          console.error('  Got hcaptcha challenge! Lost trust due to too many login attempts? You can solve the captcha in the browser or get a new IP address.');
          // await notify(`epic-games: got captcha challenge right before claim of <a href="${url}">${title}</a>. Use VNC to solve it manually.`); // TODO not all apprise services understand HTML: https://github.com/vogler/free-games-claimer/pull/417
          await notify(`epic-games: got captcha challenge for.\nGame link: ${url}`);
          // TODO could even create purchase URL, see https://github.com/vogler/free-games-claimer/pull/130
          // await page.waitForTimeout(2000);
          // const p = path.resolve(cfg.dir.screenshots, 'epic-games', 'captcha', `${filenamify(datetime())}.png`);
          // await captcha.screenshot({ path: p });
          // console.info('  Saved a screenshot of hcaptcha challenge to', p);
          // console.error('  Got hcaptcha challenge. To avoid it, get a link from https://www.hcaptcha.com/accessibility'); // TODO save this link in config and visit it daily to set accessibility cookie to avoid captcha challenge?
        }).catch(_ => { }); // may time out if not shown
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          console.error('  Failed to challenge captcha, please try again later.');
          await notify('epic-games: failed to challenge captcha. Please check.');
        }).catch(_ => { });
        await page.locator('text=Thanks for your order!').waitFor({ state: 'attached' }); // TODO Bundle: got stuck here, but normal game now as well
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
        console.log('  Claimed successfully!');
        // context.setDefaultTimeout(cfg.timeout);
      } catch (e) {
        console.log(e);
        // console.error('  Failed to claim! Try again if NopeCHA timed out. Click the extension to see if you ran out of credits (refill after 24h). To avoid captchas try to get a new IP or set a cookie from https://www.hcaptcha.com/accessibility');
        console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
        const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
        await page.screenshot({ path: p, fullPage: true });
        db.data[user][game_id].status = 'failed';
      }
      notify_game.status = db.data[user][game_id].status; // claimed or failed

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
    }
    if (cfg.time) console.timeEnd('claim game');
  }
  if (cfg.time) console.timeEnd('claim all games');
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write(); // write out json db
  writeLastRun('epic-games');
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) { // don't notify if all have status 'existed', 'manual', 'requires base game', 'unavailable-in-region', 'skipped'
    notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
