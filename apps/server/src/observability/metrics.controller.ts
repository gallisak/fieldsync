import { Controller, Get, Inject, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { MetricsService } from './metrics.service';

const digest = (s: string) => createHash('sha256').update(s).digest();

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async scrape(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = this.config.METRICS_TOKEN;
    if (token && !timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${token}`))) {
      throw new UnauthorizedException();
    }
    const body = await this.metrics.registry.metrics();
    res.setHeader('content-type', this.metrics.registry.contentType);
    res.end(body);
  }
}
