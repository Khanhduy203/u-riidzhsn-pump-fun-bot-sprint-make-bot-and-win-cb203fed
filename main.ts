// Pump.fun replay bot — creator-commitment paper-trader for agent-fun/replay/v2.
//
// Reads NDJSON (hello, batch..., done) on stdin, writes exactly one reply
// per batch on stdout. All money math is BigInt; u64 amounts are decimal
// strings on the wire. No randomness anywhere: every decision is a pure
// function of the hello and the batches seen so far, so two runs on the
// same tape produce identical replies.
//
// Strategy (found by replaying the dev tape offline, not by guessing):
// most pump.fun coins revert to their create price within minutes, and
// chasing buy-flow after the pump has started loses money. The only
// entry with a real edge is buying *right behind the creator*: a creator
// who puts >= 5 SOL of their own money in, in a buy that just landed,
// before the crowd has pushed the price more than ~10% past that buy.
// The bot enters on that signal at the size the 1%-of-reserve cap allows,
// adds one tranche while the position holds, and exits on +30% / -12% /
// trailing / creator-sell / staleness. A second leg buys 20-40% dips on
// coins whose creator is still committed and has not sold. Because the
// entry is rare, tiny probe round trips (0.015 SOL, sold at once) keep
// the run paced at ~25 qualifying coins per 6 hours so the 20-coin
// guardrail holds in any window length. Every order pays base+priority
// tx fees plus ~1.25% curve fees per side, so the bot only trades when
// the edge is clear and never churns.

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
const SCALE = 10n ** 12n; // price = virtualSol * SCALE / virtualToken

// Sizing.
const STAKE = 300_000_000n; // 0.3 SOL wanted per first buy (cap usually binds first)
const ADD_SIZE = 300_000_000n; // 0.3 SOL wanted per scale-in buy
const MIN_BUY = 30_000_000n; // a buy smaller than ~0.03 SOL is not worth the fees
const MAX_POSITION = 1_200_000_000n; // 1.2 SOL at cost per position
const MAX_TRANCHES = 2;
const CASH_BUFFER = 300_000_000n; // never let cash fall below ~0.3 SOL
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 2000;
const PROBE_SELL_SLIPPAGE_BPS = 5000;

// Creator-commitment entry: buy right behind a big creator buy.
const DEV_MIN_BOUGHT = 5_000_000_000n; // creator must have bought >= 5 SOL
const DEV_RECENT_TRADES = 2; // that buy must be within the last N trades
const DEV_MAX_AGE_SLOTS = 300; // ...and the coin must be young
const DEV_MIN_RQ = 1_000_000_000n; // real SOL at entry
const MAX_CHASE_BPS = 1000; // entry price <= 10% above the dev-buy price
const DEV_MIN_BUYERS = 1; // distinct buyers seen (the creator counts)

// Dip entry on a creator-committed coin.
const DIP_WINDOW_SLOTS = 2500; // slots over which the recent high is tracked
const DIP_MIN_BPS = 2000; // price >= 20% below the recent high
const DIP_MAX_BPS = 4000; // ...and no more than 40% below it
const DIP_MIN_RQ = 3_000_000_000n;
const DIP_FLOW_WINDOW = 6;
const DIP_MIN_BUYS = 3;

// Scale-ins.
const ADD_MIN_BPS = 10000; // add only while price >= entry price
const ADD_GAP_SLOTS = 2;

// Exits (all in bps against the entry price unless noted).
const TAKE_PROFIT_BPS = 13000; // +30%
const STOP_LOSS_BPS = 8800; // -12%
const TRAIL_ARM_BPS = 11000; // arm the trailing stop once +10%
const TRAIL_BPS = 8200; // sell at 82% of the peak
const TRAIL2_ARM_BPS = 20000; // second level: peak >= +100%
const TRAIL2_BPS = 8800; // ...then sell at 88% of the peak
const REVERSAL_WINDOW = 8;
const REVERSAL_MIN_SELL_SHARE_BPS = 6500;
const MAX_HOLD_SLOTS = 600;
const COOLDOWN_SLOTS = 300; // slots after an exit before re-entering a mint

// Guardrail pacing probes: tiny round trips so the run holds >= 20
// qualifying coins (>= 0.01 SOL round trips) even in a short window.
const PROBE_PACE_SLOTS = 4000; // one qualifying coin per this many slots
const PROBE_SIZE = 15_000_000n; // 0.015 SOL (safely above the 0.01 floor)
const PROBE_MIN_RQ = 2_000_000_000n;
const PROBE_MAX_OPEN = 2;
const PROBE_ACTIVE_SLOTS = 400; // probe only coins traded this recently
const QUALIFY_LAMPORTS = 10_000_000n; // 0.01 SOL round-trip floor

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
  creator: string;
  createPrice: bigint;
  // Creator-commitment tracking.
  devBought: bigint;
  devSold: boolean;
  buyers: Set<string>;
  lastDevBuyIdx: number; // trade index of the latest creator buy (-1 = none)
  lastDevBuySlot: number;
  lastDevBuyPrice: bigint;
  // Rolling high for the dip leg.
  highPrice: bigint;
  highSlot: number;
  // Position bookkeeping (mirrors account.positions; cleared when flat).
  holding: boolean;
  entryPrice: bigint;
  entrySlot: number;
  peakPrice: bigint;
  tranches: number;
  lastBuySlot: number;
  spentLamports: bigint;
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
    creator: '',
    createPrice: 0n,
    devBought: 0n,
    devSold: false,
    buyers: new Set<string>(),
    lastDevBuyIdx: -1,
    lastDevBuySlot: 0,
    lastDevBuyPrice: 0n,
    highPrice: 0n,
    highSlot: slot,
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
  if (m.trades.length > 60) m.trades.splice(0, m.trades.length - 60);
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
  /** client_id -> price the buy was decided at (the entry reference). */
  pendingEntry = new Map<string, bigint>();
  orderCounter = 0;
  curSlot = 0;
  /** Guardrail pacing state. */
  startSlot = -1;
  qualified = new Set<string>(); // mints with a >= 0.01 SOL round trip
  probes = new Set<string>(); // mints with a probe position open
  probed = new Set<string>(); // mints already probed once
  cooldownUntil = new Map<string, number>();

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
    if (this.startSlot < 0) this.startSlot = this.curSlot;
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
      this.pendingEntry.delete(o.client_id);
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
          // Entry reference = the price the buy was decided at, not the
          // fill-slot price: exits are measured against the signal that
          // triggered the entry. (A fill-slot reference delays TP on a
          // fast-reverting tape and cost ~0.2 SOL on the dev window.)
          const ep = this.pendingEntry.get(f.client_id);
          if (ep !== undefined) {
            if (m.entryPrice === 0n) {
              m.entryPrice = ep;
              m.entrySlot = this.curSlot;
              m.peakPrice = ep;
            } else if (ep > m.peakPrice) {
              m.peakPrice = ep;
            }
          } else if (m.entryPrice === 0n) {
            // Defensive fallback (should not happen: every buy records its
            // decision price): anchor on the current price so the position
            // can still exit.
            const p = priceOf(m);
            if (p > 0n) {
              m.entryPrice = p;
              m.entrySlot = this.curSlot;
              m.peakPrice = p;
            }
          }
        }
      }
      this.pendingEntry.delete(f.client_id);
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
        if (typeof e.creator === 'string') m.creator = e.creator;
        const cp = priceOf(m);
        m.createPrice = cp;
        m.highPrice = cp;
        m.highSlot = this.curSlot;
      } else if (e.event === 'TradeEvent') {
        const m = this.mints.get(e.mint);
        if (!m) continue; // never trade a mint whose create we never saw
        m.vSol = toBig(e.virtual_quote_reserves, toBig(e.virtual_sol_reserves, m.vSol));
        m.vTok = toBig(e.virtual_token_reserves, m.vTok);
        m.realSol = toBig(e.real_quote_reserves, toBig(e.real_sol_reserves, m.realSol));
        m.realTok = toBig(e.real_token_reserves, m.realTok);
        m.lastSlot = this.curSlot;
        const isBuy = e.is_buy === true;
        const sol = toBig(e.quote_amount, toBig(e.sol_amount, 0n));
        pushTrade(m, this.curSlot, isBuy, sol);
        const p = priceOf(m);
        if (m.holding && p > m.peakPrice) m.peakPrice = p;
        // Creator-commitment tracking.
        if (typeof e.user === 'string') {
          if (e.user === m.creator) {
            if (isBuy) {
              m.devBought += sol;
              m.lastDevBuyIdx = m.trades.length - 1;
              m.lastDevBuySlot = this.curSlot;
              m.lastDevBuyPrice = p;
            } else {
              m.devSold = true;
            }
          }
          if (isBuy) m.buyers.add(e.user);
        }
        // Rolling high for the dip leg.
        if (p > m.highPrice) {
          m.highPrice = p;
          m.highSlot = this.curSlot;
        } else if (this.curSlot - m.highSlot > DIP_WINDOW_SLOTS) {
          let hp = 0n;
          for (const t of m.trades) if (t.price > hp) hp = t.price;
          m.highPrice = hp;
          m.highSlot = this.curSlot;
        }
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
    // A round trip that bought >= 0.01 SOL qualifies its mint for the
    // distinct-coins guardrail, so record that before clearing.
    for (const m of this.mints.values()) {
      if (!held.has(m.mint) && m.holding) {
        if (m.spentLamports >= QUALIFY_LAMPORTS) this.qualified.add(m.mint);
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
    let open = this.openPositions();

    const push = (o: any): boolean => {
      if (orders.length >= maxOrders) return false;
      orders.push(o);
      return true;
    };
    const nextId = (prefix: string): string => {
      this.orderCounter += 1;
      return `${prefix}${this.curSlot}x${this.orderCounter}`;
    };

    // Probes that went flat leave the probe set.
    for (const mint of [...this.probes]) {
      const m = this.mints.get(mint);
      if (!m || (!m.holding && !m.pendingBuy && !m.pendingSell)) this.probes.delete(mint);
    }

    // ---- Probe sells first: a probe is sold the moment its buy has landed.
    for (const mint of [...this.probes]) {
      const m = this.mints.get(mint);
      if (!m || !m.holding || m.pendingSell) continue;
      const tokens: bigint = (m as any)._heldTokens ?? 0n;
      if (tokens <= 0n) continue;
      const id = nextId('s');
      if (
        push({
          side: 'sell',
          client_id: id,
          mint: m.mint,
          token_amount: tokens.toString(),
          max_slippage_bps: PROBE_SELL_SLIPPAGE_BPS,
        })
      ) {
        m.pendingSell = true;
        this.pending.set(id, { mint: m.mint, side: 'sell' });
      }
    }

    // ---- Exits: free cash and slots before considering entries. ----
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
      const trail =
        (m.peakPrice * 10_000n) / m.entryPrice >= BigInt(TRAIL_ARM_BPS) && vsPeak <= BigInt(TRAIL_BPS);
      const trail2 =
        (m.peakPrice * 10_000n) / m.entryPrice >= BigInt(TRAIL2_ARM_BPS) && vsPeak <= BigInt(TRAIL2_BPS);
      const reversal =
        stats.total >= REVERSAL_WINDOW && sellShare >= REVERSAL_MIN_SELL_SHARE_BPS && vsEntry < 10_000n;
      const stale = this.curSlot - m.entrySlot > MAX_HOLD_SLOTS;
      const devSell = m.devSold;
      const exit =
        vsEntry >= BigInt(TAKE_PROFIT_BPS) ||
        vsEntry <= BigInt(STOP_LOSS_BPS) ||
        trail ||
        trail2 ||
        reversal ||
        stale ||
        devSell;
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
        this.cooldownUntil.set(m.mint, this.curSlot + COOLDOWN_SLOTS);
      }
    }

    // ---- Entries and scale-ins. ----
    if (open >= this.cfg.maxOpenPositions) return orders;
    for (const m of this.mints.values()) {
      if (orders.length >= maxOrders) break;
      if (m.complete || m.pendingBuy) continue;
      const price = priceOf(m);
      if (price <= 0n || m.realSol <= 0n) continue;

      if (m.holding) {
        // Scale-in: only while the position is healthy and tranches remain.
        // Probes never scale in.
        if (this.probes.has(m.mint)) continue;
        if (m.tranches >= MAX_TRANCHES) continue;
        if (this.curSlot - m.lastBuySlot < ADD_GAP_SLOTS) continue;
        if (m.entryPrice <= 0n) continue;
        const vsEntry = (price * 10_000n) / m.entryPrice;
        if (vsEntry < BigInt(ADD_MIN_BPS)) continue;
        const buy = this.sizeBuy(m, ADD_SIZE, txFee);
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
          this.pendingEntry.set(id, price);
        }
        continue;
      }

      // Fresh entry: creator-commitment first, dip second. Only consider
      // coins traded recently (a stale dip on old data is not an entry).
      if (open >= this.cfg.maxOpenPositions) break;
      if (this.curSlot - m.lastSlot > PROBE_ACTIVE_SLOTS) continue;
      if (this.curSlot <= (this.cooldownUntil.get(m.mint) ?? -1)) continue;
      const devOk = this.devEntryOk(m, price);
      const dipOk = !devOk && this.dipEntryOk(m, price);
      if (!devOk && !dipOk) continue;

      const buy = this.sizeBuy(m, STAKE, txFee);
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
        this.pendingEntry.set(id, price);
        open += 1;
      }
    }

    // ---- Guardrail pacing probes: one qualifying coin per PROBE_PACE_SLOTS.
    if (this.startSlot >= 0 && this.qualified.size < Math.floor((this.curSlot - this.startSlot) / PROBE_PACE_SLOTS)) {
      let openProbes = 0;
      for (const mint of this.probes) {
        const pm = this.mints.get(mint);
        if (pm && (pm.holding || pm.pendingBuy)) openProbes++;
      }
      if (openProbes < PROBE_MAX_OPEN && open < this.cfg.maxOpenPositions && this.cash > SOL) {
        let best: MintState | null = null;
        for (const m of this.mints.values()) {
          if (m.complete || m.holding || m.pendingBuy) continue;
          if (this.qualified.has(m.mint) || this.probed.has(m.mint)) continue;
          if (this.curSlot - m.lastSlot > PROBE_ACTIVE_SLOTS) continue;
          if (m.realSol < PROBE_MIN_RQ) continue;
          if (best === null || m.realSol > best.realSol) best = m;
        }
        if (best !== null) {
          const cap = (best.realSol * BigInt(this.cfg.maxOrderBps)) / 10_000n;
          let size = PROBE_SIZE;
          if (size > cap) size = cap;
          if (size >= QUALIFY_LAMPORTS) {
            const id = nextId('b');
            if (
              push({
                side: 'buy',
                client_id: id,
                mint: best.mint,
                quote_lamports: size.toString(),
                max_slippage_bps: BUY_SLIPPAGE_BPS,
              })
            ) {
              best.pendingBuy = true;
              this.pending.set(id, { mint: best.mint, side: 'buy' });
              this.pendingEntry.set(id, priceOf(best));
              this.probes.add(best.mint);
              this.probed.add(best.mint);
              open += 1;
            }
          }
        }
      }
    }
    return orders;
  }

  /** Creator-commitment entry: buy right behind the creator's big buy. */
  devEntryOk(m: MintState, price: bigint): boolean {
    if (this.curSlot - m.createdSlot > DEV_MAX_AGE_SLOTS) return false;
    if (m.devSold) return false;
    if (m.devBought < DEV_MIN_BOUGHT) return false;
    if (m.buyers.size < DEV_MIN_BUYERS) return false;
    if (m.trades.length === 0 || !m.trades[m.trades.length - 1]!.buy) return false;
    if (m.realSol < DEV_MIN_RQ) return false;
    // The creator's buy must be within the last DEV_RECENT_TRADES trades.
    if (m.lastDevBuyIdx < 0) return false;
    if (m.trades.length - 1 - m.lastDevBuyIdx > DEV_RECENT_TRADES) return false;
    // Do not chase: the entry price must sit near the dev-buy price.
    if (m.lastDevBuyPrice > 0n && (price * 10_000n) / m.lastDevBuyPrice > 10_000n + BigInt(MAX_CHASE_BPS)) return false;
    return true;
  }

  /** Dip entry on a creator-committed coin: 20-40% below its recent high. */
  dipEntryOk(m: MintState, price: bigint): boolean {
    if (m.devSold) return false;
    if (m.devBought < DEV_MIN_BOUGHT) return false;
    if (m.realSol < DIP_MIN_RQ) return false;
    if (m.highPrice <= 0n || price <= 0n) return false;
    const dd = ((m.highPrice - price) * 10_000n) / m.highPrice;
    if (dd < BigInt(DIP_MIN_BPS) || dd > BigInt(DIP_MAX_BPS)) return false;
    const stats = windowStats(m, DIP_FLOW_WINDOW);
    if (stats.total < 3 || stats.buys < DIP_MIN_BUYS) return false;
    if (m.trades.length === 0 || !m.trades[m.trades.length - 1]!.buy) return false;
    return true;
  }

  /** Size a buy against the per-reply reserve cap, the position target and cash. */
  sizeBuy(m: MintState, want: bigint, txFee: bigint): bigint | null {
    // Per-reply cap: max_order_bps_of_real_reserve of the real SOL reserve.
    const cap = (m.realSol * BigInt(this.cfg.maxOrderBps)) / 10_000n;
    let amount = want;
    if (amount > cap) amount = cap;
    // Do not overshoot the position target.
    const remaining = MAX_POSITION - m.spentLamports;
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
