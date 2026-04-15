import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import http from 'http'; // built-in, no extra deps

const exec = promisify(execCb);
let shouldRunNow = false;

const control = {
  forceStart: false,
  pauseTillClockHour: false,
  stop: false,
};

// Interruptible sleep: lets us "wake" the loop from the web UI
let _sleepTimer = null;
let _sleepResolver = null;
function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    _sleepResolver = resolve;
    _sleepTimer = setTimeout(() => {
      _sleepTimer = null;
      _sleepResolver = null;
      resolve();
    }, ms);
  });
}
function wakeLoopNow() {
  if (_sleepTimer) {
    clearTimeout(_sleepTimer);
    _sleepTimer = null;
  }
  if (_sleepResolver) {
    const r = _sleepResolver;
    _sleepResolver = null;
    r();
  }
}
// ---- Mini control server on port 3500 ----
const CONTROL_PORT = 3500;

const controlHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Unfollow Control</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 2rem; }
    h1 { margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(180px, 240px)); gap: 1rem; }
    button { padding: 0.9rem 1rem; font-size: 1rem; border-radius: 12px; border: 1px solid #ddd; cursor: pointer; }
    button:hover { filter: brightness(0.95); }
    .force { background: #eef6ff; }
    .pause { background: #fff7e6; }
    .stop  { background: #ffecec; }
    #log { margin-top: 1.5rem; white-space: pre-wrap; color: #555; font-size: 0.95rem; }
  </style>
</head>
<body>
  <h1>Unfollow Bot — Control Panel</h1>
  <div class="grid">
    <button class="force" onclick="send('/force')">Force cycle start</button>
    <button class="pause" onclick="send('/pause')">Pause till clock hour</button>
    <button class="stop"  onclick="send('/stop')">Stop</button>
  </div>
  <div id="log"></div>
  <script>
    async function send(path) {
      const res = await fetch(path, { method: 'POST' });
      const text = await res.text();
      const log = document.getElementById('log');
      const ts = new Date().toLocaleString();
      log.textContent = '[' + ts + '] ' + text + '\\n' + log.textContent;
    }
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  // Basic CORS for local usage
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.end();

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(controlHtml);
  }

  if (req.method === 'POST' && req.url === '/force') {
    control.forceStart = true;
    control.pauseTillClockHour = false;
    wakeLoopNow();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK: Force cycle scheduled immediately.');
  }

  if (req.method === 'POST' && req.url === '/pause') {
    control.pauseTillClockHour = true;
    control.forceStart = false;
    wakeLoopNow();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK: Paused — will align next run to the next clock hour.');
  }

  if (req.method === 'POST' && req.url === '/stop') {
    control.stop = true;
    wakeLoopNow();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK: Stop requested. Shutting down...');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

let currentPort = CONTROL_PORT;

function startServer(port) {
  server.listen(port, () => {
    console.log(`Control UI: http://localhost:${port}`);
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${currentPort} is in use, trying ${currentPort + 1}...`);
    currentPort++;
    startServer(currentPort);
  } else {
    console.error('Server error:', e);
  }
});

startServer(currentPort);


// Configuration
const INSTAGRAM_URL = 'https://www.instagram.com/';
const PROFILE_URL = (username) => `https://www.instagram.com/${username}/`;
const UNFOLLOW_PER_CYCLE = parseInt(process.env.UNFOLLOW_PER_CYCLE || '15', 10);
const CYCLE_MINUTES = parseInt(process.env.CYCLE_MINUTES || '60', 10); // 60 minutes
const MAX_UNFOLLOW_PER_DAY = parseInt(process.env.MAX_UNFOLLOW_PER_DAY || '150', 10); // safety cap
const RUN_ON_START = (process.env.RUN_ON_START || 'true').toLowerCase() !== 'false';
// Skip rules
const SKIP_VERIFIED = (process.env.SKIP_VERIFIED || 'false').toLowerCase() === 'true';
const SKIP_PRIVATE = (process.env.SKIP_PRIVATE || 'false').toLowerCase() === 'true';
const SKIP_CATEGORIES = (process.env.SKIP_CATEGORIES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SKIP_USERNAME_SUBSTRINGS = (process.env.SKIP_USERNAMES_CONTAIN || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SKIP_ACCOUNT_TYPES = (process.env.SKIP_ACCOUNT_TYPES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); // e.g. business, creator

// Use a dedicated local profile by default. This avoids conflicts with your main browser
// and guarantees 2FA sticks cleanly across runs.
const DEFAULT_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || path.join(process.cwd(), '.chrome-profile');
const DEFAULT_PROFILE = process.env.CHROME_PROFILE || 'Default';
const FALLBACK_USER_DATA_DIR = process.env.CHROME_FALLBACK_USER_DATA_DIR || path.join(process.cwd(), '.chrome-profile-fallback');
const CHROME_ALLOW_TEMP = (process.env.CHROME_ALLOW_TEMP || 'false').toLowerCase() === 'true';
const CHROME_CLOSE_EXISTING = (process.env.CHROME_CLOSE_EXISTING || 'false').toLowerCase() === 'true';
const CHROME_CONNECT_OVER_CDP = (process.env.CHROME_CONNECT_OVER_CDP || 'false').toLowerCase() === 'true';
const CHROME_CDP_URL = process.env.CHROME_CDP_URL || 'http://localhost:9222';
const CHROME_FALLBACK_SLOTS = parseInt(process.env.CHROME_FALLBACK_SLOTS || '5', 10);
// Clock-based scheduling
const RUN_AT_HOURS = (process.env.RUN_AT_HOURS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
const RUN_AT_MINUTE = parseInt(process.env.RUN_AT_MINUTE || '0', 10);
const RUN_AT_SECOND = parseInt(process.env.RUN_AT_SECOND || '0', 10);

// Credentials are optional if your Chrome profile is already logged in
const USERNAME = process.env.IG_USERNAME || '';
const PASSWORD = process.env.IG_PASSWORD || '';

// Always skip unfollowing these usernames
const IGNORE_USERNAMES_STATIC = new Set([
  'zahra.mohd.ilyas',
  'myaa.you',
  'tuahajalil',
  'esmwasan',
  ...SKIP_USERNAME_SUBSTRINGS
]);

// State Persistence
const STATE_FILE = path.join(process.cwd(), 'unfollow_state.json');

async function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const data = await readFile(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load state.json:', e);
  }
  return { date: null, count: 0, unfollowedHistory: [] };
}

async function saveState(state) {
  try {
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save state.json:', e);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLoggedIn(page) {
  try {
    const cookies = await page.context().cookies('https://www.instagram.com');
    return cookies.some((c) => c.name === 'sessionid' && c.value);
  } catch {
    return false;
  }
}

async function waitForLoggedIn(page, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLoggedIn(page)) return true;
    // If redirected to challenge/2FA pages, just keep waiting for manual completion
    await sleep(3000);
  }
  return false;
}

async function ensureLoggedIn(page) {
  await page.goto(INSTAGRAM_URL, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) return; // already logged in via cookies

  // If login form is visible, either manual or credential-based login
  const loginFormVisible = await page.locator('input[name="username"]').first().isVisible().catch(() => false);
  if (!loginFormVisible) {
    // Maybe on some interstitial, but not logged in yet; wait for manual login/2FA
    console.log('Waiting for you to log in (2FA supported). You have up to 10 minutes...');
    await waitForLoggedIn(page);
    return;
  }

  if (!USERNAME || !PASSWORD) {
    console.log('Instagram shows login. Login manually in the opened window and complete 2FA if prompted. Waiting up to 10 minutes...');
    await waitForLoggedIn(page);
    return;
  }

  await page.fill('input[name="username"]', USERNAME, { timeout: 30_000 });
  await page.fill('input[name="password"]', PASSWORD);
  const loginSelectors = [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Log In")',
    'text=Log in'
  ];
  for (const sel of loginSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => { });
      break;
    }
  }
  console.log('If 2FA challenge appears, complete it in the browser. Waiting (up to 10 minutes)...');
  await waitForLoggedIn(page);

  // Handle dialogs like "Save Your Login Info?" or notifications
  const buttons = page.locator('div[role="dialog"] button');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const txt = (await buttons.nth(i).innerText().catch(() => '')).toLowerCase();
    if (['not now', 'cancel'].some((t) => txt.includes(t))) {
      await buttons.nth(i).click().catch(() => { });
    }
  }
}

async function dismissPopups(page) {
  // Cookie dialogs
  const cookieButtons = [
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
  ];
  for (const sel of cookieButtons) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => { });
    }
  }
  // Save login / notifications dialogs
  const dialogButtons = page.locator('div[role="dialog"] button');
  const count = await dialogButtons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const txt = (await dialogButtons.nth(i).innerText().catch(() => '')).toLowerCase();
    if (['not now', 'cancel'].some((t) => txt.includes(t))) {
      await dialogButtons.nth(i).click().catch(() => { });
    }
  }
}

async function resolveUsername(page) {
  if (USERNAME) return USERNAME;
  // Try Instagram internal API
  try {
    const data = await page.evaluate(async () => {
      try {
        const r = await fetch('https://www.instagram.com/api/v1/accounts/current_user/', { credentials: 'include' });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    });
    const fromApi = data?.user?.username || data?.username || '';
    if (fromApi) return fromApi;
  } catch { }

  // Fallback: read from accounts/edit username input
  try {
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded' });
    const input = page.locator('input[name="username"]').first();
    await input.waitFor({ timeout: 30_000 });
    const val = (await input.inputValue()).trim();
    if (val) return val;
  } catch { }

  return '';
}

async function getCurrentUserId(page) {
  try {
    const data = await page.evaluate(async () => {
      try {
        const headers = { 'X-IG-App-ID': '936619743392459' };
        const r = await fetch('https://www.instagram.com/api/v1/accounts/current_user/', { credentials: 'include', headers });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    });
    return data?.user?.pk || data?.user?.id || data?.pk || data?.id || null;
  } catch {
    return null;
  }
}

async function fetchFollowingUsers(page, maxNeeded = 50, startMaxId = undefined) {
  const userId = await getCurrentUserId(page);
  if (!userId) return { users: [], nextMaxId: null };
  let nextMaxId = startMaxId;
  const users = [];
  while (users.length < maxNeeded) {
    // Instagram web app id header improves success rate
    const result = await page.evaluate(async ({ uid, max_id }) => {
      const headers = { 'X-IG-App-ID': '936619743392459' };
      const url = new URL(`https://www.instagram.com/api/v1/friendships/${uid}/following/`);
      url.searchParams.set('count', '50');
      if (max_id) url.searchParams.set('max_id', max_id);
      const r = await fetch(url.toString(), { credentials: 'include', headers });
      if (!r.ok) return null;
      return await r.json();
    }, { uid: String(userId), max_id: nextMaxId || null }).catch(() => null);

    if (!result || !Array.isArray(result.users)) break;
    for (const u of result.users) {
      if (u?.username) users.push(u);
      if (users.length >= maxNeeded) break;
    }
    nextMaxId = result.next_max_id;
    if (!nextMaxId) break;
  }
  return { users, nextMaxId };
}

function shouldSkipUser(u) {
  const uname = (u?.username || '').toLowerCase();
  const fname = (u?.full_name || '').toLowerCase();
  if (SKIP_VERIFIED && u?.is_verified) return true;
  if (SKIP_PRIVATE && u?.is_private) return true;
  if (SKIP_USERNAME_SUBSTRINGS.some((s) => uname.includes(s))) return true;
  if (SKIP_CATEGORIES.length && (u?.category || u?.category_name)) {
    const cat = (u.category || u.category_name || '').toLowerCase();
    if (SKIP_CATEGORIES.some((c) => cat.includes(c))) return true;
  }
  if (SKIP_ACCOUNT_TYPES.length && (u?.account_type || u?.is_business || u?.is_professional)) {
    const types = [];
    if (u.account_type) types.push(String(u.account_type).toLowerCase());
    if (u.is_business) types.push('business');
    if (u.is_professional) types.push('creator');
    if (types.some((t) => SKIP_ACCOUNT_TYPES.includes(t))) return true;
  }
  return false;
}

async function waitForFollowState(page, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Expect to see Follow or Follow back after successful unfollow
    const followBtn = page.locator('button:has-text("Follow"), button:has-text("Follow back")').first();
    if (await followBtn.isVisible().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
}

async function isFollowingUs(page, targetUserId) {
  if (!targetUserId) return false;
  try {
    return await page.evaluate(async (uid) => {
      const headers = { 'X-IG-App-ID': '936619743392459' };
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`https://www.instagram.com/api/v1/friendships/show/${uid}/`, {
          credentials: 'include',
          headers,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.followed_by === true;
      } catch {
        return null;
      }
    }, targetUserId);
  } catch (e) {
    console.error(`Error checking friendship status for ${targetUserId}:`, e.message);
    return null; // unknown
  }
}

async function getUserIdFromUsername(page, username) {
  try {
    return await page.evaluate(async (uname) => {
      const headers = { 'X-IG-App-ID': '936619743392459' };
      try {
        // Use a 5s timeout for the fetch inside evaluate
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${uname}`, {
          headers,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.data?.user?.id || null;
      } catch {
        return null;
      }
    }, username);
  } catch {
    return null;
  }
}

async function simulateHumanBehavior(page) {
  try {
    console.log('--- Simulating human behavior (scrolling home feed) ---');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' }).catch(() => { });
    await dismissPopups(page);
    await sleep(2000 + Math.random() * 2000);

    // Scroll down 2-3 times
    const scrolls = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * (0.6 + Math.random() * 0.4)));
      await sleep(1500 + Math.random() * 2000);
    }

    // Try to like 1 or 2 posts visible on screen
    const likesToDo = 1 + Math.floor(Math.random() * 2);
    let liked = 0;

    // Look for unliked heart 'Like' buttons
    const likeButtons = page.locator('svg[aria-label="Like"]').locator('..');
    const count = await likeButtons.count().catch(() => 0);

    for (let i = 0; i < count && liked < likesToDo; i++) {
      const btn = likeButtons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => { });
        await sleep(500 + Math.random() * 1000);
        await btn.click().catch(() => { });
        liked++;
        console.log(`Liked a post to simulate engagement.`);
        await sleep(2000 + Math.random() * 2000);
      }
    }
    console.log('--- Finished human behavior simulation ---');
  } catch (e) {
    console.error('Simulating human behavior failed, continuing anyway:', e.message);
  }
}

async function unfollowByVisitingProfiles(page, usersOrUsernames, maxCount, stateTracker) {
  let unfollowed = 0;
  for (const entry of usersOrUsernames) {
    if (unfollowed >= maxCount) break;
    const uname = typeof entry === 'string' ? entry : entry?.username;
    const userObj = typeof entry === 'string' ? null : entry;
    if (!uname) continue;
    if (IGNORE_USERNAMES_STATIC.has(uname.toLowerCase())) {
      console.log(`Skipping @${uname} (in ignore list)`);
      continue;
    }
    if (userObj && shouldSkipUser(userObj)) continue;
    try {
      await page.goto(`https://www.instagram.com/${uname}/`, { waitUntil: 'domcontentloaded' });
      await dismissPopups(page);
      const followButtonSelectors = [
        'button:has-text("Following")',
        'div[role="button"]:has-text("Following")',
        'button[aria-label="Following"]',
        'button:has-text("Requested")',
      ];
      let clicked = false;
      for (const sel of followButtonSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ delay: 50 }).catch(() => { });
          clicked = true;
          break;
        }
      }
      if (!clicked) continue; // not following or button not found

      // Handle confirmation or request-cancel menu
      const confirmSelectors = [
        'button:has-text("Unfollow")',
        'button:has-text("Cancel request")',
        'div[role="dialog"] button:has-text("Unfollow")',
        'div[role="dialog"] button:has-text("Cancel request")',
        'div[role="menu"] button:has-text("Cancel request")',
      ];
      for (const sel of confirmSelectors) {
        const c = page.locator(sel).first();
        if (await c.isVisible().catch(() => false)) {
          await c.click().catch(() => { });
          break;
        }
      }

      await waitForFollowState(page, 5000);
      unfollowed += 1;
      stateTracker.count += 1;
      stateTracker.unfollowedHistory.push({ username: uname, time: new Date().toISOString() });
      await saveState(stateTracker);
      await sleep(900 + Math.floor(Math.random() * 600));
    } catch {
      // ignore and continue
    }
  }
  return unfollowed;
}

async function getFollowingContext(page) {
  // Option A: dialog overlay
  const dialogs = page.locator('div[role="dialog"]');
  const count = await dialogs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const d = dialogs.nth(i);
    if (!await d.isVisible().catch(() => false)) continue;

    const text = await d.innerText().catch(() => '');
    // Skip common non-list dialogs
    if (text.includes('Unfollow @') || text.includes('If you change your mind') || text.includes('Cancel request?')) {
      continue;
    }

    let scrollArea = d.locator('ul, div[style*="overflow"]').first();
    if (!await scrollArea.isVisible().catch(() => false)) scrollArea = d;
    return { container: d, scrollArea, type: 'dialog' };
  }

  // Option B: full page list
  const main = page.locator('main').first();
  const hasButtons = await page.locator('main button:has-text("Following")').count().catch(() => 0);
  if (hasButtons > 0) {
    return { container: main, scrollArea: page, type: 'page' };
  }
  return null;
}

async function closeFollowingDialog(page) {
  try {
    // Attempt escape key first as it is very reliable on IG
    await page.keyboard.press('Escape');
    await sleep(300);

    const closeSelectors = [
      'button[aria-label="Close"]',
      'svg[aria-label="Close"]',
      'div[role="dialog"] button:has(svg[aria-label="Close"])',
      'div[role="presentation"] button:has(svg[aria-label="Close"])',
      'button:has-text("Close")',
      'div[role="dialog"] button:has-text("Cancel")'
    ];

    for (const sel of closeSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => { });
        await sleep(500);
      }
    }
  } catch (e) {
    // Silently continue
  }
}

async function navigateToFollowing(page, username) {
  // Ensure we start with no open dialogs
  await closeFollowingDialog(page);

  const targetUrl = `${PROFILE_URL(username)}following/`;
  const currentUrl = page.url();

  // If already on the profile/following page, try to find the modal first without reloading
  let ctx = await getFollowingContext(page);
  if (ctx) return ctx;

  if (!currentUrl.includes(PROFILE_URL(username))) {
    console.log(`[UI] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => { });
  } else {
    console.log(`[UI] Already on profile page. Attempting to trigger following list...`);
    // If on profile but no modal, try to click the following link again or refresh
    const followingLink = page.locator(`a[href$="/following/"]`).first();
    if (await followingLink.isVisible().catch(() => false)) {
      await followingLink.click().catch(() => { });
    } else {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => { });
    }
  }

  await dismissPopups(page);

  // Wait a bit for the modal to appear (IG can be slow)
  console.log(`[UI] Waiting for following modal to appear...`);
  const modalSelectors = ['div[role="dialog"]', 'main ul', 'div[role="presentation"]'];
  for (let i = 0; i < 5; i++) {
    ctx = await getFollowingContext(page);
    if (ctx) return ctx;
    await sleep(1500);
  }

  throw new Error('Could not open Following list. UI selectors may have changed or the modal took too long to load.');
}

async function navigateToFollowingWithTimeout(page, username, timeoutMs = 20000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const ctx = await navigateToFollowing(page, username);
      return ctx;
    } catch (e) {
      lastError = e;
      await sleep(1000);
    }
  }
  throw lastError || new Error('Timeout opening Following list');
}

// async function unfollowFromList(page, context, maxCount) {
//   // The dialog contains a scrollable list; each row has a button that says Following
//   let unfollowed = 0;
//   const { container, scrollArea, type } = context;

//   // Helper to get visible following buttons
//   async function getFollowingButtons() {
//     const buttons = container.locator('button:has-text("Following"), button:has-text("Requested")');
//     const total = await buttons.count();
//     const items = [];
//     for (let i = 0; i < total; i += 1) {
//       items.push(buttons.nth(i));
//     }
//     return items;
//   }

//   // Scroll and attempt unfollow
//   while (unfollowed < maxCount) {
//     const buttons = await getFollowingButtons();
//     if (buttons.length === 0) {
//       // scroll to load more
//       if (type === 'dialog') {
//         await scrollArea.evaluate((el) => el.scrollBy(0, el.scrollHeight));
//       } else {
//         await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight));
//       }
//       await sleep(1000);
//       continue;
//     }

//     for (const btn of buttons) {
//       if (unfollowed >= maxCount) break;
//       // Ensure the button is attached and visible
//       const visible = await btn.isVisible().catch(() => false);
//       if (!visible) continue;

//       await btn.click({ delay: 50 }).catch(() => {});
//       // Confirm dialog appears with Unfollow or Cancel request
//       const confirmSelectors = [
//         'button:has-text("Unfollow")',
//         'button:has-text("Cancel request")',
//         'div[role="dialog"] button:has-text("Unfollow")',
//         'div[role="dialog"] button:has-text("Cancel request")',
//         'div[role="menu"] button:has-text("Cancel request")',
//       ];
//       for (const sel of confirmSelectors) {
//         const c = page.locator(sel).first();
//         if (await c.isVisible().catch(() => false)) {
//           await c.click().catch(() => {});
//           break;
//         }
//       }
//       // Wait the button to change to Follow/Follow back state to avoid accidental re-follow clicks later
//       await page.waitForTimeout(200);
//       unfollowed += 1;
//       // Small random delay to be human-like and avoid rate limits
//       await sleep(800 + Math.floor(Math.random() * 500));
//     }

//     // Scroll a bit between batches
//     if (type === 'dialog') {
//       await scrollArea.evaluate((el) => el.scrollBy(0, el.clientHeight || 600));
//     } else {
//       await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight));
//     }
//     await sleep(700);
//   }

//   return unfollowed;
// }


async function unfollowFromList(page, context, maxCount) {
  let unfollowed = 0;
  const { container, scrollArea, type } = context;

  // Track rows we've already handled (skip/rejected/unfollowed)
  const seenUsernames = new Set();

  // Returns a locator that only matches rows that actually have a "Following"/"Requested" button
  function rowLocator() {
    // Works for both dialog and full-page variants
    return container.locator(
      [
        'li:has(button:has-text("Following"))',
        'li:has(button:has-text("Requested"))',
        // In some layouts IG wraps rows differently:
        'div:has(> div):has(button:has-text("Following"))',
        'div:has(> div):has(button:has-text("Requested"))'
      ].join(', ')
    );
  }

  async function getRowCount() {
    return await rowLocator().count().catch(() => 0);
  }

  // Extract username from a row
  async function getUsernameFromRow(row) {
    // First link in row usually points to "/<username>/"
    const href = await row.locator('a[href^="/"]').first().getAttribute('href').catch(() => null);
    if (!href) return '';
    const uname = href.replace(/\//g, '').trim().toLowerCase();
    return uname;
  }

  while (unfollowed < maxCount) {
    const count = await getRowCount();
    if (count === 0) {
      // Load more by scrolling
      if (type === 'dialog') {
        await scrollArea.evaluate((el) => el.scrollBy(0, el.clientHeight || 600));
      } else {
        await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight));
      }
      await sleep(800);
      continue;
    }

    let progressedThisPass = false;

    for (let i = 0; i < count && unfollowed < maxCount; i++) {
      const row = rowLocator().nth(i);

      // Ensure row is visible before working with it
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;

      const uname = (await getUsernameFromRow(row)) || '';
      if (uname) {
        if (seenUsernames.has(uname)) {
          // Already processed this row in a previous pass
          continue;
        }
        seenUsernames.add(uname);

        if (IGNORE_USERNAMES_STATIC.has(uname)) {
          console.log(`Skipping @${uname} (in ignore list)`);
          // Nudge scroll a bit so we don’t stare at the same top rows forever
          await row.evaluate((el) => el.scrollIntoView({ block: 'end' }));
          await sleep(150);
          continue;
        }
      }

      const btn = row.locator('button:has-text("Following"), button:has-text("Requested")').first();
      if (!await btn.isVisible().catch(() => false)) continue;

      // Click and confirm
      await btn.click({ delay: 50 }).catch(() => { });
      const confirmSelectors = [
        'button:has-text("Unfollow")',
        'button:has-text("Cancel request")',
        'div[role="dialog"] button:has-text("Unfollow")',
        'div[role="dialog"] button:has-text("Cancel request")',
        'div[role="menu"] button:has-text("Cancel request")',
      ];
      for (const sel of confirmSelectors) {
        const c = page.locator(sel).first();
        if (await c.isVisible().catch(() => false)) {
          await c.click().catch(() => { });
          break;
        }
      }

      // Tiny wait & count
      await page.waitForTimeout(200);
      unfollowed += 1;
      progressedThisPass = true;

      // Human-like delay
      await sleep(800 + Math.floor(Math.random() * 500));
    }

    // If we didn’t act on anything (all ignored/seen), scroll to bring in new rows
    if (!progressedThisPass) {
      if (type === 'dialog') {
        await scrollArea.evaluate((el) => el.scrollBy(0, el.clientHeight || 600));
      } else {
        await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight));
      }
      await sleep(700);
    }
  }

  return unfollowed;
}

async function unfollowFromList1(page, context, maxCount, stateTracker) {
  let unfollowed = 0;
  const { container, scrollArea, type } = context;

  // Track rows we've already handled
  const seenUsernames = new Set();
  let consecutiveNoProgressPasses = 0;
  let consecutiveApiFailures = 0;

  function rowLocator() {
    // We find all buttons that say "Following" or "Requested" (not just "Follow")
    // and then go up to their nearest row-like ancestor (li or div with a link).
    return container.locator('button').filter({ hasText: /^(Following|Requested|.*[Ff]ollowing|.*[Rr]equested)$/ })
      .locator('xpath=./ancestor::li | ./ancestor::div[.//a[contains(@href, "/") and not(contains(@href, "explore"))]][1]');
  }

  function anyRowLocator() {
    // Finds any row in the list to help with scrolling
    return container.locator('li, div:has(> div > a[href^="/"]), div:has(> a[href^="/"])');
  }

  async function getRowCount() {
    return await rowLocator().count().catch(() => 0);
  }

  async function getUsernameFromRow(row) {
    // Try primary link first (usually the username)
    let href = await row.locator('a[href^="/"]').first().getAttribute('href').catch(() => null);

    // Fallback: look for any link that doesn't contain common IG paths
    if (!href || href === '/' || href.includes('explore') || href.includes('reels') || href.includes('direct')) {
      const links = row.locator('a[href^="/"]');
      const count = await links.count();
      for (let i = 0; i < count; i++) {
        const h = await links.nth(i).getAttribute('href').catch(() => null);
        if (h && h.length > 2 && !['/', '/explore/', '/reels/', '/direct/'].includes(h)) {
          href = h;
          break;
        }
      }
    }

    if (!href) return '';
    return href.replace(/\//g, '').trim().toLowerCase();
  }

  console.log(`[UI] Starting unfollow loop. Target: ${maxCount}`);

  while (unfollowed < maxCount) {
    const count = await getRowCount();
    const totalVisible = await anyRowLocator().count().catch(() => 0);

    if (count === 0 && totalVisible > 0) {
      // Diagnostic: what buttons DO we have?
      const firstRow = anyRowLocator().first();
      const btnText = await firstRow.locator('button').allInnerTexts().catch(() => []);
      console.log(`[UI] Found ${totalVisible} rows, but 0 'Following' buttons. First row buttons: [${btnText.join(', ')}]`);
    }

    if (count === 0) {
      console.log(`[UI] No 'Following' rows on screen (out of ${totalVisible} total rows). Scrolling to load more...`);

      const lastTotal = totalVisible;

      if (type === 'dialog') {
        // Scroll the actual scroll area element to the bottom
        await scrollArea.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await sleep(1000);
        // Also use mouse wheel for good measure
        const box = await scrollArea.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 1000);
        }
      } else {
        await page.mouse.wheel(0, 1000);
        await page.keyboard.press('PageEnd');
      }

      await sleep(2500);

      // Check if we actually loaded anything new
      const newTotal = await anyRowLocator().count().catch(() => 0);
      if (newTotal === lastTotal && lastTotal > 0) {
        consecutiveNoProgressPasses++;
        if (consecutiveNoProgressPasses >= 3) {
          console.log('[UI] No new rows loaded after 3 scrolls. Likely reached end of list.');
          break;
        }
      } else {
        consecutiveNoProgressPasses = 0;
      }
      continue;
    }

    let progressedThisPass = false;
    console.log(`[UI] Processing ${count} visible rows...`);

    for (let i = 0; i < count && unfollowed < maxCount; i++) {
      const row = rowLocator().nth(i);
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;

      const uname = (await getUsernameFromRow(row)) || '';
      if (uname) {
        if (seenUsernames.has(uname)) continue;
        seenUsernames.add(uname);

        if (IGNORE_USERNAMES_STATIC.has(uname)) {
          console.log(`[UI] Skipping @${uname} (in ignore list)`);
          continue;
        }

        // --- STRICT API CHECK IN UI FALLBACK ---
        const userId = await getUserIdFromUsername(page, uname);
        if (userId) {
          const followsUs = await isFollowingUs(page, userId);
          if (followsUs === true) {
            console.log(`[UI] Skipping @${uname} because they follow you back.`);
            continue;
          } else if (followsUs === null) {
            console.log(`[UI] Skipping @${uname} due to unknown API friendship status.`);
            consecutiveApiFailures++;
            if (consecutiveApiFailures > 5) {
              console.log('[UI] Multiple API failures detected. Instagram may be rate-limiting friendship checks.');
            }
            continue;
          }
        } else {
          console.log(`[UI] Skipping @${uname} because user ID couldn't be resolved strictly.`);
          continue;
        }
      } else {
        console.log(`[UI] Skipping row because username could not be resolved.`);
        continue;
      }

      const btn = row.locator('button:has-text("Following"), button:has-text("Requested")').first();
      if (!await btn.isVisible().catch(() => false)) continue;

      // Reset skips if we act
      consecutiveApiFailures = 0;
      console.log(`[UI] Unfollowing @${uname}...`);

      // Click and confirm Unfollow
      console.log(`[UI] Clicking Following button for @${uname}...`);
      await btn.click({ delay: 50 }).catch(() => { });

      const confirmSelectors = [
        'div[role="dialog"] button:has-text("Unfollow")',
        'div[role="dialog"] button:has-text("Cancel request")',
        'button:has-text("Unfollow")',
        'button:has-text("Cancel request")',
        'div[role="menu"] button:has-text("Cancel request")',
      ];

      let confirmed = false;
      // Wait up to 3 seconds for the confirmation dialog
      for (let attempt = 0; attempt < 6; attempt++) {
        for (const sel of confirmSelectors) {
          const c = page.locator(sel).first();
          if (await c.isVisible().catch(() => false)) {
            await c.click().catch(() => { });
            confirmed = true;
            break;
          }
        }
        if (confirmed) break;
        await sleep(500);
      }

      if (confirmed) {
        console.log(`[UI] Unfollow confirmed for @${uname}.`);
        await page.waitForTimeout(1000);
        unfollowed += 1;
        stateTracker.count += 1;
        stateTracker.unfollowedHistory.push({ username: uname || 'unknown_from_ui', time: new Date().toISOString() });
        await saveState(stateTracker);
        progressedThisPass = true;
        
        // IMPORTANT: The list has collapsed! The next item is now at the same index i.
        // We decrement i so that when the loop increments it, we stay at the same physical position.
        i--; 
      } else {
        console.log(`[UI] Warning: Confirmation button not found for @${uname}.`);
        // If we failed to find the confirm button, don't count it as seen for next pass
        seenUsernames.delete(uname);
      }

      await sleep(1500 + Math.floor(Math.random() * 1000));
    }

    if (!progressedThisPass) {
      consecutiveNoProgressPasses++;
      console.log(`[UI] No progress this pass (${consecutiveNoProgressPasses}/5). Scrolling...`);
      
      if (consecutiveNoProgressPasses >= 5) {
        console.log('[UI] No progress made for 5 consecutive passes. Breaking cycle.');
        break;
      }

      if (type === 'dialog') {
        await scrollArea.evaluate((el) => {
          el.scrollBy(0, el.clientHeight * 1.5);
        });
        const box = await scrollArea.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 800);
        }
      } else {
        await page.mouse.wheel(0, 1000);
        await page.keyboard.press('PageDown');
      }
      await sleep(2000);
    }
  }

  return unfollowed;
}




let userDataDirGlobal;
async function tryLaunch(dir, profileDirName) {
  const args = [];
  if (profileDirName) args.push(`--profile-directory=${profileDirName}`);

  const baseOptions = {
    headless: false,
    viewport: null,
    args,
  };
  try {
    return await chromium.launchPersistentContext(dir, { channel: 'chrome', ...baseOptions });
  } catch (e) {
    // Retry with executablePath on macOS
    try {
      const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      return await chromium.launchPersistentContext(dir, { executablePath: macChrome, ...baseOptions });
    } catch (e2) {
      throw e2;
    }
  }
}

async function launchWithFallbackPoolFactory(defaultDir, profileToUse) {
  return async function launchWithFallbackPool() {
    const errors = [];
    // First try main profile
    try {
      return await tryLaunch(defaultDir, profileToUse);
    } catch (e) {
      errors.push(e);
      const message = String(e?.message || e);
      if (!(message.includes('ProcessSingleton') || message.includes('profile directory') || message.includes('SingletonLock'))) {
        throw e;
      }
    }

    if (CHROME_CLOSE_EXISTING) {
      console.log('Chrome profile is locked. Closing existing Chrome and retrying...');
      try {
        await exec('pkill -x "Google Chrome" || true');
        await sleep(2000);
      } catch { }
      return tryLaunch(defaultDir, profileToUse);
    }

    if (!CHROME_ALLOW_TEMP) {
      throw new Error('Chrome profile is in use. Set CHROME_ALLOW_TEMP=true to use a dedicated profile for the automation, or CHROME_CLOSE_EXISTING=true to close running Chrome.');
    }

    // Build pool of persistent fallback dirs: base + numbered slots
    const dirs = [FALLBACK_USER_DATA_DIR];
    for (let i = 1; i <= CHROME_FALLBACK_SLOTS; i += 1) {
      dirs.push(`${FALLBACK_USER_DATA_DIR}-${i}`);
    }
    for (const dir of dirs) {
      try {
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        // No explicit profile; let Chrome create Default inside
        const ctx = await tryLaunch(dir, undefined);
        console.log(`Using persistent automation profile: ${dir}`);
        userDataDirGlobal = dir;
        return ctx;
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('ProcessSingleton') || msg.includes('profile directory') || msg.includes('SingletonLock')) {
          // locked; try next slot
          continue;
        }
        errors.push(e);
      }
    }
    // If all slots locked, final fallback: new unique temp dir for this run
    const timestamp = Date.now();
    const tempDir = path.join(FALLBACK_USER_DATA_DIR, `run-${timestamp}`);
    await mkdir(tempDir, { recursive: true });
    console.log(`All persistent profiles are busy; using temporary profile for this run: ${tempDir}`);
    userDataDirGlobal = tempDir;
    return tryLaunch(tempDir, undefined);
  };
}

async function run() {
  let userDataDir = `${DEFAULT_USER_DATA_DIR}`;
  let context;
  let launchWithFallbackPool;
  if (CHROME_CONNECT_OVER_CDP) {
    console.log(`Attaching to existing Chrome via CDP at ${CHROME_CDP_URL} ...`);
    try {
      launchWithFallbackPool = async () => {
        const browser = await chromium.connectOverCDP(CHROME_CDP_URL);
        const contexts = browser.contexts();
        const ctx = contexts[0] || await browser.newContext();
        if (!ctx) throw new Error('No default Chrome context found. Make sure Chrome is running with your profile.');
        return ctx;
      };
      context = await launchWithFallbackPool();
    } catch (err) {
      const message = String(err?.message || err);
      throw new Error(`Could not attach to existing Chrome at ${CHROME_CDP_URL}. Start Chrome with --remote-debugging-port=9222 and try again. Original error: ${message}`);
    }
  } else {
    // Choose a profile directory inside userDataDir if it exists; otherwise, let Chrome create one
    const candidateProfiles = Array.from(new Set([
      DEFAULT_PROFILE,
      'Default',
      'Profile 1',
      'Profile 2',
      'Profile 3',
      'Profile 4',
      'Profile 5',
    ]));
    let profileToUse = candidateProfiles.find((name) => existsSync(path.join(userDataDir, name)));

    launchWithFallbackPool = await launchWithFallbackPoolFactory(userDataDir, profileToUse);
    context = await launchWithFallbackPool();
  }
  let page = await context.newPage();

  // If attached over CDP and on macOS, move this tab into a separate window while keeping the same profile
  if (CHROME_CONNECT_OVER_CDP && process.platform === 'darwin') {
    try {
      const marker = `automation_${Date.now()}`;
      await page.goto(`${INSTAGRAM_URL}?${marker}`, { waitUntil: 'domcontentloaded' });
      const osa = `
        tell application "Google Chrome"
          set targetUrl to "${marker}"
          set foundTab to missing value
          set foundWindow to missing value
          repeat with w in every window
            repeat with t in every tab of w
              try
                if (URL of t contains targetUrl) then
                  set foundTab to t
                  set foundWindow to w
                  exit repeat
                end if
              end try
            end repeat
            if foundTab is not missing value then exit repeat
          end repeat
          if foundTab is not missing value then
            set newWindow to make new window
            move foundTab to newWindow
            set active tab index of newWindow to 1
            set index of newWindow to 1
            activate
          end if
        end tell`;
      await exec(`osascript -e '${osa.replace(/'/g, "'\\''")}'`).catch(() => { });
    } catch { }
  }

  await ensureLoggedIn(page);

  // Resolve logged-in username robustly
  let username = await resolveUsername(page);

  if (!username) {
    console.log('Could not determine username automatically. Set IG_USERNAME in .env.');
  }

  // Global guards to avoid unexpected exits that could close the automation Chrome
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    // Don't exit, just log and continue
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    // Don't exit, just log and continue
  });

  // Keep the process alive even if Chrome closes
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    try {
      if (context) await context.close();
    } catch { }
    process.exit(0);
  });
  process.on('SIGTERM', async (signal) => {
    console.log(`Received ${signal}, but ignoring to keep automation running...`);
    // Don't exit, just log and continue
  });
  process.on('SIGHUP', async (signal) => {
    console.log(`Received ${signal}, but ignoring to keep automation running...`);
    // Don't exit, just log and continue
  });

  // Resilience: if the page or browser closes unexpectedly, reopen and continue
  let relaunching = false;
  async function relaunchBrowser() {
    if (relaunching) return;
    relaunching = true;
    try {
      console.log('Browser/page closed unexpectedly. Relaunching automation browser...');
      if (context) {
        try {
          await context.close();
        } catch { }
      }
      context = await launchWithFallbackPool();
      page = await context.newPage();
      await ensureLoggedIn(page);
      console.log('Relaunch successful. Continuing cycles.');
    } catch (e) {
      console.error('Relaunch failed:', e?.message || e);
      // Try again in 30 seconds
      setTimeout(() => {
        relaunching = false;
        relaunchBrowser();
      }, 30000);
    } finally {
      relaunching = false;
    }
  }

  // Monitor context and page for unexpected closures
  if (context) {
    context.on('close', () => {
      console.log('Chrome context closed unexpectedly');
      setTimeout(relaunchBrowser, 5000);
    });
  }
  if (page) {
    page.on('close', () => {
      console.log('Page closed unexpectedly');
      setTimeout(relaunchBrowser, 5000);
    });
  }

  // Scheduling helpers
  function getNextScheduledDate(fromDate) {
    const now = new Date(fromDate.getTime());
    if (!RUN_AT_HOURS.length) {
      // Fallback: fixed interval
      return new Date(now.getTime() + CYCLE_MINUTES * 60 * 1000);
    }
    const hours = [...new Set(RUN_AT_HOURS)].sort((a, b) => a - b);
    // Try today
    for (const h of hours) {
      const candidate = new Date(now);
      candidate.setHours(h, RUN_AT_MINUTE, RUN_AT_SECOND, 0);
      if (candidate > now) return candidate;
    }
    // Otherwise pick the first hour tomorrow
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours[0], RUN_AT_MINUTE, RUN_AT_SECOND, 0);
    return candidate;
  }

  // Initial wait to align to clock if schedule is defined
  if (RUN_AT_HOURS.length) {
    const firstAt = getNextScheduledDate(new Date());
    const ms = Math.max(0, firstAt.getTime() - Date.now());
    console.log(`Waiting until first scheduled run at ${firstAt.toLocaleString()} before starting.`);
    await sleep(ms);
  } else {
    // If no specific hours set, run at clock hours (1pm, 2pm, 3pm, etc.)
    console.log('No specific schedule set. Will run at clock hours (1:00 PM, 2:00 PM, 3:00 PM, etc.)');
  }

  // Keep process alive and run on schedule
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (control.stop) {
        console.log('🛑 Stop requested via control panel. Shutting down...');
        try { if (context) await context.close(); } catch { }
        try { server.close(); } catch { }
        process.exit(0);
      }
      if (!username) {
        username = await resolveUsername(page);
        if (username) console.log(`Resolved username: ${username}`);
      }

      // Load State
      let state = await loadState();
      const currentDay = new Date().toDateString();
      if (state.date !== currentDay) {
        state.date = currentDay;
        state.count = 0;
        state.unfollowedHistory = [];
        await saveState(state);
      }
      let unfollowedToday = state.count;

      // 1) If user hit "Force cycle start", run immediately
      if (control.forceStart) {
        console.log('⚡ Force cycle start requested.');
        shouldRunNow = true;
        control.forceStart = false; // one-shot
      }

      // if (!username) {
      //   console.log('Username still unknown; skipping this cycle.');
      // } else if (unfollowedToday >= MAX_UNFOLLOW_PER_DAY) {
      //   console.log(`Reached daily cap (${MAX_UNFOLLOW_PER_DAY}). Waiting until next day.`);
      // } else if (username) {
      //   let done = 0;
      //   const allowed = Math.min(UNFOLLOW_PER_CYCLE, MAX_UNFOLLOW_PER_DAY - unfollowedToday);
      //   console.log(`\n=== Starting unfollow cycle ===`);
      //   console.log(`Target: ${allowed} accounts to unfollow`);
      //   console.log(`Already unfollowed today: ${unfollowedToday}`);

      //   try {
      //     console.log(`Attempting to open Following list for ${username}...`);
      //     const ctx = await navigateToFollowingWithTimeout(page, username, 15000);
      //     console.log('Following list opened successfully, starting unfollow process...');
      //     done = await unfollowFromList(page, ctx, allowed);
      //     console.log(`Unfollowed ${done} accounts via Following list UI.`);
      //   } catch (e) {
      //     console.log(`Following list UI failed: ${e.message}`);
      //     console.log('Falling back to API method...');
      //     try {
      //       const users = await fetchFollowingUsers(page, allowed + 20);
      //       console.log(`API fetched ${users.length} users from your Following.`);
      //       if (users.length > 0) {
      //         done = await unfollowByVisitingProfiles(page, users, allowed);
      //         console.log(`Unfollowed ${done} accounts via profile visits.`);
      //       } else {
      //         console.log('No users found via API. Checking if logged in...');
      //         const loggedIn = await isLoggedIn(page);
      //         if (!loggedIn) {
      //           console.log('Not logged in. Please log in to Instagram in the Chrome window.');
      //           await ensureLoggedIn(page);
      //         } else {
      //           console.log('Logged in but API returned 0 users. Instagram may have changed their API.');
      //         }
      //       }
      //     } catch (apiError) {
      //       console.error('API fallback also failed:', apiError.message);
      //     }
      //   }

      //   unfollowedToday += done;
      //   console.log(`\n=== Cycle complete ===`);
      //   console.log(`Unfollowed this cycle: ${done}`);
      //   console.log(`Total unfollowed today: ${unfollowedToday}`);
      //   console.log(`Daily cap: ${MAX_UNFOLLOW_PER_DAY}`);
      // }

      // Default to API method first
      if (!username) {
        console.log('Username still unknown; will re-check later.');
      } else if (unfollowedToday >= MAX_UNFOLLOW_PER_DAY) {
        console.log(`Reached daily cap (${MAX_UNFOLLOW_PER_DAY}). Waiting until next day.`);
      } else if (shouldRunNow) {
        let cycleUnfollowed = 0;
        const targetForCycle = Math.min(UNFOLLOW_PER_CYCLE, MAX_UNFOLLOW_PER_DAY - unfollowedToday);
        console.log(`\n=== Starting unfollow cycle ===`);
        console.log(`Target: ${targetForCycle} accounts to unfollow`);
        console.log(`Already unfollowed today: ${unfollowedToday}`);

        const stateBeforeCycle = state.count;

        try {
          // Add human behavior BEFORE jumping into bulk API operations
          await simulateHumanBehavior(page);

          // Attempt API first
          console.log('Fetching followers via API to explicitly check follow-backs...');
          
          let nextMaxId = undefined;
          const nonFollowers = [];
          let checkedCount = 0;
          const MAX_TO_CHECK = 400; // safety limit

          while (nonFollowers.length < targetForCycle && checkedCount < MAX_TO_CHECK) {
            console.log(`Searching for non-followers... (Found: ${nonFollowers.length}/${targetForCycle}, Checked: ${checkedCount})`);
            const { users, nextMaxId: newMaxId } = await fetchFollowingUsers(page, 50, nextMaxId);
            nextMaxId = newMaxId;

            if (users.length === 0) {
              console.log('No more users to fetch from Following list.');
              break;
            }

            for (const u of users) {
              if (nonFollowers.length >= targetForCycle) break;
              checkedCount++;

              if (IGNORE_USERNAMES_STATIC.has(u.username?.toLowerCase() || '')) continue;

              const followsUs = await isFollowingUs(page, u.pk || u.id);
              if (followsUs === true) {
                // skip silently
              } else if (followsUs === false) {
                console.log(`Found non-follower: @${u.username}`);
                nonFollowers.push(u);
              } else {
                console.log(`Skipping @${u.username} due to unknown API friendship status.`);
              }
              await sleep(350);
            }

            if (!nextMaxId) break;
          }

          if (nonFollowers.length > 0) {
            console.log(`\nFound ${nonFollowers.length} target non-followers. Proceeding to unfollow...`);
            const done = await unfollowByVisitingProfiles(page, nonFollowers, targetForCycle, state);
            cycleUnfollowed += done;
            console.log(`Unfollowed ${done} accounts successfully.`);
          } else {
            throw new Error("API FOUND NO NON-FOLLOWERS");
          }
        } catch (apiError) {
          const remaining = targetForCycle - (state.count - stateBeforeCycle);
          if (remaining > 0) {
            console.log(`Primary method failed: ${apiError.message}. Switching to UI method for remaining ${remaining} accounts...`);
            try {
              console.log(`Attempting to open Following list UI for ${username}...`);
              const ctx = await navigateToFollowingWithTimeout(page, username, 15000);
              console.log('Following list opened successfully, starting unfollow process...');
              const done = await unfollowFromList1(page, ctx, remaining, state);
              cycleUnfollowed += done;
              console.log(`Unfollowed ${done} accounts via UI dialog.`);
            } catch (uiError) {
              console.error('UI fallback also failed:', uiError.message);
            } finally {
              await closeFollowingDialog(page);
            }
          } else {
            console.log('Limit reached for this cycle via primary method.');
          }
        }

        unfollowedToday = state.count;
        const totalThisCycle = state.count - stateBeforeCycle;
        console.log(`\n=== Cycle complete ===`);
        console.log(`Unfollowed this cycle: ${totalThisCycle}`);
        console.log(`Total unfollowed today: ${unfollowedToday}`);
        console.log(`Daily cap: ${MAX_UNFOLLOW_PER_DAY}`);
      }

    } catch (err) {
      console.error('Cycle error:', err?.message || err);
      console.log('Waiting 5 minutes before retrying...');
      await sleep(5 * 60 * 1000);
      continue;
    }

    // Determine next run time
    // let nextAt, sleepMs, nextStr;
    // if (RUN_AT_HOURS.length) {
    //   nextAt = getNextScheduledDate(new Date());
    //   sleepMs = Math.max(0, nextAt.getTime() - Date.now());
    //   nextStr = nextAt.toLocaleString();
    //   console.log(`Next scheduled run at ${nextStr}`);
    // } else {
    //   // Default: run at clock hours (1:00 PM, 2:00 PM, 3:00 PM, etc.)
    //   const now = new Date();
    //   const currentHour = now.getHours();
    //   const nextHour = currentHour + 1;
    //   nextAt = new Date(now);
    //   nextAt.setHours(nextHour, 0, 0, 0); // Set to next hour at 00:00
    //   sleepMs = Math.max(0, nextAt.getTime() - now.getTime());
    //   nextStr = nextAt.toLocaleString();
    //   console.log(`Next run at ${nextStr} (clock hour)`);
    // }

    // ---- Determine next run time & sleep (interruptible) ----
    let nextAt, sleepMs, nextStr;

    // If pause requested: align to next clock hour once
    if (control.pauseTillClockHour) {
      const now = new Date();
      const nextHour = now.getHours() + 1;
      nextAt = new Date(now);
      nextAt.setHours(nextHour, 0, 0, 0);
      control.pauseTillClockHour = false; // one-shot
      console.log(`Paused — next run aligned to clock hour at ${nextAt.toLocaleString()}`);
    } else {
      if (RUN_AT_HOURS.length) {
        nextAt = getNextScheduledDate(new Date());
      } else {
        // Default: run at clock hours (1:00 PM, 2:00 PM, ...)
        const now = new Date();
        const nextHour = now.getHours() + 1;
        nextAt = new Date(now);
        nextAt.setHours(nextHour, 0, 0, 0);
      }
    }

    sleepMs = Math.max(0, nextAt.getTime() - Date.now());
    nextStr = nextAt.toLocaleString();
    console.log(`Next run at ${nextStr}`);
    console.log(`Sleeping for ~${Math.round(sleepMs / 60000)} minutes (interruptible)...`);

    // If someone clicks "Force" or "Stop" or "Pause" we will wake early.
    await interruptibleSleep(sleepMs);

    // After waking (either timeout or wakeLoopNow), decide whether to run a cycle.
    // If woken by Force, top-of-loop will catch it and run immediately.
    shouldRunNow = !control.pauseTillClockHour && !control.stop && !control.forceStart;

    // console.log(`Sleeping for ${Math.round(sleepMs / 1000 / 60)} minutes...`);
    // await sleep(sleepMs);
  }
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
