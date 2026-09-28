// Unit/integration tests for the site's only script, `script.js`.
//
// `script.js` is a classic browser script: it reads DOM elements at load time and
// talks to `localStorage`, `navigator.geolocation`, `fetch`, the timers and
// `Date`. It is not a module, so nothing can be imported — the tests therefore
// boot the *real* `index.html` (parsed by jsdom, so every element the script looks
// up must actually exist) inside an isolated VM context, inject the outside-world
// dependencies (timers, `fetch`, `navigator`, `Date`) and drive the script through
// the same entry points a browser uses: the `DOMContentLoaded` event, button
// clicks and the intervals the script registers itself.
//
// Run with `npm test`; measured by `npm run coverage` (c8).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const scriptPath = path.join(root, 'script.js');
const scriptSource = readFileSync(scriptPath, 'utf8');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

const THIRTY_MINUTES = 30 * 60 * 1000;

/** Lets pending promise chains (fetch → json → update) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A Response-alike for the injected `fetch`. */
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

/**
 * Boot `index.html` + `script.js` in an isolated VM context.
 *
 * @param {object} [options]
 * @param {string|null} [options.preference] Seed for `localStorage.locationPreference`.
 * @param {object|null} [options.geolocation] Injected `navigator.geolocation`; `null` = unsupported.
 * @param {(url: string) => Promise<object>} [options.fetchImpl] Injected HTTP client.
 * @param {() => number} [options.random] Value returned by `Math.random()`.
 * @param {Date} [options.now] Instant returned by the page's `new Date()`.
 */
function loadPage(options = {}) {
  const {
    preference = null,
    geolocation = null,
    fetchImpl = async () => {
      throw new Error('unexpected fetch');
    },
    random = () => 0.5,
    now = new Date('2026-09-27T09:05:00'),
  } = options;

  const dom = new JSDOM(html, { url: 'https://rubenbarels.nl/' });
  const { window } = dom;
  const document = window.document;
  if (preference !== null) window.localStorage.setItem('locationPreference', preference);

  // jsdom dispatches `DOMContentLoaded` itself, asynchronously, right after the
  // document is parsed. Watch for that exact event instead of dispatching a
  // second one, which would run `init()` twice.
  let parsed = false;
  const parsedListeners = [];
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      parsed = true;
      for (const listener of parsedListeners) listener();
    },
    { once: true },
  );

  const clock = { now };
  const intervals = [];
  const timeouts = [];
  const clearedIntervals = [];
  const requests = [];
  const logs = { log: [], warn: [], error: [] };

  const sandbox = {
    document,
    localStorage: window.localStorage,
    navigator: geolocation ? { geolocation } : {},
    fetch: (url) => {
      requests.push(String(url));
      return fetchImpl(String(url));
    },
    console: {
      log: (...args) => logs.log.push(args.map(String).join(' ')),
      warn: (...args) => logs.warn.push(args.map(String).join(' ')),
      error: (...args) => logs.error.push(args.map(String).join(' ')),
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: (id) => {
      clearedIntervals.push(id);
    },
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    // `new Date()` inside the page is what the clock reads; keep it controllable.
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length > 0 ? args : [clock.now.getTime()]));
      }
    },
    Math: Object.assign(Object.create(Math), { random: () => random() }),
  };

  const context = vm.createContext(sandbox, { name: 'rubenbarels.nl' });
  vm.runInContext(scriptSource, context, { filename: scriptPath });

  return {
    window,
    context,
    requests,
    logs,
    intervals,
    timeouts,
    clearedIntervals,
    /** Resolves once the document has been parsed and the script has initialised. */
    boot: () =>
      parsed
        ? Promise.resolve()
        : new Promise((resolve) => {
            parsedListeners.push(resolve);
          }),
    /** Moves the page's clock; the next tick renders the new instant. */
    setNow: (date) => {
      clock.now = date;
    },
    element: (id) => document.getElementById(id),
    text: (id) => document.getElementById(id).textContent,
    /** The click a browser would deliver on a button. */
    click: (id) => document.getElementById(id).click(),
    bodyClass: () => document.body.className,
    particles: () => [...document.getElementById('particles').children],
    particlesOfClass: (className) =>
      [...document.getElementById('particles').children].filter((particle) => particle.className === className),
    intervalsWithPeriod: (ms) => intervals.filter((interval) => interval.ms === ms),
    timeoutsWithDelay: (ms) => timeouts.filter((timeout) => timeout.ms === ms),
    ipLookups: () => requests.filter((url) => url.includes('ip-api.com')).length,
    fire(interval, times = 1) {
      for (let i = 0; i < times; i += 1) interval.fn();
    },
  };
}

/** A `navigator.geolocation` whose callbacks the test drives. */
function fakeGeolocation() {
  const calls = [];
  let success;
  let failure;
  return {
    calls,
    getCurrentPosition(onSuccess, onError) {
      calls.push(true);
      success = onSuccess;
      failure = onError;
    },
    succeed(latitude, longitude) {
      success({ coords: { latitude, longitude } });
    },
    fail(message) {
      failure({ message });
    },
  };
}

/** Answers the two HTTP endpoints `script.js` uses. */
function apiStub({
  ip = { status: 'success', city: 'Utrecht', lat: 52.09, lon: 5.12 },
  weather = { current: { temperature_2m: 12.6, weather_code: 61 } },
} = {}) {
  return async (url) => {
    if (url.includes('ip-api.com')) return jsonResponse(ip);
    if (url.includes('api.open-meteo.com')) return jsonResponse(weather);
    throw new Error(`unexpected request to ${url}`);
  };
}

test('index.html really provides every element script.js reaches for', () => {
  const ids = [...scriptSource.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 9, 'the page script must look up its indicators by id');
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no element with id="${id}"`);
  }
  assert.match(html, /<script src="script\.js"><\/script>/, 'index.html must load the measured script');
});

test('a first visit asks for the location and starts the clock', async () => {
  const page = loadPage();
  await page.boot();
  assert.equal(page.bodyClass(), 'weather-clear');
  assert.equal(page.element('location-prompt').classList.contains('hidden'), false, 'the prompt is opened for a new visitor');
  assert.deepEqual(page.requests, [], 'nothing is fetched before a location is known');
  assert.deepEqual(
    page.intervals.map((interval) => interval.ms),
    [THIRTY_MINUTES, 1000],
    'the 30 minute weather refresh and the 1 second clock tick must be registered',
  );
  assert.equal(page.text('clock-time'), '09:05', 'the clock renders the current time immediately');
  assert.equal(page.element('clock-icon').textContent, '🕘', 'the morning icon is used between 06:00 and 12:00');
});

test('a stored "allowed" preference goes straight to GPS without re-asking', async () => {
  const geolocation = fakeGeolocation();
  const page = loadPage({ preference: 'allowed', geolocation, fetchImpl: apiStub() });
  await page.boot();
  assert.equal(page.element('location-prompt').classList.contains('hidden'), true, 'a visitor who already chose is not asked again');
  assert.equal(geolocation.calls.length, 1, 'the stored permission is reused');
  assert.equal(page.text('weather-location'), 'Locatie ophalen...');
});

test('a stored "denied" preference uses the IP lookup', async () => {
  const page = loadPage({ preference: 'denied', fetchImpl: apiStub() });
  await page.boot();
  await flush();
  assert.equal(page.requests[0], 'http://ip-api.com/json/?lang=nl');
  assert.equal(page.text('weather-location'), 'Utrecht', 'the city from the IP lookup is shown');
});

test('the allow button stores the permission, hides the prompt and requests GPS', async () => {
  const geolocation = fakeGeolocation();
  const page = loadPage({ geolocation, fetchImpl: apiStub() });
  await page.boot();
  page.click('allow-location');
  assert.equal(page.window.localStorage.getItem('locationPreference'), 'allowed');
  assert.equal(page.element('location-prompt').classList.contains('hidden'), true, 'the prompt is dismissed');
  assert.equal(geolocation.calls.length, 1);
});

test('the deny button stores the refusal and falls back to IP geolocation', async () => {
  const page = loadPage({ fetchImpl: apiStub() });
  await page.boot();
  page.click('deny-location');
  assert.equal(page.window.localStorage.getItem('locationPreference'), 'denied');
  assert.equal(page.element('location-prompt').classList.contains('hidden'), true);
  await flush();
  assert.equal(page.requests[0], 'http://ip-api.com/json/?lang=nl');
});

test('a GPS fix drives both the weather request and the reverse geocode', async () => {
  const geolocation = fakeGeolocation();
  const page = loadPage({ preference: 'allowed', geolocation, fetchImpl: apiStub() });
  await page.boot();
  geolocation.succeed(52.37, 4.9);
  await flush();
  assert.equal(page.requests.length, 2, 'weather plus reverse geocode');
  assert.match(page.requests[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=52\.37&longitude=4\.9/);
  assert.equal(page.requests[1], 'http://ip-api.com/json/?lang=nl');
  assert.equal(page.logs.log[0], 'GPS location obtained: 52.37 4.9');
  assert.equal(page.text('weather-temp'), '13°C', '12.6°C is rounded');
  assert.equal(page.element('weather-icon').textContent, '🌧️');
  assert.equal(page.text('weather-location'), 'Utrecht');
  assert.equal(page.bodyClass(), 'weather-rain');
});

test('a denied GPS fix falls back to the IP lookup', async () => {
  const geolocation = fakeGeolocation();
  const page = loadPage({ preference: 'allowed', geolocation, fetchImpl: apiStub() });
  await page.boot();
  geolocation.fail('User denied Geolocation');
  await flush();
  assert.equal(page.logs.warn[0], 'GPS location failed: User denied Geolocation');
  assert.equal(page.requests[0], 'http://ip-api.com/json/?lang=nl');
});

test('a browser without geolocation support falls back to the IP lookup', async () => {
  const page = loadPage({ preference: 'allowed', fetchImpl: apiStub() });
  await page.boot();
  assert.equal(page.logs.warn[0], 'Geolocation not supported');
  assert.equal(page.requests[0], 'http://ip-api.com/json/?lang=nl');
});

test('a refused IP lookup falls back to Amsterdam instead of leaving the page blank', async () => {
  const page = loadPage({ preference: 'denied', fetchImpl: async () => jsonResponse({ status: 'fail' }) });
  await page.boot();
  await flush();
  assert.equal(page.text('weather-location'), 'Locatie onbekend');
  assert.match(page.logs.error[0], /IP geolocation error: Error: IP geolocation failed/);
  assert.match(page.requests[1], /latitude=52\.3676&longitude=4\.9041/, 'the default coordinates are used');
});

test('an unreachable IP lookup service is handled like a refusal', async () => {
  const page = loadPage({
    preference: 'denied',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  await page.boot();
  await flush();
  assert.equal(page.text('weather-location'), 'Locatie onbekend');
  assert.match(page.logs.error[0], /network down/);
});

test('a failing weather request shows the placeholder instead of a stale value', async () => {
  const page = loadPage({
    preference: 'denied',
    fetchImpl: async () => {
      throw new Error('open-meteo down');
    },
  });
  await page.boot();
  await flush();
  assert.equal(page.text('weather-temp'), '--°C');
  assert.match(page.logs.error.join('\n'), /Weather fetch error: Error: open-meteo down/);
});

test('a weather response without a current block leaves the indicator alone', async () => {
  const page = loadPage({ preference: 'denied', fetchImpl: apiStub({ weather: {} }) });
  await page.boot();
  await flush();
  assert.equal(page.text('weather-temp'), '--°C', 'the placeholder in index.html is untouched');
});

test('a reverse geocode failure falls back to the raw coordinates', async () => {
  const geolocation = fakeGeolocation();
  const page = loadPage({
    preference: 'allowed',
    geolocation,
    fetchImpl: async (url) => {
      if (url.includes('ip-api.com')) throw new Error('ip-api down');
      return jsonResponse({ current: { temperature_2m: 4, weather_code: 3 } });
    },
  });
  await page.boot();
  geolocation.succeed(52.37, 4.9);
  await flush();
  assert.equal(page.text('weather-location'), '52.4°, 4.9°');
  assert.match(page.logs.log.join('\n'), /Reverse geocode failed/);
  assert.equal(page.bodyClass(), 'weather-cloudy');
});

test('every weather family renders its own background and particle set', async () => {
  const cases = [
    { code: 0, from: 73, background: 'weather-clear', particle: 'sun-rays', count: 1 },
    { code: 1, background: 'weather-partly-cloudy', particle: 'cloud', count: 3 },
    { code: 3, background: 'weather-cloudy', particle: 'cloud', count: 6 },
    { code: 45, background: 'weather-fog', particle: 'cloud', count: 5 },
    { code: 61, background: 'weather-rain', particle: 'rain-drop', count: 10 },
    { code: 80, background: 'weather-showers', particle: 'rain-drop', count: 10 },
    { code: 73, background: 'weather-snow', particle: 'snowflake', count: 4 },
    { code: 95, background: 'weather-thunderstorm', particle: 'rain-drop', count: 14, extra: 'lightning' },
  ];

  for (const scenario of cases) {
    const page = loadPage({ random: () => 0.1 });
    await page.boot();
    // The page opens on a clear sky, so a "clear" case has to come from elsewhere.
    if (scenario.from !== undefined) page.context.updateBackground(scenario.from);
    page.context.updateBackground(scenario.code);

    assert.equal(page.bodyClass(), scenario.background, `weather code ${scenario.code}`);
    assert.equal(
      page.particlesOfClass(scenario.particle).length,
      scenario.count,
      `weather code ${scenario.code} must render ${scenario.count} ${scenario.particle}`,
    );
    if (scenario.extra) {
      assert.equal(page.particlesOfClass(scenario.extra).length, 1, `weather code ${scenario.code} must render ${scenario.extra}`);
    }
  }
});

test('an unknown weather code falls back to the clear sky', async () => {
  const page = loadPage({ random: () => 0.1 });
  await page.boot();
  page.context.updateWeatherDisplay(9, 1234);
  assert.equal(page.element('weather-icon').textContent, '☀️');
  assert.equal(page.text('weather-temp'), '9°C');
  assert.equal(page.element('weather-temp').title, 'Helder');
  page.context.updateBackground(1234);
  assert.equal(page.bodyClass(), 'weather-clear');
});

test('switching weather clears the previous particle set and its interval', async () => {
  const page = loadPage({ random: () => 0.1 });
  await page.boot();
  page.context.updateBackground(61); // rain
  assert.equal(page.intervalsWithPeriod(200).length, 1, 'rain runs on its own interval');
  assert.equal(page.particles().length, 10);

  page.context.updateBackground(73); // snow replaces the rain
  assert.equal(page.clearedIntervals.length, 1, 'the rain interval must be cleared');
  assert.equal(page.particles().length, 4, 'the rain drops are removed with the previous set');
  assert.equal(page.intervalsWithPeriod(500).length, 1, 'snow runs on its own interval');
});

test('rain and snow keep producing particles while their interval runs', async () => {
  const page = loadPage({ random: () => 0.1 });
  await page.boot();

  page.context.updateBackground(80); // showers
  const rainInterval = page.intervalsWithPeriod(200)[0];
  page.fire(rainInterval, 3);
  assert.equal(page.particles().length, 40, 'every tick adds another batch of drops');

  page.context.updateBackground(73); // snow
  const snowInterval = page.intervalsWithPeriod(500)[0];
  page.fire(snowInterval, 2);
  assert.equal(page.particles().length, 12);

  const rainDropRemoval = page.timeoutsWithDelay(2000);
  assert.equal(rainDropRemoval.length, 40, 'each drop removes itself after its animation');
  for (const timeout of rainDropRemoval) timeout.fn();
  assert.equal(page.particles().length, 12, 'only the snowflakes are left');

  for (const timeout of page.timeoutsWithDelay(8000)) timeout.fn();
  assert.equal(page.particles().length, 0);
});

test('lightning flashes on a high roll and stops after 300ms', async () => {
  let roll = 0.9;
  const page = loadPage({ random: () => roll });
  await page.boot();
  page.context.updateBackground(95); // thunderstorm adds the lightning element

  const lightning = page.particlesOfClass('lightning')[0];
  assert.ok(lightning, 'a thunderstorm adds a lightning element');

  const flashInterval = page.intervalsWithPeriod(2000)[0];
  page.fire(flashInterval);
  assert.equal(lightning.classList.contains('flash'), true);

  const clearFlash = page.timeoutsWithDelay(300);
  assert.equal(clearFlash.length, 1);
  clearFlash[0].fn();
  assert.equal(lightning.classList.contains('flash'), false);

  roll = 0.4; // below the 0.7 threshold: no flash
  page.fire(flashInterval);
  assert.equal(page.timeoutsWithDelay(300).length, 1, 'a low roll must not schedule a flash');
});

test('the clock shows the time and picks an icon for every part of the day', async () => {
  const page = loadPage({ now: new Date('2026-09-27T09:05:00') });
  await page.boot();
  const clockInterval = page.intervalsWithPeriod(1000)[0];
  const clockTime = page.element('clock-time');
  const clockIcon = page.element('clock-icon');

  assert.equal(clockTime.textContent, '09:05', 'the clock renders immediately on load');
  assert.equal(clockIcon.textContent, '🕘');

  const ticks = [
    { at: '2026-09-27T12:00:00', time: '12:00', icon: '🕐' },
    { at: '2026-09-27T14:30:00', time: '14:30', icon: '🕐' },
    { at: '2026-09-27T19:45:00', time: '19:45', icon: '🕕' },
    { at: '2026-09-27T23:10:00', time: '23:10', icon: '🌙' },
    { at: '2026-09-27T04:00:00', time: '04:00', icon: '🌙' },
    { at: '2026-09-27T10:05:00', time: '10:05', icon: '🕘' },
  ];

  for (const tick of ticks) {
    page.setNow(new Date(tick.at));
    page.fire(clockInterval);
    assert.equal(clockTime.textContent, tick.time, `clock at ${tick.at}`);
    assert.equal(clockIcon.textContent, tick.icon, `icon at ${tick.at}`);
  }
});

test('the location label falls back through region and country when no city is returned', async () => {
  const regionPage = loadPage({
    preference: 'denied',
    fetchImpl: apiStub({ ip: { status: 'success', city: '', regionName: 'Utrecht', lat: 52.09, lon: 5.12 } }),
  });
  await regionPage.boot();
  await flush();
  assert.equal(regionPage.text('weather-location'), 'Utrecht');

  const countryPage = loadPage({
    preference: 'denied',
    fetchImpl: apiStub({ ip: { status: 'success', city: '', regionName: '', country: 'Nederland', lat: 52.09, lon: 5.12 } }),
  });
  await countryPage.boot();
  await flush();
  assert.equal(countryPage.text('weather-location'), 'Nederland');

  const geolocation = fakeGeolocation();
  const gpsPage = loadPage({
    preference: 'allowed',
    geolocation,
    fetchImpl: apiStub({ ip: { status: 'success', city: '', regionName: '' } }),
  });
  await gpsPage.boot();
  geolocation.succeed(52.37, 4.9);
  await flush();
  assert.equal(gpsPage.text('weather-location'), 'Nederland', 'the reverse geocode falls back to the country name');
});

test('the 30 minute refresh re-reads the stored permission', async () => {
  const geolocation = fakeGeolocation();
  const page = loadPage({ preference: 'denied', geolocation, fetchImpl: apiStub() });
  await page.boot();
  await flush();
  assert.equal(page.ipLookups(), 1, 'the stored refusal starts on the IP lookup');
  const refresh = page.intervalsWithPeriod(THIRTY_MINUTES)[0];

  page.window.localStorage.setItem('locationPreference', 'allowed');
  page.fire(refresh);
  assert.equal(geolocation.calls.length, 1, 'granting the permission switches the refresh to GPS');

  page.window.localStorage.setItem('locationPreference', 'denied');
  page.fire(refresh);
  await flush();
  assert.equal(geolocation.calls.length, 1, 'revoking it stops using GPS');
  assert.equal(page.ipLookups(), 2, 'the refresh re-runs the IP lookup after the permission is revoked');
});
