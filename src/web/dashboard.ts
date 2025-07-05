import { Server as IOServer } from 'socket.io';
import { PublicKey } from '@solana/web3.js';
import { createServer } from 'http';
import express from 'express';
import path from 'path';
import { PumpfunScanner, PoolEvent, PriceEvent } from '../core/scanner';
import { Observable } from 'rxjs';
import { MomentumStrategy, TradeSignal } from '../core/momentumStrategy';
import logger from '../utils/logger';

export function startDashboard(scanner: PumpfunScanner, strategy: MomentumStrategy, priceStream: Observable<PriceEvent> | undefined, port = 3000) {
  const app = express();
  const httpServer = createServer(app);
  const io = new IOServer(httpServer, { cors: { origin: '*' } });

  // serve static files from /public
  const publicDir = path.join(__dirname, '../../public');
  app.use(express.static(publicDir));

  // forward events to clients
  scanner.pools$.subscribe((evt: PoolEvent) => {
    io.emit('new_pool', {
      mint: evt.mint.toBase58(),
      mcap: evt.initialMcap.toFixed(4),
      time: evt.createdAt,
    });
  });

  // stream price updates (if provided)
  if (priceStream) {
    priceStream.subscribe((pe) => {
      io.emit('price', {
        mint: pe.mint.toBase58(),
        price: pe.price,
        mcap: pe.price * 1e9, // FDV assuming 1B supply
        time: pe.timestamp,
      });
    });
  }

  // forward trading signals
  strategy.signals$.subscribe((sig: TradeSignal) => {
    io.emit('signal', {
      mint: sig.mint.toBase58(),
      action: sig.action,
      reason: sig.reason || '',
      symbol: sig.symbol || '',
      price: sig.price ?? null,
      time: sig.time ?? Date.now() / 1000,
    });
  });

  // stream global PnL updates
  strategy.pnl$.subscribe((pnlSol: number) => {
    io.emit('pnl', {
      pnl_pct: pnlSol,
      time: Date.now() / 1000,
    });
  });


  io.on('connection', (socket) => {
    logger.info(`Dashboard client connected ${socket.id}`);

    socket.on('manual_sell', (d) => {
      try {
        const mint = new PublicKey(d.mint);
        strategy.signals$.next({ mint, action: 'SELL' });
        logger.info(`Manual SELL requested for ${d.mint}`);
      } catch (e) {
        logger.error(`manual_sell error ${e}`);
      }
    });
    logger.info(`Dashboard client connected ${socket.id}`);
  });

  httpServer.listen(port, () => {
    logger.info(`Dashboard available at http://localhost:${port}`);
  });
}
