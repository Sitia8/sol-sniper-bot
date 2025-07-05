import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import logger from '../utils/logger';
import { TradeSignal } from './momentumStrategy';
import bs58 from 'bs58';
import { getMint } from '@solana/spl-token';

export class Trader {
  private keypair: Keypair;
  private apiCfg: any;
  private jitoEndpoint?: string;
  private jitoAuth?: string;

  constructor(private connection: Connection, private config: any) {
    this.apiCfg = config.pump_api;
    // Optional Jito relay parameters
    if (!this.apiCfg.paper && this.apiCfg.use_jito) {
      this.jitoEndpoint = this.apiCfg.jito_endpoint ?? 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';
      this.jitoAuth = this.apiCfg.jito_auth ?? undefined;
    }
    const pkStr: string | undefined = config.wallet_private_key;

    if (this.apiCfg.paper) {
      // In paper mode we don't need a real key; generate a disposable one if none provided.
      this.keypair = pkStr ?
        (pkStr.trim().startsWith('[')
          ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pkStr)))
          : Keypair.fromSecretKey(bs58.decode(pkStr)))
        : Keypair.generate();
      return;
    }

    if (!pkStr || pkStr.trim() === '') {
      throw new Error('wallet_private_key must be set in live mode (paper=false)');
    }

    this.keypair = pkStr.trim().startsWith('[')
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pkStr)))
      : Keypair.fromSecretKey(bs58.decode(pkStr));
  }

  async onSignal(signal: TradeSignal) {
    if (signal.action === 'BUY') {
      await this.buy(signal.mint);
    } else {
      await this.sell(signal.mint);
    }
  }

  // -------- internal helpers -------- //
  private async validateToken(mint: PublicKey): Promise<boolean> {
    try {
      const mintInfo = await getMint(this.connection, mint);
      if (mintInfo.mintAuthority !== null) {
        logger.warn(`Mint authority still present for ${mint.toBase58()} – skipping`);
        return false;
      }
      const supply = Number(mintInfo.supply);
      if (supply < 1_000_000_000) {
        logger.warn(`Supply too small (${supply}) – likely not Pump.fun standard`);
        return false;
      }
      return true;
    } catch (e) {
      logger.error(`validateToken error ${e}`);
      return false;
    }
  }

  private async buy(mint: PublicKey) {
    if (!(await this.validateToken(mint))) return;
    const body = {
      action: 'buy',
      mint: mint.toBase58(),
      amount: this.config.trade_size_sol,
      denominatedInSol: true,
      slippage: this.apiCfg.slippage,
      private: this.apiCfg.paper ? '' : bs58.encode(this.keypair.secretKey),
      priorityFeeLamports: Math.round(this.apiCfg.priority_fee * 1e9)
    };
    await this.callApi(body, 'BUY');
  }

  private async sell(mint: PublicKey) {
    const body = {
      action: 'sell',
      mint: mint.toBase58(),
      amount: '100%',
      denominatedInSol: false,
      slippage: this.apiCfg.slippage,
      private: this.apiCfg.paper ? '' : bs58.encode(this.keypair.secretKey),
      priorityFeeLamports: Math.round(this.apiCfg.priority_fee * 1e9)
    };
    await this.callApi(body, 'SELL');
  }

  private async callApi(body: any, tag: string) {
    // Paper-trading just logs
    if (this.apiCfg.paper) {
      logger.info(`[PAPER ${tag}] ${JSON.stringify(body)}`);
      return;
    }

    // Live trading – choose routing
    if (this.apiCfg.use_jito) {
      await this.sendViaJito(body, tag);
      return;
    }

    try {
      const res = await fetch(this.apiCfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data: any = await res.json();
      if (!res.ok) {
        logger.error(`${tag} failed: ${JSON.stringify(data)}`);
      } else {
        logger.info(`${tag} success: signature ${data.signature || data.txid || data}`);
      }
    } catch (e) {
      logger.error(`${tag} API error ${e}`);
    }
  }

  /**
   * Send a base64 serialized transaction through Jito Block-Engine for lowest latency.
   * The body passed here is expected to already be a serialized transaction string.
   */
  private async sendViaJito(txObj: any, tag: string): Promise<void> {
    if (!this.jitoEndpoint) {
      logger.error('Jito relay enabled but jitoEndpoint undefined');
      return;
    }

    // When called from existing Pump.fun portal we may receive an object containing tx field.
    // Accept either raw base64 string or object with transaction field
    const raw = typeof txObj === 'string' ? txObj : (txObj.tx || txObj.transaction || '') as string;
    if (!raw) {
      logger.error(`${tag} Jito relay: empty transaction`);
      return;
    }

    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'sendTransaction',
      params: [raw, { encoding: 'base64' }]
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.jitoAuth) headers['x-jito-auth'] = this.jitoAuth;

    try {
      const res = await fetch(this.jitoEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        logger.error(`${tag} JITO failed: ${JSON.stringify(data)}`);
      } else {
        logger.info(`${tag} JITO success: ${data.result || JSON.stringify(data)}`);
      }
    } catch (e) {
      logger.error(`${tag} JITO relay error ${e}`);
    }
  }
}
