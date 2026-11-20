import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
  private readonly logger = new Logger(StreamService.name);
  private readonly subscribers = new Set<Subscriber>();
  private readonly byUser = new Map<string, Set<Subscriber>>();
  private readonly bySite = new Map<string, Set<Subscriber>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private closing = false;

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
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const sub of this.subscribers) sub.res.end();
    this.subscribers.clear();
    this.byUser.clear();
    this.bySite.clear();
  }

  add(userId: string, sites: Iterable<string>, res: Response): void {
    // The client may have left while its sites were being read; its 'close' has already fired.
    if (!res.socket || res.socket.destroyed) return;
    // Opened while shutting down: nothing would end it, and the HTTP server would wait for it.
    if (this.closing) {
      res.status(503).end();
      return;
    }
    // A peer that vanished without closing its socket (network switch) still counts; the newest stream is live.
    const open = [...(this.byUser.get(userId) ?? [])];
    const excess = open.length + 1 - this.config.STREAM_MAX_PER_USER;
    for (const stale of excess > 0 ? open.slice(0, excess) : []) {
      this.remove(stale);
      stale.res.end();
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const sub: Subscriber = { userId, sites: new Set(), res, dirty: false };
    this.subscribers.add(sub);
    if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
    this.byUser.get(userId)!.add(sub);
    this.setSites(sub, sites);
    res.on('close', () => this.remove(sub));
    // The sites were read before the subscriber existed, so a grant or revoke in between would not reach it.
    this.refreshUser(userId, false).catch((err: unknown) =>
      this.logger.error(`stream access refresh failed: ${(err as Error).message}`),
    );
    res.on('drain', () => {
      if (!sub.dirty) return;
      sub.dirty = false;
      this.poke(sub);
    });
  }

  notify(siteIds: string[]): void {
    const reached = new Set<Subscriber>();
    for (const site of siteIds) for (const sub of this.bySite.get(site) ?? []) reached.add(sub);
    for (const sub of reached) this.poke(sub);
  }

  /** One at a time per user, so an older read never overwrites a newer one. */
  refreshUser(userId: string, poke = true): Promise<void> {
    const run = (this.refreshing.get(userId) ?? Promise.resolve()).then(() => this.reloadSites(userId, poke));
    // A failed refresh must not hold up the next one; the caller still gets the error.
    const next = run.catch(() => undefined);
    this.refreshing.set(userId, next);
    void next.then(() => {
      if (this.refreshing.get(userId) === next) this.refreshing.delete(userId);
    });
    return run;
  }

  private async reloadSites(userId: string, poke: boolean): Promise<void> {
    if (!this.byUser.has(userId)) return;
    const { rows } = await this.db.pool.query<AuthUser>(`SELECT id, role FROM users WHERE id = $1`, [userId]);
    const sites = rows[0] ? await this.access.accessibleSites(this.db.pool, rows[0]) : new Set<string>();
    for (const sub of [...(this.byUser.get(userId) ?? [])]) {
      this.setSites(sub, sites);
      if (poke) this.poke(sub);
    }
  }

  private setSites(sub: Subscriber, sites: Iterable<string>): void {
    for (const site of sub.sites) this.unindex(site, sub);
    sub.sites = new Set(sites);
    for (const site of sub.sites) {
      if (!this.bySite.has(site)) this.bySite.set(site, new Set());
      this.bySite.get(site)!.add(sub);
    }
  }

  private remove(sub: Subscriber): void {
    if (!this.subscribers.delete(sub)) return;
    for (const site of sub.sites) this.unindex(site, sub);
    const own = this.byUser.get(sub.userId);
    own?.delete(sub);
    if (own?.size === 0) this.byUser.delete(sub.userId);
  }

  private unindex(site: string, sub: Subscriber): void {
    const subs = this.bySite.get(site);
    subs?.delete(sub);
    if (subs?.size === 0) this.bySite.delete(site);
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
