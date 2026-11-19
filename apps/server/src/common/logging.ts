import { LoggerModule } from 'nestjs-pino';
import pino, { type DestinationStream } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { requestContext, requestIdOf } from './request-context';

export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

const withoutQueryToken = (url: string) => url.replace(/([?&]token=)[^&]*/gi, '$1[Redacted]');

export const loggerModule = LoggerModule.forRootAsync({
  providers: [{ provide: LOG_DESTINATION, useFactory: () => pino.destination(1) }],
  inject: [APP_CONFIG, LOG_DESTINATION],
  useFactory: (config: AppConfig, destination: DestinationStream) => ({
    pinoHttp: [
      {
        level: config.LOG_LEVEL,
        genReqId: (req) => requestIdOf(req),
        quietReqLogger: true,
        // Health checks every few seconds would bury everything else.
        autoLogging: { ignore: (req) => /^\/(health|ready|metrics)(\?|$)/.test(req.url ?? '') },
        mixin: () => ({ ...requestContext.getStore() }),
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.query.token'],
        serializers: {
          req: (req: { url?: string }) => ({ ...req, url: req.url && withoutQueryToken(req.url) }),
        },
      },
      destination,
    ],
  }),
});
