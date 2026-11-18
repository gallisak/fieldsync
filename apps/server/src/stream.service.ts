import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AccessService } from './access/access.service';
import type { AuthUser } from './auth/auth.guard';
import { Db } from './database/db.service';

interface Subscriber {
  userId: string;
  sites: string[];
  res: Response;
}

@Injectable()
export class StreamService {
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  get count(): number {
    return this.subscribers.size;
  }

  add(userId: string, sites: string[], res: Response): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    this.subscribers.add({ userId, sites, res });
  }

  notify(siteIds: string[]): void {
    for (const sub of this.subscribers) {
      if (sub.sites.some((s) => siteIds.includes(s))) poke(sub);
    }
  }

  async refreshUser(userId: string): Promise<void> {
    const subs = [...this.subscribers].filter((s) => s.userId === userId);
    if (subs.length === 0) return;
    const { rows } = await this.db.pool.query<AuthUser>(`SELECT id, role FROM users WHERE id = $1`, [userId]);
    const sites = rows[0] ? [...(await this.access.accessibleSites(this.db.pool, rows[0]))] : [];
    for (const sub of subs) {
      sub.sites = sites;
      poke(sub);
    }
  }
}

const poke = (sub: Subscriber): void => void sub.res.write('event: poke\ndata: {}\n\n');
