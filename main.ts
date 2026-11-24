// Pump.fun replay bot — momentum paper-trader for agent-fun/replay/v2.
//
// Reads NDJSON (hello, batch..., done) on stdin, writes exactly one reply
// per batch on stdout. All money math is BigInt; u64 amounts are decimal
// strings on the wire. No randomness anywhere: every decision is a pure
// function of the hello and the batches seen so far, so two runs on the
// same tape produce identical replies.
//
// Strategy in one paragraph: watch every fresh coin in the universe,
// enter only after it proves buy-side momentum (several buys in a row,
// buy volume dominating, price already up off its open), scale in up to
// ~1.2 SOL per position in tranches capped at 1% of the mint's real SOL
// reserve, and exit on a take-profit, a stop-loss, a trailing stop off
// the peak, a sell-pressure reversal, or staleness. Every order pays
// base+priority tx fees plus ~1.25% curve fees round-trip and a seeded
// share of orders fail while still paying tx fees, so the bot only
// trades when the momentum edge is clear and never churns.

import * as readline from 'node:readline';

// ---------------------------------------------------------------------------
// Config, read from hello at runtime (never hardcoded to pilot defaults).
// ---------------------------------------------------------------------------
interface BotConfig {
  seed: string;
  capitalLamports: bigint;
  maxOpenPositions: number;
  maxOrderBps: number;
  maxOrdersPerBatch: number;
  latencySlots: number;
  baseFee: bigint;
  priorityFee: bigint;
}

const FALLBACK: BotConfig = {
  seed: '0',
  capitalLamports: 10_000_000_000n,
  maxOpenPositions: 5,
  maxOrderBps: 100,
  maxOrdersPerBatch: 16,
  latencySlots: 2,
  baseFee: 5_000n,
  priorityFee: 0n,
};

// ---------------------------------------------------------------------------
// Strategy constants (lamports; 1 SOL = 1_000_000_000).
// ---------------------------------------------------------------------------
const SOL = 1_000_000_000n;
const TARGET_POSITION = 1_200_000_000n; // ~1.2 SOL per position, all tranches
const FIRST_TRANCHE = 400_000_000n; // ~0.4 SOL first buy
const TRANCHE = 400_000_000n; // ~0.4 SOL per scale-in buy
const MAX_TRANCHES = 3;
const CASH_BUFFER = 300_000_000n; // never let cash fall below ~0.3 SOL
const MIN_BUY = 100_000_000n; // a buy smaller than ~0.1 SOL is not worth the fees
const BUY_SLIPPAGE_BPS = 400;
const SELL_SLIPPAGE_BPS = 600;
const SCALE = 10n ** 12n; // price = virtualSol * SCALE / virtualToken

// Entry: fresh coin, proven momentum.
const ENTRY_MAX_AGE_SLOTS = 150; // created within the last N slots
const ENTRY_MIN_TRADES = 5; // trades seen before we consider entering
const ENTRY_WINDOW = 12; // trades over which buy dominance is measured
const ENTRY_MIN_BUY_SHARE_BPS = 6_500; // buy volume >= 65% of window volume
const ENTRY_MIN_BUYS_IN_WINDOW = 7; // at least 7 buys in the window
const ENTRY_MIN_RISE_BPS = 800; // price up >= 8% over the last 5 trades
const ENTRY_CONSEC_BUYS = 2; // last N trades all buys
const SCALEIN_MIN_GAP_SLOTS = 2;
const SCALEIN_MIN_HOLD_BPS = 9_700; // only add while price >= 97% of entry

// Exits (all in bps against the entry price unless noted).
const TAKE_PROFIT_BPS = 13_000; // +30%
const STOP_LOSS_BPS = 8_500; // -15%
const TRAILING_BPS = 7_800; // sell when price falls to 78% of the peak
const REVERSAL_WINDOW = 8; // trades over which sell dominance ends a position
const REVERSAL_MIN_SELL_SHARE_BPS = 6_500; // sell volume >= 65% of window
const STALE_SLOTS = 240; // held this long without a gain -> exit
const STALE_MAX_BPS = 10_500; // ...unless already up >= 5%

// ---------------------------------------------------------------------------
// Per-mint state.
// ---------------------------------------------------------------------------
interface TradeRec {
  slot: number;
  buy: boolean;
  sol: bigint;
  price: bigint; // scaled price right after this trade
}

interface MintState {
  mint: string;
  createdSlot: number;
  complete: boolean;
  vSol: bigint;
  vTok: bigint;
  realSol: bigint;
  realTok: bigint;
  lastSlot: number;
  trades: TradeRec[];
  // Position bookkeeping (mirrors account.positions; cleared when flat).
  holding: boolean;
  entryPrice: bigint; // scaled price at entry (0 = unknown)
  entrySlot: number;
  peakPrice: bigint;
  tranches: number;
  lastBuySlot: number;
  spentLamports: bigint;
  // Orders we sent that have not resolved yet.
  pendingBuy: boolean;
  pendingSell: boolean;
}

function newMint(mint: string, slot: number): MintState {
  return {
    mint,
    createdSlot: slot,
    complete: false,
    vSol: 0n,
    vTok: 0n,
    realSol: 0n,
    realTok: 0n,
    lastSlot: slot,
    trades: [],
    holding: false,
    entryPrice: 0n,
    entrySlot: 0,
    peakPrice: 0n,
    tranches: 0,
    lastBuySlot: -1_000_000,
    spentLamports: 0n,
    pendingBuy: false,
    pendingSell: false,
  };
}

function priceOf(m: MintState): bigint {
  if (m.vTok <= 0n || m.vSol <= 0n) return 0n;
  return (m.vSol * SCALE) / m.vTok;
}

function pushTrade(m: MintState, slot: number, buy: boolean, sol: bigint): void {
  m.trades.push({ slot, buy, sol, price: priceOf(m) });
  if (m.trades.length > 30) m.trades.splice(0, m.trades.length - 30);
}

/** Buy/sell volume and buy count over the last `n` trades of a mint. */
function windowStats(m: MintState, n: number): { buys: number; buyVol: bigint; sellVol: bigint; total: number } {
  const w = m.trades.slice(-n);
  let buys = 0;
  let buyVol = 0n;
  let sellVol = 0n;
  for (const t of w) {
    if (t.buy) {
      buys++;
      buyVol += t.sol;
    } else {
      sellVol += t.sol;
    }
  }
  return { buys, buyVol, sellVol, total: w.length };
}

// ---------------------------------------------------------------------------
// Bot.
// ---------------------------------------------------------------------------
class Bot {
  cfg: BotConfig = { ...FALLBACK };
  mints = new Map<string, MintState>();
  cash: bigint = FALLBACK.capitalLamports;
  /** client_id -> mint, so fills can clear pending flags. */
  pending = new Map<string, { mint: string; side: 'buy' | 'sell' }>();
  orderCounter = 0;
  curSlot = 0;

  onHello(msg: any): void {
    const c = msg as any;
    this.cfg = {
      seed: typeof c.seed === 'string' ? c.seed : FALLBACK.seed,
      capitalLamports: toBig(c.capital?.lamports, FALLBACK.capitalLamports),
      maxOpenPositions: num(c.caps?.max_open_positions, FALLBACK.maxOpenPositions),
      maxOrderBps: num(c.caps?.max_order_bps_of_real_reserve, FALLBACK.maxOrderBps),
      maxOrdersPerBatch: num(c.caps?.max_orders_per_batch, FALLBACK.maxOrdersPerBatch),
      latencySlots: num(c.latency_slots, FALLBACK.latencySlots),
      baseFee: toBig(c.fees?.base_fee_lamports, FALLBACK.baseFee),
      priorityFee: toBig(c.fees?.priority_fee_lamports, FALLBACK.priorityFee),
    };
    this.cash = this.cfg.capitalLamports;
  }

  onBatch(msg: any): { type: 'reply'; seq: number; orders: any[] } {
    const seq: number = num(msg.seq, 0);
    this.curSlot = num(msg.slot, this.curSlot);
    try {
      this.applyFills(msg.fills ?? []);
      this.applyEvents(msg.events ?? []);
      this.applyMarks(msg.marks ?? []);
      this.applyAccount(msg.account);
    } catch {
      // Never let a malformed batch kill the run: fall through and reply empty.
    }
    let orders: any[] = [];
    try {
      orders = this.decide();
    } catch {
      orders = [];
    }
    // Hard safety nets: the protocol fails the run if a reply carries more
    // than replyOrderCap(hello) orders OR more than 64 KiB on one line
    // (MAX_BOT_LINE_BYTES; parseBotLine rejects an over-long line outright).
    // The count net alone is not enough: hello is read at runtime, and with
    // a large max_orders_per_batch decide() may emit hundreds of orders
    // whose JSON exceeds 64 KiB even though the count is legal. Trim from
    // the end (entries are last, exits first) and roll back the pending
    // bookkeeping of any dropped order, so its mint is not left thinking an
    // order is in flight that will never resolve.
    const cap = Math.max(64, 4 * this.cfg.maxOrdersPerBatch);
    const drop = (o: any): void => {
      const p = this.pending.get(o.client_id);
      if (!p) return;
      const m = this.mints.get(p.mint);
      if (m) {
        if (p.side === 'buy') m.pendingBuy = false;
        else m.pendingSell = false;
      }
      this.pending.delete(o.client_id);
    };
    while (orders.length > cap) drop(orders.pop());
    const MAX_LINE_BYTES = 65_536;
    const enc = new TextEncoder();
    let reply = { type: 'reply', seq, orders };
    while (orders.length > 0 && enc.encode(JSON.stringify(reply)).byteLength > MAX_LINE_BYTES) {
      drop(orders.pop());
      reply = { type: 'reply', seq, orders };
    }
    return reply;
  }

  applyFills(fills: any[]): void {
    for (const f of fills) {
      if (!f || typeof f.mint !== 'string') continue;
      const p = this.pending.get(f.client_id);
      if (p) {
        const m = this.mints.get(p.mint);
        if (m) {
          if (p.side === 'buy') m.pendingBuy = false;
          else m.pendingSell = false;
        }
        this.pending.delete(f.client_id);
      }
      // Harness closes (_complete/_flatten/_writeoff) end a position; a fill
      // for our own sell also ends it. Account state below is authoritative,
      // but clear the flags now so the same batch does not double-sell.
      if (typeof f.client_id === 'string' && f.client_id.startsWith('_')) {
        const m = this.mints.get(f.mint);
        if (m) {
          m.holding = false;
          m.pendingSell = false;
        }
      }
      if (f.status === 'filled' && f.side === 'buy') {
        const m = this.mints.get(f.mint);
        if (m) {
          m.holding = true;
          m.tranches += 1;
          m.lastBuySlot = this.curSlot;
          m.spentLamports += toBig(f.quote_lamports, 0n);
          const p = priceOf(m);
          if (m.entryPrice === 0n && p > 0n) {
            m.entryPrice = p;
            m.entrySlot = this.curSlot;
            m.peakPrice = p;
          } else if (p > m.peakPrice) {
            m.peakPrice = p;
          }
        }
      }
    }
  }

  applyEvents(events: any[]): void {
    for (const e of events) {
      if (!e || typeof e.mint !== 'string') continue;
      if (e.event === 'CreateEvent') {
        let m = this.mints.get(e.mint);
        if (!m) {
          m = newMint(e.mint, num(e.slot, this.curSlot));
          this.mints.set(e.mint, m);
        }
        m.vSol = toBig(e.virtual_sol_reserves, m.vSol);
        m.vTok = toBig(e.virtual_token_reserves, m.vTok);
        m.realTok = toBig(e.real_token_reserves, m.realTok);
        m.realSol = 0n;
        m.lastSlot = this.curSlot;
      } else if (e.event === 'TradeEvent') {
        const m = this.mints.get(e.mint);
        if (!m) continue; // never trade a mint whose create we never saw
        m.vSol = toBig(e.virtual_quote_reserves, toBig(e.virtual_sol_reserves, m.vSol));
        m.vTok = toBig(e.virtual_token_reserves, m.vTok);
        m.realSol = toBig(e.real_quote_reserves, toBig(e.real_sol_reserves, m.realSol));
        m.realTok = toBig(e.real_token_reserves, m.realTok);
        m.lastSlot = this.curSlot;
        pushTrade(m, this.curSlot, e.is_buy === true, toBig(e.quote_amount, toBig(e.sol_amount, 0n)));
        const p = priceOf(m);
        if (m.holding && p > m.peakPrice) m.peakPrice = p;
      } else if (e.event === 'CompleteEvent') {
        const m = this.mints.get(e.mint);
        if (m) {
          m.complete = true;
          m.holding = false;
          m.pendingBuy = false;
          m.pendingSell = false;
        }
      }
    }
  }

  applyMarks(marks: any[]): void {
    for (const mk of marks) {
      if (!mk || typeof mk.mint !== 'string') continue;
      const m = this.mints.get(mk.mint);
      if (!m) continue;
      // Marks carry the reserves the bot actually meets (own impact included).
      m.vSol = toBig(mk.virtual_quote_reserves, m.vSol);
      m.vTok = toBig(mk.virtual_token_reserves, m.vTok);
      m.realSol = toBig(mk.real_quote_reserves, m.realSol);
      m.realTok = toBig(mk.real_token_reserves, m.realTok);
      const p = priceOf(m);
      if (m.holding && p > m.peakPrice) m.peakPrice = p;
    }
  }

  applyAccount(account: any): void {
    if (!account) return;
    this.cash = toBig(account.cash_lamports, this.cash);
    const held = new Set<string>();
    for (const pos of account.positions ?? []) {
      if (!pos || typeof pos.mint !== 'string') continue;
      held.add(pos.mint);
      const m = this.mints.get(pos.mint);
      if (!m) continue;
      if (!m.holding) {
        // Position exists but we have no entry record (e.g. fill arrived in a
        // batch whose price we could not read): anchor on the current price.
        m.holding = true;
        const p = priceOf(m);
        if (p > 0n) {
          m.entryPrice = p;
          m.entrySlot = this.curSlot;
          m.peakPrice = p;
        }
        m.tranches = 1;
        m.spentLamports = toBig(pos.cost_lamports, 0n);
      }
      (m as any)._heldTokens = toBig(pos.token_amount, 0n);
    }
    // Positions the account no longer lists are flat: clear bookkeeping.
    for (const m of this.mints.values()) {
      if (!held.has(m.mint) && m.holding) {
        m.holding = false;
        m.entryPrice = 0n;
        m.peakPrice = 0n;
        m.tranches = 0;
        m.spentLamports = 0n;
        m.pendingSell = false;
        (m as any)._heldTokens = 0n;
      }
      if (!held.has(m.mint)) (m as any)._heldTokens = 0n;
    }
  }

  openPositions(): number {
    let n = 0;
    for (const m of this.mints.values()) if (m.holding || m.pendingBuy) n++;
    return n;
  }

  decide(): any[] {
    const orders: any[] = [];
    const maxOrders = Math.max(0, this.cfg.maxOrdersPerBatch);
    const txFee = this.cfg.baseFee + this.cfg.priorityFee;

    const push = (o: any): boolean => {
      if (orders.length >= maxOrders) return false;
      orders.push(o);
      return true;
    };
    const nextId = (prefix: string): string => {
      this.orderCounter += 1;
      return `${prefix}${this.curSlot}x${this.orderCounter}`;
    };

    // ---- Exits first: free cash and slots before considering entries. ----
    for (const m of this.mints.values()) {
      if (!m.holding || m.pendingSell || m.complete) continue;
      const tokens: bigint = (m as any)._heldTokens ?? 0n;
      if (tokens <= 0n) continue;
      const price = priceOf(m);
      if (price <= 0n || m.entryPrice <= 0n) continue;
      if (price > m.peakPrice) m.peakPrice = price;
      const vsEntry = (price * 10_000n) / m.entryPrice; // bps of entry
      const vsPeak = m.peakPrice > 0n ? (price * 10_000n) / m.peakPrice : 10_000n;
      const stats = windowStats(m, REVERSAL_WINDOW);
      const sellShare =
        stats.buyVol + stats.sellVol > 0n
          ? Number((stats.sellVol * 10_000n) / (stats.buyVol + stats.sellVol))
          : 0;
      const stale =
        this.curSlot - m.entrySlot > STALE_SLOTS && vsEntry < STALE_MAX_BPS;
      const exit =
        vsEntry >= TAKE_PROFIT_BPS ||
        vsEntry <= STOP_LOSS_BPS ||
        vsPeak <= TRAILING_BPS ||
        (stats.total >= REVERSAL_WINDOW && sellShare >= REVERSAL_MIN_SELL_SHARE_BPS && vsEntry < 10_000n) ||
        stale;
      if (!exit) continue;
      const id = nextId('s');
      if (
        push({
          side: 'sell',
          client_id: id,
          mint: m.mint,
          token_amount: tokens.toString(),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        })
      ) {
        m.pendingSell = true;
        this.pending.set(id, { mint: m.mint, side: 'sell' });
      }
    }

    // ---- Entries and scale-ins. ----
    if (this.openPositions() >= this.cfg.maxOpenPositions) return orders;
    for (const m of this.mints.values()) {
      if (orders.length >= maxOrders) break;
      if (m.complete || m.pendingBuy) continue;
      const price = priceOf(m);
      if (price <= 0n || m.realSol <= 0n) continue;

      if (m.holding) {
        // Scale-in: only while the position is healthy and tranches remain.
        if (m.tranches >= MAX_TRANCHES) continue;
        if (this.curSlot - m.lastBuySlot < SCALEIN_MIN_GAP_SLOTS) continue;
        if (m.entryPrice <= 0n) continue;
        const vsEntry = (price * 10_000n) / m.entryPrice;
        if (vsEntry < SCALEIN_MIN_HOLD_BPS) continue;
        const buy = this.sizeBuy(m, TRANCHE, txFee);
        if (buy === null) continue;
        const id = nextId('b');
        if (
          push({
            side: 'buy',
            client_id: id,
            mint: m.mint,
            quote_lamports: buy.toString(),
            max_slippage_bps: BUY_SLIPPAGE_BPS,
          })
        ) {
          m.pendingBuy = true;
          this.pending.set(id, { mint: m.mint, side: 'buy' });
        }
        continue;
      }

      // Fresh entry: needs proven momentum, not the first trade.
      if (this.openPositions() >= this.cfg.maxOpenPositions) break;
      if (this.curSlot - m.createdSlot > ENTRY_MAX_AGE_SLOTS) continue;
      if (m.trades.length < ENTRY_MIN_TRADES) continue;
      const stats = windowStats(m, ENTRY_WINDOW);
      if (stats.total < ENTRY_MIN_TRADES) continue;
      if (stats.buys < ENTRY_MIN_BUYS_IN_WINDOW) continue;
      const vol = stats.buyVol + stats.sellVol;
      if (vol <= 0n) continue;
      const buyShare = Number((stats.buyVol * 10_000n) / vol);
      if (buyShare < ENTRY_MIN_BUY_SHARE_BPS) continue;
      // Last trades must all be buys (momentum continuation, not a bounce).
      const tail = m.trades.slice(-ENTRY_CONSEC_BUYS);
      if (tail.length < ENTRY_CONSEC_BUYS || tail.some((t) => !t.buy)) continue;
      // Price up >= 8% over the last five trades.
      const ago = m.trades[Math.max(0, m.trades.length - 5)];
      if (!ago || ago.price <= 0n) continue;
      const rise = (price * 10_000n) / ago.price;
      if (rise < 10_000n + BigInt(ENTRY_MIN_RISE_BPS)) continue;

      const buy = this.sizeBuy(m, FIRST_TRANCHE, txFee);
      if (buy === null) continue;
      const id = nextId('b');
      if (
        push({
          side: 'buy',
          client_id: id,
          mint: m.mint,
          quote_lamports: buy.toString(),
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        })
      ) {
        m.pendingBuy = true;
        this.pending.set(id, { mint: m.mint, side: 'buy' });
      }
    }
    return orders;
  }

  /** Size a buy against the per-reply reserve cap, the position target and cash. */
  sizeBuy(m: MintState, want: bigint, txFee: bigint): bigint | null {
    // Per-reply cap: max_order_bps_of_real_reserve of the real SOL reserve.
    const cap = (m.realSol * BigInt(this.cfg.maxOrderBps)) / 10_000n;
    let amount = want;
    if (amount > cap) amount = cap;
    // Do not overshoot the position target.
    const remaining = TARGET_POSITION - m.spentLamports;
    if (remaining <= 0n) return null;
    if (amount > remaining) amount = remaining;
    // Keep a cash buffer plus the tx fee.
    const affordable = this.cash - CASH_BUFFER - txFee;
    if (affordable <= 0n) return null;
    if (amount > affordable) amount = affordable;
    if (amount < MIN_BUY) return null;
    return amount;
  }
}

// ---------------------------------------------------------------------------
// Wire helpers + main loop.
// ---------------------------------------------------------------------------
function toBig(v: unknown, fallback: bigint): bigint {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      return fallback;
    }
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  return fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const bot = new Bot();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a malformed harness line is not ours to fix; stay alive
    }
    if (!msg || typeof msg.type !== 'string') continue;
    if (msg.type === 'hello') {
      bot.onHello(msg);
    } else if (msg.type === 'batch') {
      const reply = bot.onBatch(msg);
      process.stdout.write(JSON.stringify(reply) + '\n');
    } else if (msg.type === 'done') {
      break;
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
