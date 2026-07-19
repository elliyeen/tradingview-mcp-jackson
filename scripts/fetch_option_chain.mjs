#!/usr/bin/env node
// Scrapes TradingView's Options Chain page (±10 strikes, nearest N expirations) for
// each of FATTAH's six tickers, filters to ask <= $0.45, and appends the results
// to fattah/detector/contract_store.jsonl (one line per discovered candidate,
// stamped with discovered_at and run_id — never overwritten).
//
// Navigation follows the confirmed path from
// ~/tradingview-mcp-jackson/skills/option-chain-navigate/SKILL.md: ticker badge
// dropdown -> ASSETS -> Options -> strikes preset -> ±10 strikes. The chain
// renders as a real <table>, so once there we read structured data/cell-id and
// data-strike attributes instead of parsing pixel screenshots.
//
// Multi-expiration sweep (confirmed live 2026-07-19 on AAPL): the "Expiration"
// toolbar button opens a checkbox list of upcoming dates (nearest first,
// "Jul 20", "Jul 22", ... "Dec 18", ...). Exactly one (the nearest) is
// pre-checked by default. Checking additional boxes is additive — the combined
// chain groups rows under a "<Month Day>  N DTE" header per expiration and
// keeps every previously-checked date's rows in the same table. Each cell's
// data-cell-id already encodes the expiration (OPRA:{TICKER}{YYMMDD}{C|P}
// {STRIKE}), so scraped rows never need the visible date-header text parsed.
//
// The combined table is virtualized (confirmed live: querying the DOM at
// scrollTop=0 only returns ~2 expirations' worth of rows even with 4 dates
// checked) — the scrape must scroll `.wrapper-*`'s scrollable ancestor in
// small steps and merge rows across steps, waiting ~800ms per step for the
// virtualized list to re-render. A single eval that sets scrollTop repeatedly
// in one synchronous block does NOT work — confirmed live it never triggers a
// re-render because the list needs to yield back to the event loop between
// scroll positions.
//
// Concurrency: this script drives a single TradingView Desktop window over one
// CDP connection with coordinate-based UI clicks (see connection.js — one
// client, one target). Two tickers' navigation flows cannot safely interleave
// against that one shared window, so "concurrent" here means the ticker loop
// runs through a small concurrency-limiter (default concurrency=1, effectively
// serialized) instead of a hardcoded for-loop, with independent per-ticker
// error handling via Promise.allSettled. Passing --concurrency=N>1 is rejected
// with a clear error rather than silently corrupting UI state.
//
// Usage:
//   node scripts/fetch_option_chain.mjs                     # all six tickers
//   node scripts/fetch_option_chain.mjs AAPL MSFT           # subset
//   node scripts/fetch_option_chain.mjs --concurrency=1 AAPL

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { chart, ui } from '../src/core/index.js';
import { disconnect } from '../src/connection.js';

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'IBIT', 'META'];
const ENTRY_PRICE_CEILING = 0.45;
const MAX_EXPIRATIONS_PER_TICKER = 4;
const STORE_FILE = new URL(
  '../../fattah/detector/contract_store.jsonl',
  import.meta.url
).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TradingView's SPA re-renders asynchronously after navigation clicks — a
// find immediately after a click frequently misses because the DOM hasn't
// caught up yet (confirmed empirically: NVDA runs failed intermittently at
// fixed 500ms delays, then the same click target appeared moments later).
// Poll instead of trusting one fixed sleep.
async function pollFindElement(query, { strategy = 'text', matchText, preferTag = 'button', timeoutMs = 4000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await ui.findElement({ query, strategy });
    const visible = found.elements.filter((e) => e.visible && (!matchText || e.text === matchText));
    // Duplicate hidden/wrapper panels are common (see SKILL.md gotchas) — a
    // giant wrapper div often matches before the real clickable element does.
    // Prefer the smallest matching element of the preferred tag.
    const tagged = visible.filter((e) => e.tag === preferTag);
    const pool = tagged.length > 0 ? tagged : visible;
    if (pool.length > 0) {
      pool.sort((a, b) => a.width * a.height - b.width * b.height);
      return pool[0];
    }
    await sleep(intervalMs);
  }
  return null;
}

async function closeKnownAd() {
  // Deliberately narrow — see SKILL.md "Close Any Ad" gotcha: a broad
  // [class*="close"] sweep once closed the chain overlay's own back control.
  await ui.uiEvaluate({
    expression: `
      (function(){
        var texts = ['Learn more', 'Double your deposit', 'tastyfx'];
        var closed = 0;
        var candidates = Array.from(document.querySelectorAll('[class*="close" i]'));
        candidates.forEach(function(c){
          var box = c.closest('[class*="banner" i], [class*="promo" i], [class*="ad" i]');
          if (box && box.getBoundingClientRect().y > 700) {
            try { c.click(); closed++; } catch(e) {}
          }
        });
        return { closed: closed };
      })()
    `,
  });
}

async function dismissMarketClosedTooltip() {
  await ui.mouseClick({ x: 900, y: 600, button: 'left' });
  await sleep(200);
}

async function backToChartIfOnChainPage() {
  // If a prior run (or manual session) left the Options Chain page open,
  // calling chart.setSymbol() there updates the chain in-place instead of
  // going through the badge -> dropdown -> Options flow, which desyncs every
  // coordinate this script computes afterward. Always start from a known
  // clean main-chart state.
  const btn = await pollFindElement('Back to chart', { timeoutMs: 1500 });
  if (btn) {
    await ui.mouseClick({ x: btn.x + btn.width / 2, y: btn.y + btn.height / 2, button: 'left' });
    await sleep(1000);
  }
}

async function openOptionsChain(ticker) {
  await backToChartIfOnChainPage();
  await chart.setSymbol({ symbol: ticker });
  await sleep(1500);
  await dismissMarketClosedTooltip();

  // The dropdown chevron next to the ticker pill (top-left toolbar) sits at a
  // fixed (170, 19) across tickers in this window layout — confirmed live for
  // both AAPL and NVDA. Dynamic lookup via [aria-label="Change symbol"] is
  // NOT reliable here: that aria-label belongs to the *chart legend* text
  // (a different element than the toolbar pill), so computing an offset from
  // it lands on the wrong toolbar button (opened "Change interval" instead
  // of the Chart/Assets dropdown in testing). See SKILL.md's duplicate-panel
  // gotcha — this page renders several stacked/hidden copies of the toolbar.
  await ui.mouseClick({ x: 170, y: 19, button: 'left' });

  const optionsBtn = await pollFindElement('Options', { matchText: 'Options', preferTag: 'div' });
  if (!optionsBtn) throw new Error(`${ticker}: "Options" menu entry not found`);
  await ui.mouseClick({ x: optionsBtn.x + optionsBtn.width / 2, y: optionsBtn.y + optionsBtn.height / 2, button: 'left' });
  await sleep(1200);
  await closeKnownAd();

  const chainReady = await pollFindElement('Strike', { timeoutMs: 5000 });
  if (!chainReady) throw new Error(`${ticker}: option chain table never rendered`);

  // Widen from the default ±6 to ±10 strikes (max clean preset per SKILL.md —
  // "All strikes" mixes in greeks data that isn't needed here).
  const strikesBtn = await pollFindElement('±6 strikes', { timeoutMs: 3000 });
  const realBtn = strikesBtn?.tag === 'button' ? strikesBtn
    : (await ui.findElement({ query: '±6 strikes', strategy: 'text' })).elements.find((e) => e.tag === 'button');
  if (realBtn) {
    await ui.mouseClick({ x: realBtn.x + realBtn.width / 2, y: realBtn.y + realBtn.height / 2, button: 'left' });
    const presetEl = await pollFindElement('±10 strikes', { timeoutMs: 3000 });
    if (presetEl) {
      await ui.mouseClick({ x: presetEl.x + presetEl.width / 2, y: presetEl.y + presetEl.height / 2, button: 'left' });
      await sleep(800);
    }
  }

  await selectExpirations(ticker);
}

// Opens the "Expiration" checkbox panel and checks the next
// MAX_EXPIRATIONS_PER_TICKER - 1 nearest dates (index 0, the nearest
// expiration, is already checked by default — confirmed live). Leaves every
// selected date's rows merged into the same chain table.
async function selectExpirations(ticker) {
  const expirationBtn = await pollFindElement('Expiration', { preferTag: 'div', timeoutMs: 3000 });
  if (!expirationBtn) {
    console.warn(`${ticker}: "Expiration" control not found — falling back to nearest expiration only`);
    return;
  }
  await ui.mouseClick({ x: expirationBtn.x + expirationBtn.width / 2, y: expirationBtn.y + expirationBtn.height / 2, button: 'left' });

  const panelReady = await pollFindElement('Select all', { timeoutMs: 3000 });
  if (!panelReady) {
    console.warn(`${ticker}: expiration panel never rendered — falling back to nearest expiration only`);
    return;
  }
  await sleep(300);

  // Date rows read as short text spans like "Jul 24" (checkbox sits ~16px to
  // the left of the row's container, confirmed live). The list is already
  // sorted soonest-first, so index 0 is the pre-checked nearest expiration.
  const rows = await ui.uiEvaluate({
    expression: `
      (function(){
        var spans = Array.from(document.querySelectorAll('span')).filter(function(e){
          return /^[A-Z][a-z]{2} \\d{1,2}$/.test(e.textContent.trim()) && e.offsetParent !== null && e.children.length === 0;
        });
        var seen = {};
        var out = [];
        spans.forEach(function(e){
          var t = e.textContent.trim();
          if (seen[t]) return;
          seen[t] = 1;
          var btn = e.closest('[class*="button-"]');
          var r = (btn || e).getBoundingClientRect();
          out.push({ text: t, x: r.x, y: r.y, height: r.height });
        });
        return out;
      })()
    `,
  });
  const dateRows = rows?.result || [];
  if (dateRows.length === 0) {
    console.warn(`${ticker}: no expiration rows discovered — falling back to nearest expiration only`);
    await ui.mouseClick({ x: 900, y: 60, button: 'left' });
    return;
  }

  const toCheck = dateRows.slice(1, MAX_EXPIRATIONS_PER_TICKER);
  for (const row of toCheck) {
    await ui.mouseClick({ x: row.x + 16, y: row.y + row.height / 2, button: 'left' });
    await sleep(250);
  }
  await sleep(800);

  // Close the panel by clicking a neutral point above the table — clicking
  // the Expiration button again toggles it but its coordinates shift once
  // the badge count text changes width, so a fixed off-panel point is safer.
  await ui.mouseClick({ x: 900, y: 60, button: 'left' });
  await sleep(300);
}

async function findScrollContainer() {
  const result = await ui.uiEvaluate({
    expression: `
      (function(){
        var all = Array.from(document.querySelectorAll('*'));
        var candidates = all.filter(function(el){
          return el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200 && el.clientHeight < 900;
        });
        if (candidates.length === 0) return null;
        var el = candidates[0];
        return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
      })()
    `,
  });
  return result?.result || null;
}

function scrapeVisibleRowsExpression() {
  return `
    (function(){
      var table = document.querySelector('table');
      if (!table) return { error: 'no table found' };
      var rows = Array.from(table.querySelectorAll('tr'));
      var header = rows[1];
      var headerCells = Array.from(header.children).map(function(c){ return c.textContent.trim(); });
      var strikeIdx = headerCells.indexOf('Strike');
      if (strikeIdx === -1) return { error: 'Strike column not found', headerCells: headerCells };
      var out = [];
      for (var i = 2; i < rows.length; i++) {
        var r = rows[i];
        if (!r.hasAttribute('data-strike')) continue;
        var cells = Array.from(r.children).map(function(c){ return c.textContent.trim(); });
        var callCell = r.querySelector('[data-cell-part="call"]');
        var putCell = r.querySelector('[data-cell-part="put"]');
        out.push({
          strike: r.getAttribute('data-strike'),
          callSymbol: callCell ? callCell.getAttribute('data-cell-id') : null,
          putSymbol: putCell ? putCell.getAttribute('data-cell-id') : null,
          callAsk: cells[strikeIdx - 5],
          callBid: cells[strikeIdx - 4],
          putBid: cells[strikeIdx + 5],
          putAsk: cells[strikeIdx + 6],
        });
      }
      return { rows: out };
    })()
  `;
}

async function scrapeVisibleRows(ticker) {
  const result = await ui.uiEvaluate({ expression: scrapeVisibleRowsExpression() });
  const parsed = result?.result;
  if (!parsed || parsed.error) {
    throw new Error(`${ticker}: chain scrape failed — ${parsed?.error || 'no result'}`);
  }
  return parsed.rows;
}

// The combined multi-expiration chain is virtualized — only a window of rows
// around the current scroll position exists in the DOM at any moment
// (confirmed live: scraping at scrollTop=0 with 4 expirations checked only
// ever returns ~2 expirations' worth of rows). Scroll in small steps, waiting
// for the virtualized list to re-render between each, and merge by symbol.
async function scrapeAllExpirations(ticker) {
  const merged = new Map();
  const mergeRows = (rows) => {
    for (const row of rows) {
      const key = row.callSymbol || row.putSymbol || row.strike;
      if (!merged.has(key)) merged.set(key, row);
    }
  };

  const container = await findScrollContainer();
  if (!container) {
    // Single expiration selected (or panel discovery failed) — no scrolling
    // needed, the whole table already fits.
    mergeRows(await scrapeVisibleRows(ticker));
    return Array.from(merged.values());
  }

  const maxScroll = container.scrollHeight - container.clientHeight;
  const step = Math.max(1, Math.floor(container.clientHeight * 0.5));

  let scrollTop = 0;
  let iterations = 0;
  const MAX_ITERATIONS = 20;
  while (iterations < MAX_ITERATIONS) {
    await ui.uiEvaluate({
      expression: `
        (function(){
          var all = Array.from(document.querySelectorAll('*'));
          var el = all.filter(function(e){ return e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 200 && e.clientHeight < 900; })[0];
          if (el) el.scrollTop = ${scrollTop};
          return el ? el.scrollTop : null;
        })()
      `,
    });
    await sleep(800);
    mergeRows(await scrapeVisibleRows(ticker));

    if (scrollTop >= maxScroll) break;
    scrollTop = Math.min(scrollTop + step, maxScroll);
    iterations++;
  }

  return Array.from(merged.values());
}

function toNumber(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (t === '' || t === '—' || t === '-') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// OPRA:{TICKER}{YYMMDD}{C|P}{STRIKE} (read directly off data-cell-id, confirmed
// live) -> OPRA_DLY:...same...  the format confirmed working for
// chart_set_symbol / ohlcv pulls (session-log-2026-07-19.md, item 3).
function toDlySymbol(oprSymbol) {
  if (!oprSymbol || !oprSymbol.startsWith('OPRA:')) return null;
  return 'OPRA_DLY:' + oprSymbol.slice('OPRA:'.length);
}

// Expiration date is embedded directly in the OPRA symbol (YYMMDD) — no need
// to parse the visible "Jul 24" style UI labels for it.
function expirationFromSymbol(oprSymbol, ticker) {
  if (!oprSymbol) return null;
  const match = oprSymbol.match(new RegExp(`^OPRA:${ticker}(\\d{2})(\\d{2})(\\d{2})[CP]`));
  if (!match) return null;
  const [, yy, mm, dd] = match;
  return `20${yy}-${mm}-${dd}`;
}

function buildCandidates(ticker, rows) {
  const candidates = [];
  for (const row of rows) {
    const strike = toNumber(row.strike);
    for (const side of ['call', 'put']) {
      const ask = toNumber(side === 'call' ? row.callAsk : row.putAsk);
      const bid = toNumber(side === 'call' ? row.callBid : row.putBid);
      const rawSymbol = side === 'call' ? row.callSymbol : row.putSymbol;
      if (ask == null || ask > ENTRY_PRICE_CEILING) continue;
      const symbol = toDlySymbol(rawSymbol);
      if (!symbol) continue;
      candidates.push({
        symbol,
        strike,
        type: side === 'call' ? 'C' : 'P',
        bid,
        ask,
        expiration: expirationFromSymbol(rawSymbol, ticker),
      });
    }
  }
  return candidates;
}

async function fetchTicker(ticker) {
  console.log(`${ticker}: navigating to options chain...`);
  await openOptionsChain(ticker);
  const rows = await scrapeAllExpirations(ticker);
  console.log(`${ticker}: scraped ${rows.length} strike rows across up to ${MAX_EXPIRATIONS_PER_TICKER} expirations`);
  const candidates = buildCandidates(ticker, rows);
  console.log(`${ticker}: ${candidates.length} candidates <= $${ENTRY_PRICE_CEILING}`);
  return candidates;
}

// Minimal concurrency limiter. The ticker loop is expressed as a pool instead
// of a hardcoded for-loop so per-ticker work is decoupled (Promise.allSettled,
// independent timeouts/errors) and the pool size is a single knob — but it
// defaults to (and, for now, only accepts) concurrency=1: this script drives
// one shared TradingView Desktop window over one CDP connection with
// coordinate-based clicks, and two tickers' navigation flows interleaving
// against that single window would corrupt both (see connection.js — one
// client, one target, no multiplexing). Raise this once multiple
// windows/CDP connections are wired up.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      runNext();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

function appendToStore(runId, ticker, candidates) {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  const discoveredAt = new Date().toISOString();
  const lines = candidates.map((c) => JSON.stringify({
    run_id: runId,
    discovered_at: discoveredAt,
    ticker,
    ...c,
  }));
  if (lines.length > 0) {
    appendFileSync(STORE_FILE, lines.join('\n') + '\n');
  }
}

function parseArgs(argv) {
  let concurrency = 1;
  const tickers = [];
  for (const arg of argv) {
    const concurrencyMatch = arg.match(/^--concurrency=(\d+)$/);
    if (concurrencyMatch) {
      concurrency = Number(concurrencyMatch[1]);
      continue;
    }
    tickers.push(arg);
  }
  return { concurrency, tickers };
}

async function main() {
  const { concurrency, tickers: requested } = parseArgs(process.argv.slice(2));
  if (concurrency > 1) {
    throw new Error(
      `--concurrency=${concurrency} is not supported: this script drives a single TradingView ` +
      `Desktop window over one CDP connection with coordinate-based clicks, so ticker flows ` +
      `cannot safely run in parallel against it. Use --concurrency=1 (default).`
    );
  }

  const tickers = requested.length > 0 ? requested : TICKERS;
  for (const t of tickers) {
    if (!TICKERS.includes(t)) throw new Error(`Unknown ticker "${t}" — expected one of ${TICKERS.join(', ')}`);
  }

  const runId = randomUUID();
  const limit = createLimiter(concurrency);
  const failures = [];

  const outcomes = await Promise.allSettled(
    tickers.map((ticker) => limit(async () => {
      const candidates = await fetchTicker(ticker);
      return { ticker, candidates };
    }))
  );

  outcomes.forEach((outcome, i) => {
    const ticker = tickers[i];
    if (outcome.status === 'fulfilled') {
      appendToStore(runId, ticker, outcome.value.candidates);
    } else {
      failures.push({ ticker, message: outcome.reason?.message || String(outcome.reason) });
      console.error(`${ticker}: FAILED — ${outcome.reason?.message || outcome.reason}`);
    }
  });

  console.log(`\nAppended run ${runId} to ${STORE_FILE}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} ticker(s) failed: ${failures.map((f) => f.ticker).join(', ')}`);
    process.exitCode = 1;
  }

  await disconnect();
}

main().catch(async (err) => {
  console.error('fetch_option_chain.mjs failed:', err);
  process.exitCode = 1;
  await disconnect();
});
