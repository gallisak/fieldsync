import { Controller, Get } from '@nestjs/common';
import { StreamService } from './stream.service';

@Controller('health')
export class HealthController {
  constructor(private readonly streams: StreamService) {}

  @Get()
  check() {
    return { status: 'ok', streams: this.streams.count };
  }
}
