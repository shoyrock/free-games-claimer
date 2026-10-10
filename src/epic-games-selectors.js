// Locators for epic-games.js live in epic-games-selectors.json so that a redesign of the Epic Games Store can be fixed
// without touching code - and even without rebuilding the Docker image:
//   1. bundled src/epic-games-selectors.json (shipped with this version)
//   2. EG_SELECTORS_URL (default: that file on the main branch of this repo; set to 0 to disable) - applied if its version >= bundled
//   3. data/epic-games-selectors.json - local hot-fix, always applied last
// Entries may be a single Playwright selector or a list of candidates. anyOf() turns a list into one locator that matches
// whichever candidate exists (locator.or), so old and new markup can be supported at the same time.
import { readFileSync, existsSync } from 'node:fs';

export const BUNDLED_SELECTORS = JSON.parse(readFileSync(new URL('./epic-games-selectors.json', import.meta.url), 'utf8'));

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep merge: nested objects are merged, everything else (strings, arrays) is replaced by the override.
export const mergeSelectors = (base, override) => {
  if (!isObject(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObject(v) && isObject(base[k]) ? mergeSelectors(base[k], v) : v;
  }
  return out;
};

export const loadSelectors = async ({ url, file, timeoutMs = 5000, log = console } = {}) => {
  let selectors = structuredClone(BUNDLED_SELECTORS);
  const sources = ['bundled'];
  if (url && url !== '0') {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = await res.json();
      if (!isObject(remote) || typeof remote.version !== 'number') throw new Error('not a selectors file');
      if (remote.version < BUNDLED_SELECTORS.version) {
        log.log(`Remote selectors (v${remote.version}) are older than bundled (v${BUNDLED_SELECTORS.version}), ignoring ${url}`);
      } else {
        selectors = mergeSelectors(selectors, remote);
        sources.push(`remote v${remote.version}`);
      }
    } catch (e) {
      log.error(`Could not load remote selectors from ${url}: ${e.message} - using bundled ones.`);
    }
  }
  if (file && existsSync(file)) {
    try {
      selectors = mergeSelectors(selectors, JSON.parse(readFileSync(file, 'utf8')));
      sources.push(`local override ${file}`);
    } catch (e) {
      log.error(`Could not parse local selectors override ${file}: ${e.message}`);
    }
  }
  log.log('Selectors:', sources.join(' + '));
  return selectors;
};

// One locator that matches any of the candidate selectors. scope is a Page, Frame, FrameLocator or Locator.
export const anyOf = (scope, candidates) => {
  const list = [].concat(candidates).filter(Boolean);
  if (!list.length) throw new Error('anyOf: no selectors given');
  return list.slice(1).reduce((loc, s) => loc.or(scope.locator(s)), scope.locator(list[0]));
};
