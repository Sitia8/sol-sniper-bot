import { PublicKey } from '@solana/web3.js';
import { Subject } from 'rxjs';
import logger from '../utils/logger';
import { GeyserClient as GeyserGrpcClient, TimestampedTransactionUpdate } from 'jito-ts/dist/gen/geyser/geyser';
import { ChannelCredentials, Metadata } from '@grpc/grpc-js';
import bs58 from 'bs58';
import { PriceEvent } from './scanner';

/**
 * Lightweight Jito Geyser listener (gRPC).
 *
 * We connect directly to the regional Geyser endpoint (e.g.
 * `london.mainnet.rpc.jito.wtf:443`) and subscribe to
 * `SubscribeTransactionUpdates` to receive confirmed transactions in
 * real time.
 *
 * Only transactions touching mints tracked by the strategy are processed; we
 * compute the SOL ↔︎ token price and publish it via `prices$`.
 *
 * Parsing is deliberately minimal—sufficient for live price display and may be
 * refined later if needed.
 */
export class JitoListener {
  public prices$ = new Subject<PriceEvent>();

  private client!: GeyserGrpcClient;
  private stream: any;
  private tracked = new Set<string>(); // base58 mints in upper-layer strategy

  constructor(private config: any) {}

  /** allow strategy to begin receiving trades for a mint */
  trackMint(mint: string) {
    this.tracked.add(mint);
  }
  untrackMint(mint: string) {
    this.tracked.delete(mint);
  }

  start() {
    const geyserUrl = this.config.jito_geyser_url || this.config?.pump_api?.jito_geyser_url || process.env.GEYSER_URL || 'london.mainnet.rpc.jito.wtf:443';
    const accessToken = this.config.jito_auth || this.config?.pump_api?.jito_auth || process.env.GEYSER_ACCESS_TOKEN || '';

    logger.info(`Connecting Jito Geyser gRPC ${geyserUrl}`);

    // create gRPC client
    this.client = new GeyserGrpcClient(geyserUrl, ChannelCredentials.createSsl());

    // prepare metadata with optional token
    const meta = new Metadata();
    if (accessToken) meta.set('access-token', accessToken);

    // subscribe to live transactions
    this.stream = this.client.subscribeTransactionUpdates({}, meta);

    this.stream.on('data', (msg: TimestampedTransactionUpdate) => {
      try {
        this.handleMessage(msg);
      } catch (e) {
        logger.error(`handleMessage error: ${e}`);
      }
    });

    this.stream.on('error', (err: any) => {
      logger.error(`Geyser stream error ${err}`);
      setTimeout(() => this.start(), 5000);
    });

    this.stream.on('end', () => {
      logger.warn('Geyser stream ended – reconnecting in 5 s');
      setTimeout(() => this.start(), 5000);
    });
  }

  private handleMessage(update: TimestampedTransactionUpdate) {
    const txUpdate = update.transaction;
    if (!txUpdate || txUpdate.isVote) return;

    const confirmed = txUpdate.tx;
    const meta: any = confirmed?.meta;
    if (!confirmed || !meta) return;

    // --- compute SOL diff for fee payer (index 0) ---
    const postBal: number[] = meta.postBalances || [];
    const preBal: number[] = meta.preBalances || [];
    let solChange = 0;
    if (postBal.length && preBal.length) {
      solChange = postBal[0] - preBal[0];
    }

    // --- compute token diff & mint ---
    let mintStr: string | undefined;
    let tokenChange = 0;
    const postTokens = meta.postTokenBalances as any[] | undefined;
    const preTokens = meta.preTokenBalances as any[] | undefined;

    if (postTokens && postTokens.length) {
      const post = postTokens[0];
      mintStr = post.mint;
      const postAmt = Number(post.uiTokenAmount?.amount || 0);
      let preAmt = 0;
      if (preTokens && preTokens.length) {
        const pre = preTokens[0];
        preAmt = Number(pre.uiTokenAmount?.amount || 0);
      }
      tokenChange = postAmt - preAmt;
    }

    if (!mintStr || !this.tracked.has(mintStr) || tokenChange === 0) return;

    const price = (solChange !== 0 && tokenChange !== 0) ? Math.abs(solChange / tokenChange) / 1e9 : 0;
    if (!price) return;

    // wallet = first account key (payer)
    let wallet = '';
    const message = confirmed.transaction?.message as any;
    if (message?.accountKeys?.length) {
      try {
        wallet = bs58.encode(message.accountKeys[0]);
      } catch (_) {}
    }

    const evt: PriceEvent = {
      mint: new PublicKey(mintStr),
      price,
      liquidity: 0,
      sol: solChange / 1e9,
      wallet,
      tokensCurve: 0,
      side: solChange < 0 ? 'buy' : 'sell',
      timestamp: Math.floor((update.ts?.getTime?.() || Date.now()) / 1000)
    };
    this.prices$.next(evt);
  }
}
