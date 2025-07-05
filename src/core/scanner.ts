import { PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
import { Subject } from 'rxjs';
import logger from '../utils/logger';

export interface PoolEvent {
  mint: PublicKey;
  createdAt: number; // unix seconds
  initialMcap: number; // USD
  symbol?: string;    // token ticker/name
  devWallet?: string; // creator wallet
}

export interface PriceEvent {
  mint: PublicKey;
  price: number; // SOL price per token
  liquidity: number; // SOL in curve
  sol: number; // SOL amount of trade
  wallet: string; // wallet address involved in trade
  tokensCurve: number; // tokens in curve (supply remaining)
  side: 'buy' | 'sell'; // trade direction
  timestamp: number;
}

/**
 * Scanner dedicated to pump.fun streams.
 *  - Subscribes to NewPools (token launch)
 *  - For each tracked token, subscribes to its trade stream to emit real-time prices.
 */
export class PumpfunScanner {
  private ws!: WebSocket;
  public pools$ = new Subject<PoolEvent>();

  /** Compatibility stub – trade stream removed */
  unsubscribeMint(_mintStr: string) {/* no-op */}

  constructor(private config: any) {}

  start() {
    this.ws = new WebSocket('wss://pumpportal.fun/api/data');

    this.ws.on('open', () => {
      logger.info('Connected to pump.fun WS');
      // Subscribe to new token creations
      this.send({ method: 'subscribeNewToken' });
    });

    this.ws.on('message', (data) => {
      // Log raw data for debugging (truncate to 400 chars)
      logger.debug(`WS raw: ${data.toString().slice(0, 400)}`);
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        logger.debug('Non-JSON WS message');
      }
    });

    this.ws.on('error', (err) => logger.error(`WS error ${err}`));
    this.ws.on('close', () => {
      logger.warn('WS closed, reconnect in 5s');
      setTimeout(() => this.start(), 5000);
    });
  }

  private send(obj: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private handleMessage(msg: any) {
    // Pumpportal emits objects with a 'txType' field (create / buy / sell)
    if (msg?.txType) {
      if (msg.txType === 'create') {
        this.processNewPool(msg);
      } else {
        // trade events ignored – price feed handled via Jito
      }
      return;
    }

    // Fallback to channel-based logic (legacy / docs examples)
    const channel = msg.channel || msg.method || msg.type || msg.stream;
    if (!channel) {
      logger.debug(`Unknown msg shape: ${JSON.stringify(msg).slice(0,300)}`);
      return;
    }

    switch (channel) {
      case 'NewPools':
      case 'NewToken':
        this.processNewPool(msg.data ?? msg);
        break;

      default:
        break;
    }
  }

  private processNewPool(data: any) {
    try {
      const mintStr: string = data?.mint || data?.tokenAddress || data?.address;
      const mcap = Number(data?.vSolInBondingCurve) || Number(data?.marketCap) || 0; // use SOL in curve as liquidity proxy
      const createdAt = Number(data?.createdAt) || Math.floor(Date.now() / 1000);
      if (!mintStr) return;

      const dev = data?.traderPublicKey || data?.owner || data?.authority || '';
      const symbol: string = data?.symbol || data?.tokenSymbol || data?.token || data?.tokenName || data?.name || '';
      const poolEvt: PoolEvent = {
        mint: new PublicKey(mintStr),
        createdAt,
        initialMcap: mcap,
        symbol,
        devWallet: dev
      };
      logger.info(`New pool ${mintStr} mcap $${mcap}`);
      this.pools$.next(poolEvt);
    } catch (e) {
      logger.error(`processNewPool error: ${e}`);
    }
  }
}
