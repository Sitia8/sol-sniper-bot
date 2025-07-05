import { Subject } from 'rxjs';
import { Connection, PublicKey } from '@solana/web3.js';
import { PoolEvent, PumpfunScanner } from './scanner';
import logger from '../utils/logger';
import { FeatureLogger } from '../ml/featureLogger';
import { GbmPredictor } from '../ml/gbmPredictor';
import fs from 'fs';
import path from 'path';

import { percentChange } from '../utils/mcap';

export interface TradeSignal {
  mint: PublicKey;
  action: 'BUY' | 'SELL';
  reason?: 'TP' | 'SL';
  symbol?: string; // token ticker/name
  price?: number;   // price at time of signal
  time?: number;    // unix timestamp (s) of signal
}

interface TokenState {
  noBuyTimer?: NodeJS.Timeout; // auto-stop timer
  entryFeatures?: number[];
  liquidity: number;          // SOL liquidity when first tracked
  volumeSol: number;          // cumulative traded volume (SOL)
  highestPrice: number;       // highest observed price since tracking
  lowestPrice: number;        // lowest observed price since tracking
  entryPrice?: number;        // price at entry
  entrySol?: number;          // size of entry in SOL
  peakSinceEntry?: number;    // highest price observed after entry (for trailing SL)
  peakLiquidity?: number;     // highest observed liquidity since tracking
  isExceptional?: boolean;    // flag once exceptional momentum detected
  trades: {ts: number, sol: number, wallet: string}[];  // recent trades
  wallets: {addr: string, ts: number}[]; // recent unique wallets
  emaShort?: number;
  emaLong?: number;
  atr?: number;
  lastPrice?: number;
  hasBought: boolean;         // whether we already bought
  createdAt: number;          // unix timestamp (seconds)
  initialTokens?: number;    // tokens in curve at tracking start
  transferFeeBps?: number;    // transfer fee (basis points) if any
  isBundler?: boolean;        // whether initial TX used bundler
  riskChecked?: boolean;      // risk assessment completed
  devWallet?: string;         // creator wallet
  devSold?: boolean;
  devFirstToken?: boolean;
  symbol?: string;
  devSoldSol?: number;        // cumulative SOL that dev sold (for previous logic)
  nextDevCheck?: number;      // ts when we can query balance again          // whether dev has sold
}

/**
 * Simple momentum-based strategy.
 *
 * BUY: enter when price has risen by `momentum_buy_pct` (default 50%) from the lowest price seen
 *      since tracking began, provided liquidity/volume/age constraints are met.
 * SELL: take profit when PnL ≥ `take_profit` (default 90% ≃ ×1.9). Stop-loss when PnL ≤ `stop_loss`.
 */
export class MomentumStrategy {
  private featureLogger?: FeatureLogger;
  private predLogger?: FeatureLogger;

  private gbmBuy?: GbmPredictor;
  private gbmSell?: GbmPredictor;
  private pureML: boolean = false;
  private buyThreshold: number = 0.5;
  private sellThreshold: number = 0.5;

  private settlePosition(id: string, state: TokenState, exitPrice: number) {
    if (state.entryPrice && state.entrySol) {
      const pnlSol = state.entrySol * (exitPrice - state.entryPrice) / state.entryPrice;
      this.profitSol += pnlSol;
      this.investedSol = Math.max(0, this.investedSol - state.entrySol);
      this.pnl$.next(this.profitSol); // emit cumulative SOL profit
      logger.info(`Cumulative PnL ${this.profitSol.toFixed(3)} SOL`);
    }
  }

  // No-op placeholder since OnlineModel was removed
  private updateModel(mintId: string, state: TokenState, exitPrice: number) {}

  private profitSol = 0;             // realized profit in SOL
  private investedSol = 0;          // current open position size in SOL
  private totalInvestedSol = 0;     // cumulative capital committed across all trades
  public pnl$ = new Subject<number>(); // emits cumulative realized PnL %
  private states: Map<string, TokenState> = new Map();
  private devTokenCount: Map<string, number> = new Map();
  private devLastTicker: Map<string, string> = new Map(); // dev wallet -> last token symbol
  // Blacklist developers for a period after we buy one of their tokens
  private devBlacklist: Map<string, number> = new Map(); // dev wallet -> expiry (unix sec)

  private stopTracking(id: string) {
    this.states.delete(id);
    this.scanner?.unsubscribeMint(id);
  }
  public signals$ = new Subject<TradeSignal>();

  constructor(private connection: Connection, private config: any, private scanner?: PumpfunScanner) {
    if (config.feature_logging) {
      const path = config.feature_log_path || 'data/features.log';
      this.featureLogger = new FeatureLogger(path);
    }
    // Optional prediction logging
    if (config.pred_logging) {
      const predPath = config.pred_log_path || 'data/predictions.log';
      this.predLogger = new FeatureLogger(predPath);
    }
  
  
  
  
    // ---- LightGBM inference ----
    if (config.lgbm_enabled) {
      try {
        const modelDir = config.lgbm_model_dir || config.models_dir || 'models';
        const buyPath = path.join(modelDir, 'buy.json');
        const sellPath = path.join(modelDir, 'sell.json');
        if (fs.existsSync(buyPath)) {
          this.gbmBuy = new GbmPredictor(buyPath);
        }
        if (fs.existsSync(sellPath)) {
          this.gbmSell = new GbmPredictor(sellPath);
        }
        this.buyThreshold = (config.lgbm_threshold_buy ?? config.buy_threshold) ?? 0.5;
        this.sellThreshold = (config.lgbm_threshold_sell ?? config.sell_threshold) ?? 0.5;
        logger.info(`LightGBM models loaded (buy≥${this.buyThreshold}, sell≥${this.sellThreshold}).`);
        this.pureML = Boolean(config.pure_ml);
      } catch (e) {
        logger.error('Failed to load LightGBM models', e);
      }
    }
  }

  // ---- POOL EVENT ----
  onPool(event: PoolEvent) {
    // --- Optional: skip if dev repeats same ticker ---
    if (this.config.skip_dev_same_ticker && event.devWallet && event.symbol) {
      const last = this.devLastTicker.get(event.devWallet)?.toLowerCase();
      const curr = event.symbol.toLowerCase();
      if (last && last === curr) {
        if (this.config.debug_filters) logger.debug(`Skip token ${curr} from dev ${event.devWallet}: same ticker as previous`);
        // update last ticker timestamp but do not track
        this.devLastTicker.set(event.devWallet, curr);
        return;
      }
      this.devLastTicker.set(event.devWallet, curr);
    }
    const now = Date.now() / 1000;
    if (now - event.createdAt > (this.config.token_max_age ?? 600)) return;
    if (event.initialMcap < (this.config.min_initial_mcap ?? 0)) return;
    if (event.initialMcap > (this.config.max_initial_liquidity_sol ?? Infinity)) return;

    const id = event.mint.toBase58();
    if (!this.states.has(id)) {
      // track how many tokens this dev has launched during runtime
      let devFirst = false;
      if (event.devWallet) {
        const prev = this.devTokenCount.get(event.devWallet) ?? 0;
        this.devTokenCount.set(event.devWallet, prev + 1);
        devFirst = prev === 0;
      }

      const noTradeTimeoutSec = this.config.no_trade_timeout_sec ?? 60;
      const stateObj: TokenState = {
        liquidity: event.initialMcap,
        volumeSol: 0,
        highestPrice: 0,
        lowestPrice: Number.MAX_VALUE,
        peakLiquidity: event.initialMcap,
        trades: [],
        wallets: [],
        hasBought: false,
        isExceptional: false,
        createdAt: now,
        devFirstToken: devFirst,
        symbol: event.symbol,
        devWallet: event.devWallet,
        devSold: false,
        riskChecked: false
      };
      this.states.set(id, stateObj);

      // schedule auto-untrack if no BUY within timeout
      stateObj.noBuyTimer = setTimeout(() => {
        const s = this.states.get(id);
        if (s && !s.hasBought) {
          logger.debug(`Auto-stop ${event.symbol ?? id}: no BUY within ${noTradeTimeoutSec}s`);
          this.stopTracking(id);
        }
      }, noTradeTimeoutSec * 1000);

      logger.info(`Tracking token ${event.symbol ?? id}`);
      // Option to disable tax & bundler risk filters entirely via config
      if (this.config.enable_tax_bundler_filter === false) {
        const s = this.states.get(id);
        if (s) s.riskChecked = true;
        return;
      }
      // Asynchronously assess transfer-fee and bundler risk
      const stateRef = this.states.get(id);
      this.assessTokenRisk(event.mint, (event as any).signature)
        .then(({ feeBps, bundler }) => {
          if (!stateRef) return;
          if (feeBps !== null) stateRef.transferFeeBps = feeBps;
          logger.debug(`Risk assessed ${event.symbol ?? id}: fee=${feeBps ?? 'n/a'}bps bundler=${bundler}`);
          stateRef.riskChecked = true;
          stateRef.isBundler = bundler;
          const maxBps = this.config.max_transfer_fee_bps ?? 0; // 0 = forbid fee tokens by default
          const allowBundler = Boolean(this.config.allow_bundler);
          const isFeeBlock = (feeBps !== null && feeBps > maxBps);
          const isBundleBlock = (bundler && !allowBundler);
          if (isFeeBlock || isBundleBlock) {
            logger.warn(`Filtered token ${event.symbol ?? id} (fee ${feeBps ?? 'n/a'} bps, bundler=${bundler})`);
            this.stopTracking(id);
          } else {
            logger.debug(`Passed risk check ${event.symbol ?? id}: fee=${feeBps ?? 'n/a'}bps bundler=${bundler}`);
          }
        })
        .catch((e) => {
          logger.error(`Risk assessment failed for ${event.symbol ?? id}: ${e}`);
          if (stateRef) stateRef.riskChecked = true;
        });
    }
  }

  // ---- PRICE EVENT ----
  onPrice(mint: PublicKey, price: number, volumeSol?: number, liquidity?: number, wallet?: string, side?: 'buy' | 'sell', tokensCurve?: number) {
    const now = Date.now() / 1000;
    const id = mint.toBase58();
    const state = this.states.get(id);
    if (!state) return;

    // Record initial token supply to anticipate migration fill
    if (state && state.initialTokens === undefined && typeof tokensCurve === 'number' && tokensCurve > 0) {
      state.initialTokens = tokensCurve;
    }

    // Update liquidity & volume & trades
    if (typeof liquidity === 'number') {
      // drop if liquidity (proxy of mcap) < threshold
      const minMcap = this.config.min_runtime_mcap_sol ?? 30;
      if (liquidity < minMcap) {
        if (this.config.debug_filters) logger.debug(`Stop tracking ${state.symbol ?? id}: liquidity ${liquidity.toFixed(2)} < ${minMcap}`);
        this.stopTracking(id);
        return;
      }
      state.liquidity = liquidity;
      // track peak liquidity for rug detection
      if (!state.peakLiquidity || liquidity > state.peakLiquidity) {
        state.peakLiquidity = liquidity;
      }
    }
    if (typeof volumeSol === 'number') state.volumeSol += volumeSol;

    // Record trade info
    const ts = Date.now();
    state.trades.push({ ts, sol: volumeSol ?? 0, wallet: wallet ?? '' });
    const windowMs = this.config.tps_window_ms ?? 4000;
// Detect first dev sell → schedule balance check
    if (state.devWallet && wallet === state.devWallet && side === 'sell') {
      state.nextDevCheck = Date.now(); // check now
    }

    // Periodic balance check: has dev fully exited?
    if (!state.devSold && state.devWallet && (state.nextDevCheck ?? 0) <= Date.now()) {
      state.nextDevCheck = Date.now() + 15000; // re-check in 15s
      this.hasDevExited(mint, state.devWallet).then((exited) => {
        if (exited) {
          state.devSold = true;
          logger.info(`Dev fully exited ${state.symbol ?? id}, buys enabled`);
        } else if (this.config.debug_filters) {
          logger.debug(`Dev still holds position ${state.symbol ?? id}`);
        }
      });
    }

    // Update wallet list
state.wallets = (state.wallets ?? []).filter(w => ts - w.ts <= windowMs);
if (wallet) state.wallets.push({addr: wallet, ts});
    // Remove old
    state.trades = state.trades.filter((tr) => ts - tr.ts <= windowMs);
    const tradeCount = state.trades.length;
    const tps = tradeCount / (windowMs / 1000);
    const windowVolume = state.trades.reduce((acc, tr) => acc + tr.sol, 0);
const uniqueWallets = new Set(state.wallets.map(w=>w.addr)).size;
    const avgSol = tradeCount ? windowVolume / tradeCount : 0;

// ===== Update EMA & ATR =====
const shortMs = this.config.ema_short_ms ?? 4000;
const longMs = this.config.ema_long_ms ?? 12000;
const alphaShort = 2 / ((shortMs / (windowMs / tradeCount || 1)) + 1);
const alphaLong = 2 / ((longMs / (windowMs / tradeCount || 1)) + 1);
state.emaShort = state.emaShort === undefined ? price : price * alphaShort + state.emaShort * (1 - alphaShort);
state.emaLong = state.emaLong === undefined ? price : price * alphaLong + state.emaLong * (1 - alphaLong);
if (state.lastPrice !== undefined) {
  const tr = Math.abs(price - state.lastPrice);
  const atrWindow = this.config.atr_window_sec ?? 20;
  const alphaAtr = 2 / (atrWindow + 1);
  state.atr = state.atr === undefined ? tr : tr * alphaAtr + state.atr * (1 - alphaAtr);
}
state.lastPrice = price;

    // ---- Build feature vector ----
    const riseFromLow = state.lowestPrice ? (price / state.lowestPrice) - 1 : 0;
    const riseFromEntry = state.entryPrice ? (price / state.entryPrice) - 1 : 0;
    const emaGap = (state.emaShort !== undefined && state.emaLong !== undefined && price > 0)
      ? (state.emaShort - state.emaLong) / price
      : 0;
    const atrRatio = state.atr && price ? state.atr / price : 0;
    const tokenAgeMin = state.createdAt ? (now - state.createdAt) / 60 : 0;
    const drawdown = state.peakSinceEntry ? (state.peakSinceEntry / price) - 1 : 0;
    const feat = [
      Math.log(price + 1e-12),       // 0 price log
      Math.log((state.liquidity ?? 0) + 1), // 1 liquidity log
      tps / 10,                      // 2 TPS normalised
      riseFromLow,                   // 3 momentum from low
      uniqueWallets / 10,            // 4 diversity
      emaGap,                        // 5 EMA spread
      atrRatio,                      // 6 volatility
      tokenAgeMin / 60,              // 7 age (hrs)
      drawdown,                      // 8 drawdown from peak
      riseFromEntry,                 // 9 current PnL
    ];

    if (!state.riskChecked) {
      if (this.config.debug_filters) logger.debug(`Skip BUY ${state.symbol ?? id}: risk check pending`);
      return;
    }
    const requireDevSold = this.config.require_dev_sold !== false; // default true
    const skipFirst = this.config.skip_dev_first_token !== false; // default true
    if (skipFirst && state.devFirstToken) {
       if (this.config.debug_filters) logger.debug(`Skip BUY ${state.symbol ?? id}: dev's first token – untracking`);
       this.stopTracking(id);
       return;
     }

    if (requireDevSold && !state.devSold) {
      if (this.config.debug_filters) logger.debug(`Skip BUY ${state.symbol ?? id}: dev still holds tokens`);
      return;
    }

    // ---- LightGBM predict ----
    if (this.gbmBuy) {
      const pBuy = this.gbmBuy.predict(feat);
      this.predLogger?.log({ ts: now, mint: id, p_buy_lgbm: pBuy });
      if (!state.hasBought && pBuy >= this.buyThreshold) {
        state.entryPrice = price;
        state.entrySol = this.config.trade_size_sol ?? 0.5;
        this.investedSol += state.entrySol;
        this.totalInvestedSol += state.entrySol;
        state.peakSinceEntry = price;
        // clear auto-stop timer
          if (state.noBuyTimer) { clearTimeout(state.noBuyTimer); state.noBuyTimer = undefined; }
          state.hasBought = true;
        if (state.devWallet) {
          const blkSec = this.config.dev_blacklist_sec ?? 3600;
          this.devBlacklist.set(state.devWallet, now + blkSec);
        }
        state.entryFeatures = feat;
        this.signals$.next({ mint, action: 'BUY', price, symbol: state.symbol, time: now });
        logger.info(`ML BUY ${state.symbol ?? id} at ${price} (p=${pBuy.toFixed(3)})`);
      }
    }



    // ---- Feature logging (Step0) ----
    if (this.featureLogger) {
      // reuse riseFromLow / riseFromEntry computed above
      this.featureLogger.log({
        ts: now,
        mint: id,
        price,
        liquidity: state.liquidity,
        tps,
        uniqueWallets,
        riseFromLow,
        riseFromEntry,
        emaGap,
        atrRatio,
        tokenAgeMin,
        drawdown,
        transferFeeBps: state.transferFeeBps ?? 0,
        isBundler: state.isBundler ?? false,
        hasBought: state.hasBought,
      });
    }

    // Rug detection: sudden liquidity drop
    const rugDropPct = this.config.rug_liquidity_drop_pct ?? 0.4; // 40%
    if (state.hasBought && state.peakLiquidity && state.liquidity < state.peakLiquidity * (1 - rugDropPct)) {
      this.signals$.next({ mint, action: 'SELL', reason: 'SL', price, symbol: state.symbol, time: now });
      this.settlePosition(id, state, price);

      this.updateModel(id, state, price);
      logger.warn(`RUG detected on ${state.symbol ?? id} – liquidity dropped ${(percentChange(state.peakLiquidity, state.liquidity) * 100).toFixed(1)}%`);
      this.stopTracking(id);
      return;
    }

    // Track extrema
    if (price > state.highestPrice) state.highestPrice = price;
    if (price < state.lowestPrice) state.lowestPrice = price;

    // ======== BUY LOGIC ========
    if (state.hasBought && this.gbmSell) {
      const pSell = this.gbmSell.predict(feat);
      this.predLogger?.log({ ts: now, mint: id, p_sell_lgbm: pSell });
      if (pSell >= this.sellThreshold) {
        this.signals$.next({ mint, action: 'SELL', reason: 'TP', price, symbol: state.symbol, time: now });
        this.settlePosition(id, state, price);
        this.updateModel(id, state, price);
        logger.info(`ML SELL ${state.symbol ?? id} p=${pSell.toFixed(3)}`);
        this.stopTracking(id);
        return;
      }
    }

    if (!state.hasBought && !this.pureML) {
      // Basic guards
      const ageSec = now - state.createdAt;
      if (ageSec > (this.config.token_max_age ?? 600)) {
        // Token got too old without suitable momentum → stop tracking
        this.stopTracking(id);
        return;
      }
      if (state.liquidity < (this.config.min_liquidity_sol ?? 0)) return;
      if (state.volumeSol < (this.config.min_volume_sol ?? 0)) return;

      const debug = this.config.debug_filters;
      // ---- Dev blacklist check ----
      if (state.devWallet) {
        const exp = this.devBlacklist.get(state.devWallet);
        if (exp && exp > now) {
          if (debug) logger.debug(`Skip BUY ${state.symbol ?? id}: dev ${state.devWallet} blacklisted (${Math.round(exp - now)}s left)`);
          return; // skip buying tokens from this dev within blacklist window
        }
      }
      const minTps = this.config.min_tps ?? 5;
      if (tps < minTps){ if(debug) logger.debug(`Skip BUY ${state.symbol ?? id}: tps ${tps.toFixed(2)} < ${minTps}`); return; }
const minWallets = this.config.min_unique_wallets ?? 0;
if (uniqueWallets < minWallets){ if(debug) logger.debug(`Skip BUY ${state.symbol ?? id}: wallets ${uniqueWallets} < ${minWallets} (current set: ${state.wallets.map(w=>w.addr).join(',')})`); return; }

      const maxAvgSol = this.config.max_avg_sol_per_tx ?? 2;
      if (avgSol > maxAvgSol){ if(debug) logger.debug(`Skip BUY ${state.symbol ?? id}: avgSol ${avgSol.toFixed(3)} > ${maxAvgSol}`); return; }

      const exceptionalPct = this.config.exceptional_momentum_pct ?? 2; // +200%
      const rise = percentChange(state.lowestPrice, price);

      if (rise >= exceptionalPct) { if(debug) logger.debug(`BUY trigger on ${state.symbol ?? id}: rise ${(rise*100).toFixed(1)}% >= ${(exceptionalPct*100).toFixed(1)}%`);
        // Enter position
        state.entryPrice = price;
        state.entrySol = this.config.trade_size_sol ?? 0.5;
        this.investedSol += state.entrySol;
        this.totalInvestedSol += state.entrySol;
        state.peakSinceEntry = price;
        // clear auto-stop timer
          if (state.noBuyTimer) { clearTimeout(state.noBuyTimer); state.noBuyTimer = undefined; }
          state.hasBought = true;
        if (state.devWallet) {
          const blkSec = this.config.dev_blacklist_sec ?? 3600;
          this.devBlacklist.set(state.devWallet, now + blkSec);
        }
        state.entryFeatures = feat;
        state.isExceptional = true;
        this.signals$.next({ mint, action: 'BUY', price, symbol: state.symbol, time: now });
        logger.info(`BUY ${state.symbol ?? id} at ${price} (EXCEPTIONAL rise ${(rise * 100).toFixed(1)}% from low)`);
      }
      if(debug) logger.debug(`Still tracking ${state.symbol ?? id}: rise ${(rise*100).toFixed(1)}% < ${(exceptionalPct*100).toFixed(1)}%`);
      return; // do not run sell logic yet
    }

    // ======== MIGRATION FILL EXIT ========
    if (state.initialTokens && typeof tokensCurve === 'number') {
      const fill = 1 - (tokensCurve / state.initialTokens);
      const migThresh = this.config.migrate_fill_pct ?? 0.97;
      if (fill >= migThresh) {
        this.signals$.next({ mint, action: 'SELL', reason: 'TP', price, symbol: state.symbol, time: now }); // reason MIGR optional
        this.settlePosition(id, state, price);
        this.updateModel(id, state, price);
        logger.info(`Exit ${state.symbol ?? id} – migration imminent fill ${(fill*100).toFixed(1)}% ≥ ${(migThresh*100).toFixed(0)}%`);
        this.stopTracking(id);
        return;
      }
    }

    // ======== SELL LOGIC ========
    if (this.pureML) return;
    if (!state.entryPrice) return;

    if (price > (state.peakSinceEntry ?? 0)) {
      state.peakSinceEntry = price;
    }

    // Detect exceptional momentum (rise from global low)
    const exceptionalPct = this.config.exceptional_momentum_pct ?? 2; // +200%
    const riseLowNow = percentChange(state.lowestPrice, price);
    if (!state.isExceptional && riseLowNow >= exceptionalPct) {
      state.isExceptional = true;
      logger.info(`Exceptional momentum on ${id}: +${(riseLowNow * 100).toFixed(0)}% from low`);
    }

        // --- Adaptive exit logic ---
    const pnl = percentChange(state.entryPrice, price);

    // ---- Hard take-profit ----
    const tpLevel = this.config.take_profit;
    if (tpLevel !== undefined && pnl >= tpLevel) {
      this.signals$.next({ mint, action: 'SELL', reason: 'TP', price, symbol: state.symbol, time: now });
      this.settlePosition(id, state, price);
      this.updateModel(id, state, price);
      logger.info(`TAKE-PROFIT ${state.symbol ?? id}: +${(pnl*100).toFixed(1)}% ≥ ${(tpLevel*100).toFixed(0)}%`);
      this.stopTracking(id);
      return;
    }

    // Compute adaptive trailing threshold based on trading activity
    const minTpsCfg = this.config.min_tps ?? 5;
    const baseTrail = this.config.base_trail_dd ?? 0.2;          // 20 %
    const scale = this.config.tps_trail_scale ?? 0.04;           // extra trail per TPS factor
    const extraTrail = Math.min(0.3, Math.max(0, (tps / minTpsCfg - 1) * scale));
    const gainPct = state.peakSinceEntry ? (state.peakSinceEntry / state.entryPrice) - 1 : 0;
    const gainTrail = Math.min(0.5, 0.1 + gainPct * 0.1); // widen trail as we profit
    const dynTrail = baseTrail + extraTrail + gainTrail + (state.isExceptional ? 0.1 : 0);

    // --- combined percent / ATR trailing ---
    const atrMultExit = this.config.atr_mult ?? 3;
    const absTrail = state.atr ? state.atr * atrMultExit : 0;
    const allowedDrop = state.peakSinceEntry ? Math.max(absTrail, state.peakSinceEntry * dynTrail) : 0;

    // EMA cross lose-momentum
    const gainSafe = this.config.disable_ema_tps_gain_pct ?? 0.3; // after +30% we ignore EMA/TPS
    if (gainPct < gainSafe && state.emaShort !== undefined && state.emaLong !== undefined && state.emaShort < state.emaLong) {
      this.signals$.next({ mint, action: 'SELL', reason: 'SL', price, symbol: state.symbol, time: now });
      this.settlePosition(id, state, price);

      this.updateModel(id, state, price);
      logger.info(`Exit ${id} – EMA cross down`);
      this.stopTracking(id);
      return;
    }

    // Exit if TPS collapses strongly (liquidity drying → rug / end of hype)
    const exitTps = this.config.exit_tps ?? Math.max(1, minTpsCfg / 2);
    if (gainPct < gainSafe && tps < exitTps) {
      this.signals$.next({ mint, action: 'SELL', reason: 'SL', price, symbol: state.symbol, time: now });
      this.settlePosition(id, state, price);

      this.updateModel(id, state, price);
      logger.info(`Exit ${id} – TPS dropped to ${tps.toFixed(2)}`);
      this.stopTracking(id);
      return;
    }

    // Volatility trailing exit (deprecated, handled by combined logic below)
    // const atrMult = this.config.atr_mult ?? 2;
    if (false /* old ATR-only stop disabled */) {
      this.signals$.next({ mint, action: 'SELL', reason: 'SL', price, symbol: state.symbol, time: now });
      this.settlePosition(id, state, price);

      this.updateModel(id, state, price);
      logger.info(`Exit ${id} – ATR trail`);
      this.stopTracking(id);
      return;
    }

    // Trailing draw-down fallback
    if (state.peakSinceEntry && price <= state.peakSinceEntry - allowedDrop) {
      this.signals$.next({ mint, action: 'SELL', reason: 'SL', price, symbol: state.symbol, time: now });
      this.settlePosition(id, state, price);

      this.updateModel(id, state, price);
      const drop = percentChange(state.peakSinceEntry, price);
      logger.info(`Exit ${id} – drawdown ${(drop * 100).toFixed(1)}% (trail ${ (dynTrail*100).toFixed(1)}%)`);
      this.stopTracking(id);
    }
  }

  // ---- Internal helper to check if dev balance is zero ----
  private async hasDevExited(mint: PublicKey, devWallet: string): Promise<boolean> {
    try {
      const owner = new PublicKey(devWallet);
      const toks = await this.connection.getTokenAccountsByOwner(owner, { mint });
      for (const accInfo of toks.value) {
        const balResp = await this.connection.getTokenAccountBalance(accInfo.pubkey);
        const amt = Number(balResp.value.uiAmount || 0);
        if (amt > 0) {
          if (this.config.debug_filters) {
            logger.debug(`Dev balance ${amt} tokens remain for ${mint.toBase58()} on ${accInfo.pubkey.toBase58()}`);
          }
          return false; // still holds some
        }
      }
      return true;
    } catch (e) {
      logger.error(`hasDevExited error ${e}`);
      return false; // conservative
    }
  }

  // ---- Internal helper to assess transfer-fee (Token-2022) and bundler risk ----
  private static riskInFlight = 0;
  private static readonly MAX_RISK_CONCURRENCY = 6;

  private async assessTokenRisk(mint: PublicKey, createSignature?: string): Promise<{ feeBps: number | null; bundler: boolean }> {
    // Simple concurrency limiter to avoid spamming RPC and freezing WS loop
    while (MomentumStrategy.riskInFlight >= MomentumStrategy.MAX_RISK_CONCURRENCY) {
      await new Promise((res) => setTimeout(res, 50));
    }
    MomentumStrategy.riskInFlight++;
    let feeBps: number | null = null;
    try {
      const info = await this.connection.getAccountInfo(mint);
      if (info) {
        const ownerStr = info.owner.toBase58();
        const TOKEN_2022_ID = 'TokenzQdBYPVtSdoZ3AYtaXW4F2EtBRegRZr1gcCr';
        if (ownerStr === TOKEN_2022_ID) {
          // TransferFeeConfig extension: u16 basis points at offset 133
          if (info.data.length >= 135) {
            feeBps = info.data.readUInt16LE(133);
          }
        } else {
          feeBps = 0;
        }
      }
    } catch (e) {
      logger.error(`assessTokenRisk fee error: ${e}`);
    }

    // Bundler detection via first instruction program id
    let bundler = false;
    try {
      if (createSignature) {
        const tx = await this.connection.getTransaction(createSignature, { commitment: 'confirmed' });
        if (tx && tx.transaction.message.instructions.length > 0) {
          const ix0 = tx.transaction.message.instructions[0];
          const progId = tx.transaction.message.accountKeys[ix0.programIdIndex];
          const progStr = progId.toBase58();
          const knownBundlers: string[] = this.config.bundler_programs ?? ['MEowGtbfXXFNt'];
          if (knownBundlers.includes(progStr)) {
            bundler = true;
          }
        }
      }
    } catch (e) {
      logger.error(`assessTokenRisk bundler error: ${e}`);
    }
    MomentumStrategy.riskInFlight--;
    return { feeBps, bundler };
  }
}
