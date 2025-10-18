/* eslint-disable no-console */
// server.js — Crypto Paper Trading Bot (Render-ready)
// Mode: starts STOPPED. Use POST /start to begin the loop.
// Uses Binance public price endpoints (no key) for realistic market data.
// Paper-trading only: NO real orders, no API keys required.

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs-extra';
import dotenv from 'dotenv';

dotenv.config();

// ---------- Config ----------
const PORT = process.env.PORT || 8080;
const PAPER_MODE = (process.env.PAPER_MODE ?? 'true').toLowerCase() !== 'false';
const DEFAULT_SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,ADAUSDT,XRPUSDT,DOGEUSDT,AVAXUSDT,DOTUSDT,LINKUSDT,MATICUSDT,LTCUSDT,BCHUSDT,UNIUSDT,NEARUSDT,ATOMUSDT')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const LOOP_SECONDS = Number(process.env.LOOP_SECONDS || 30); // fetch+evaluate every N seconds
const ALLOCATION_PCT = Number(process.env.ALLOCATION_PCT || 0.10); // 10% of free cash per trade
const DATA_DIR = 'data';
const STATE_FILE = `${DATA_DIR}/state.json`;
const TRADES_FILE = `${DATA_DIR}/trades.json`;

// ---------- Helpers ----------
async function readJson(path, fallback) {
  try { return await fs.readJson(path); } catch { return fallback; }
}
async function writeJson(path, obj) {
  await fs.ensureFile(path);
  await fs.writeJson(path, obj, { spaces: 2 });
}
function nowISO() { return new Date().toISOString(); }

// EMA helper
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    if (i === 0 || prev === undefined) {
      prev = v;
      out.push(prev);
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

// Strategy: EMA(12/26) cross w/ simple position rule (1 position per symbol).
function decideSignal(series) {
  if (!series || series.length < 50) return 'HOLD';
  const closes = series.map(c => Number(c));
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const n = closes.length - 1;
  const prev = n - 1;
  const bullNow = e12[n] > e26[n];
  const bullPrev = e12[prev] > e26[prev];
  if (bullNow && !bullPrev) return 'BUY';
  if (!bullNow && bullPrev) return 'SELL';
  return 'HOLD';
}

// Binance public API (no key)
async function fetchKlines(symbol, interval='1h', limit=120) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  // Each kline: [ openTime, open, high, low, close, volume, closeTime, ... ]
  return data.map(row => ({
    t: row[6], // closeTime ms
    close: Number(row[4]),
  }));
}

async function fetchLastPrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  return Number(data.price);
}

// ---------- State ----------
let state = {
  running: false,
  paperMode: PAPER_MODE,
  symbols: DEFAULT_SYMBOLS,
  cash: 10000.0,
  equity: 10000.0,
  positions: {}, // symbol: { qty, entry, lastPrice }
  lastPrices: {}, // symbol: last
  lastSignal: {}, // symbol: 'BUY'|'SELL'|'HOLD'
  loopSeconds: LOOP_SECONDS,
  allocationPct: ALLOCATION_PCT,
  lastRun: null,
};

let trades = []; // { id, symbol, type, price, qty, time, pnl? }

// Load persisted data
async function loadAll() {
  state = await readJson(STATE_FILE, state);
  trades = await readJson(TRADES_FILE, trades);
  if (!Array.isArray(state.symbols) || state.symbols.length === 0) {
    state.symbols = DEFAULT_SYMBOLS;
  }
}
async function saveAll() {
  await writeJson(STATE_FILE, state);
  await writeJson(TRADES_FILE, trades);
}

// ---------- Trading Engine ----------
let loopTimer = null;

async function oneTick() {
  try {
    state.lastRun = nowISO();
    for (const sym of state.symbols) {
      try {
        const kl = await fetchKlines(sym, '1h', 120);
        const last = kl[kl.length - 1]?.close ?? null;
        state.lastPrices[sym] = last;
        const closes = kl.map(k => k.close);
        const signal = decideSignal(closes);
        state.lastSignal[sym] = signal;

        const pos = state.positions[sym];
        if (signal === 'BUY' && !pos) {
          if (state.cash > 1 && last) {
            const invest = state.cash * state.allocationPct;
            const qty = invest / last;
            state.cash -= invest;
            state.positions[sym] = { qty, entry: last, lastPrice: last };
            const trade = { id: `${Date.now()}-${sym}-BUY`, symbol: sym, type: 'BUY', price: last, qty, time: nowISO() };
            trades.push(trade);
            console.log(`[${sym}] BUY ${qty.toFixed(6)} @ ${last}`);
          }
        } else if (signal === 'SELL' && pos) {
          const proceeds = pos.qty * last;
          const pnl = proceeds - (pos.qty * pos.entry);
          state.cash += proceeds;
          const trade = { id: `${Date.now()}-${sym}-SELL`, symbol: sym, type: 'SELL', price: last, qty: pos.qty, time: nowISO(), pnl: Number(pnl.toFixed(2)) };
          trades.push(trade);
          delete state.positions[sym];
          console.log(`[${sym}] SELL ${pos.qty.toFixed(6)} @ ${last}  PnL=${pnl.toFixed(2)}`);
        } else if (pos && last) {
          state.positions[sym].lastPrice = last;
        }
      } catch (e) {
        console.warn(`Fetch/logic error for ${sym}:`, e.message);
      }
    }

    let posValue = 0;
    for (const [sym, p] of Object.entries(state.positions)) {
      const lp = state.lastPrices[sym] ?? p.entry;
      posValue += p.qty * lp;
    }
    state.equity = Number((state.cash + posValue).toFixed(2));
    await saveAll();
  } catch (err) {
    console.error('Tick error:', err);
  }
}

function startLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(oneTick, (state.loopSeconds || 30) * 1000);
}
function stopLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

// ---------- API ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, time: nowISO() }));

app.get('/status', async (req, res) => {
  res.json({
    running: state.running,
    paperMode: state.paperMode,
    symbols: state.symbols,
    cash: state.cash,
    equity: state.equity,
    positions: state.positions,
    lastPrices: state.lastPrices,
    lastSignal: state.lastSignal,
    loopSeconds: state.loopSeconds,
    allocationPct: state.allocationPct,
    lastRun: state.lastRun,
    tradesCount: trades.length,
  });
});

app.get('/trades', async (req, res) => res.json(trades.slice(-500)));
app.get('/positions', async (req, res) => res.json(state.positions));

app.post('/start', async (req, res) => {
  const { symbols, loopSeconds, allocationPct } = req.body || {};
  if (Array.isArray(symbols) && symbols.length > 0) state.symbols = symbols.map(s => String(s).toUpperCase());
  if (typeof loopSeconds === 'number' && loopSeconds >= 10) state.loopSeconds = loopSeconds;
  if (typeof allocationPct === 'number' && allocationPct > 0 && allocationPct <= 1) state.allocationPct = allocationPct;
  state.running = true;
  await saveAll();
  startLoop();
  res.json({ ok: true, running: state.running, symbols: state.symbols, loopSeconds: state.loopSeconds, allocationPct: state.allocationPct });
});

app.post('/stop', async (req, res) => {
  state.running = false;
  await saveAll();
  stopLoop();
  res.json({ ok: true, running: state.running });
});

app.post('/reset', async (req, res) => {
  const keepSymbols = state.symbols;
  state = {
    running: false,
    paperMode: true,
    symbols: keepSymbols,
    cash: 10000.0,
    equity: 10000.0,
    positions: {},
    lastPrices: {},
    lastSignal: {},
    loopSeconds: Number(process.env.LOOP_SECONDS || 30),
    allocationPct: Number(process.env.ALLOCATION_PCT || 0.10),
    lastRun: null,
  };
  trades = [];
  await saveAll();
  res.json({ ok: true, msg: 'Reset eseguito', state });
});

// Manual paper BUY
app.post('/buy', async (req, res) => {
  const { symbol, usd } = req.body || {};
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return res.status(400).json({ ok: false, error: 'symbol mancante' });
  try {
    const price = await fetchLastPrice(sym);
    const spend = Math.min(Number(usd || state.cash * state.allocationPct), state.cash);
    if (spend <= 0) return res.status(400).json({ ok: false, error: 'Fondi insufficienti' });
    const qty = spend / price;
    state.cash -= spend;
    state.positions[sym] = { qty, entry: price, lastPrice: price };
    trades.push({ id: `${Date.now()}-${sym}-BUY`, symbol: sym, type: 'BUY', price, qty, time: nowISO() });
    await saveAll();
    res.json({ ok: true, symbol: sym, action: 'BUY', price, qty, cash: state.cash });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Manual paper SELL
app.post('/sell', async (req, res) => {
  const { symbol } = req.body || {};
  const sym = String(symbol || '').toUpperCase();
  const pos = state.positions[sym];
  if (!pos) return res.status(400).json({ ok: false, error: 'Nessuna posizione aperta' });
  try {
    const price = await fetchLastPrice(sym);
    const proceeds = pos.qty * price;
    const pnl = proceeds - (pos.qty * pos.entry);
    state.cash += proceeds;
    trades.push({ id: `${Date.now()}-${sym}-SELL`, symbol: sym, type: 'SELL', price, qty: pos.qty, time: nowISO(), pnl: Number(pnl.toFixed(2)) });
    delete state.positions[sym];
    await saveAll();
    res.json({ ok: true, symbol: sym, action: 'SELL', price, qty: pos.qty, pnl: Number(pnl.toFixed(2)), cash: state.cash });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------- Boot --------------
(async () => {
  await fs.ensureDir(DATA_DIR);
  await loadAll();
  stopLoop(); // start STOPPED
  state.running = false;
  await saveAll();
  const server = app.listen(PORT, () => {
    console.log(`Server up on http://localhost:${PORT} (paperMode=${state.paperMode}) – starts stopped.`);
  });
  server.setTimeout(120000);
})();
