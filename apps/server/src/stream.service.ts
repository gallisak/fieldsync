import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';
import { AccessService } from './access/access.service';
import type { AuthUser } from './auth/auth.guard';
import { APP_CONFIG, type AppConfig } from './config/env';
import { Db } from './database/db.service';

const POKE = 'event: poke\ndata: {}\n\n';
const HEARTBEAT = ': hb\n\n';

interface Subscriber {
  userId: string;
  sites: Set<string>;
  res: Response;
  dirty: boolean;
}

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly subscribers = new Set<Subscriber>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get count(): number {
    return this.subscribers.size;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.heartbeat(), this.config.STREAM_HEARTBEAT_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    for (const sub of this.subscribers) sub.res.end();
    this.subscribers.clear();
  }

  add(userId: string, sites: Iterable<string>, res: Response): void {
    // The client may have left while its sites were being read; its 'close' has already fired.
    if (!res.socket || res.socket.destroyed) return;
    // A peer that vanished without closing its socket (network switch) still counts; the newest stream is live.
    const open = [...this.subscribers].filter((s) => s.userId === userId);
    const excess = open.length + 1 - this.config.STREAM_MAX_PER_USER;
    for (const stale of excess > 0 ? open.slice(0, excess) : []) {
      this.subscribers.delete(stale);
      stale.res.end();
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const sub: Subscriber = { userId, sites: new Set(sites), res, dirty: false };
    this.subscribers.add(sub);
    res.on('close', () => this.subscribers.delete(sub));
    res.on('drain', () => {
      if (!sub.dirty) return;
      sub.dirty = false;
      this.poke(sub);
    });
  }

  notify(siteIds: string[]): void {
    for (const sub of this.subscribers) {
      if (siteIds.some((s) => sub.sites.has(s))) this.poke(sub);
    }
  }

  async refreshUser(userId: string): Promise<void> {
    const subs = [...this.subscribers].filter((s) => s.userId === userId);
    if (subs.length === 0) return;
    const { rows } = await this.db.pool.query<AuthUser>(`SELECT id, role FROM users WHERE id = $1`, [userId]);
    const sites = rows[0] ? await this.access.accessibleSites(this.db.pool, rows[0]) : new Set<string>();
    for (const sub of subs) {
      sub.sites = new Set(sites);
      this.poke(sub);
    }
  }

  private poke(sub: Subscriber): void {
    if (sub.res.writableNeedDrain) sub.dirty = true;
    else sub.res.write(POKE);
  }

  private heartbeat(): void {
    for (const sub of this.subscribers) {
      if (!sub.res.writableNeedDrain) sub.res.write(HEARTBEAT);
    }
  }
}
