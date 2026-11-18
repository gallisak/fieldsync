import type { AppConfig } from '../../src/config/env';
import type { Db } from '../../src/database/db.service';
import { GcService } from '../../src/gc.service';
import type { MetricsService } from '../../src/observability/metrics.service';

describe('GcService timer', () => {
  afterEach(() => jest.useRealTimers());

  it('skips a tick while the previous run is still going', async () => {
    jest.useFakeTimers();
    const gc = new GcService({} as Db, { GC_INTERVAL_MS: 1000 } as AppConfig, {} as MetricsService);
    let finish = () => {};
    const collect = jest
      .spyOn(gc, 'collect')
      .mockImplementation(() => new Promise((resolve) => (finish = () => resolve(null))));
    gc.onModuleInit();

    jest.advanceTimersByTime(3500);
    expect(collect).toHaveBeenCalledTimes(1);

    finish();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(1000);
    expect(collect).toHaveBeenCalledTimes(2);
    gc.onModuleDestroy();
  });
});
