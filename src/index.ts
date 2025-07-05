import dotenv from 'dotenv';
import fs from 'fs';
import yaml from 'js-yaml';
import { Connection } from '@solana/web3.js';
import logger from './utils/logger';
import { PumpfunScanner } from './core/scanner';
import { JitoListener } from './core/jitoListener';
import { MomentumStrategy } from './core/momentumStrategy';
import { Trader } from './core/trader';
import { startDashboard } from './web/dashboard';

dotenv.config();

const rawConfig = yaml.load(fs.readFileSync('config.yaml', 'utf8')) as any;

// Replace ${ENV_VAR} placeholders inside YAML strings
function resolvePlaceholders(obj: any): any {
  if (typeof obj === 'string') {
    const m = obj.match(/^\$\{(.+)}$/);
    return m ? process.env[m[1]] || '' : obj;
  }
  if (Array.isArray(obj)) return obj.map(resolvePlaceholders);
  if (typeof obj === 'object' && obj !== null) {
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = resolvePlaceholders(obj[k]);
    return out;
  }
  return obj;
}

const config = resolvePlaceholders(rawConfig);

async function main() {
  const connection = new Connection(config.rpc_url, 'confirmed');

  const scanner = new PumpfunScanner(config);
  const jito = new JitoListener(config);
  const strategy = new MomentumStrategy(connection, config, scanner);
  const trader = new Trader(connection, config);

  // pool detection via Pump.fun
  scanner.pools$.subscribe((evt) => {
    strategy.onPool(evt);
    // once we start tracking a token, subscribe to its swaps via Jito
    jito.trackMint(evt.mint.toBase58());
  });

  // real-time price via Jito
  jito.prices$.subscribe((pe) => strategy.onPrice(pe.mint, pe.price, pe.sol, pe.liquidity, pe.wallet, pe.side, pe.tokensCurve));
  strategy.signals$.subscribe((sig) => trader.onSignal(sig));

  // start web dashboard (optional) – we still pass scanner to show New Pools
  startDashboard(scanner, strategy, jito.prices$, config.dashboard_port ?? 3000);

  scanner.start();
  jito.start();
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
