const { chromium } = await import(process.env.WSM_PLAYWRIGHT_MODULE || 'playwright-core');
import fs from 'node:fs';
export const BASE = process.env.WSM_ST_URL || 'http://127.0.0.1:8123/';
export const DATA = process.env.WSM_ST_DATA || '/workspace/st119-data/default-user';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function launch() {
  const browser = await chromium.launch({ executablePath: process.env.WSM_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404|net::/.test(m.text())) console.log('[console.error]', m.text().slice(0, 300)); });
  await load(page);
  return { browser, page };
}
export async function load(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitReady(page);
  await connect(page);
}
export async function waitReady(page) {
  await page.waitForFunction(() => { try { return !!window.SillyTavern.getContext().characters?.length; } catch { return false; } }, null, { timeout: 120000 });
  await sleep(1500);
}
export async function connect(page) {
  await page.evaluate(() => { document.querySelector('#api_button_openai')?.click(); });
  await page.waitForFunction(() => { const s = document.querySelector('#online_status_text2')?.textContent || ''; return window.SillyTavern.getContext().onlineStatus === 'Valid'; }, null, { timeout: 20000 }).catch(e => console.log('connect wait fail', e.message));
  await sleep(500);
}
export async function openChar(page, name = 'Seraphina') {
  await page.evaluate(async n => { const c = SillyTavern.getContext(); const id = c.characters.findIndex(x => x.name === n); await c.selectCharacterById(id); }, name);
  await page.waitForFunction(n => { const c = SillyTavern.getContext(); return c.characters[c.characterId]?.name === n && c.chat.length >= 1; }, name, { timeout: 30000 });
  await sleep(800);
}
export async function idle(page, timeout = 60000) {
  await sleep(300);
  await page.waitForFunction(() => !document.body.dataset.generating && getComputedStyle(document.querySelector('#mes_stop')).display === 'none', null, { timeout });
  await sleep(700);
}
export async function send(page, text) {
  await page.evaluate(t => { const ta = document.querySelector('#send_textarea'); ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send_but').click(); }, text);
  await idle(page);
}
export const ctxEval = (page, fn, arg) => page.evaluate(fn, arg);
export function chatFiles(dir = 'default_Seraphina') { const p = `${DATA}/chats/${dir}`; return fs.existsSync(p) ? fs.readdirSync(p).filter(f => f.endsWith('.jsonl')).map(f => `${p}/${f}`) : []; }
export function readJsonl(file) { return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)); }
export async function currentChatFile(page) {
  const { id, group } = await page.evaluate(() => { const c = SillyTavern.getContext(); return { id: c.getCurrentChatId(), group: c.groupId }; });
  if (group) return `${DATA}/group chats/${id}.jsonl`;
  return `${DATA}/chats/default_Seraphina/${id}.jsonl`;
}
export async function waitSaved(page, pred, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const f = await currentChatFile(page); last = readJsonl(f); if (pred(last)) return last; } catch {} await sleep(300); }
  return last;
}
