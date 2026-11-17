import { Injectable } from '@nestjs/common';
import type { Response } from 'express';

interface Subscriber {
  sites: string[];
  res: Response;
}

@Injectable()
export class StreamService {
  private readonly subscribers = new Set<Subscriber>();

  get count(): number {
    return this.subscribers.size;
  }

  add(sites: string[], res: Response): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    this.subscribers.add({ sites, res });
  }

  notify(siteIds: string[]): void {
    for (const sub of this.subscribers) {
      if (sub.sites.some((s) => siteIds.includes(s))) sub.res.write('event: poke\ndata: {}\n\n');
    }
  }
}
