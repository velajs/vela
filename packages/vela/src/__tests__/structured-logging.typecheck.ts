import {
  APP_LOGGER,
  ApplicationLogger,
  LoggingModule,
  type LogRecord,
  type LogSink,
  type LogValue,
} from '../logging';
import { defineProvider } from '../container/types';
import type { LoggerService } from '../services/logger';

const sink: LogSink = (record) => {
  const level: 'LOG' | 'ERROR' | 'WARN' | 'DEBUG' | 'VERBOSE' = record.level;
  const fields: Readonly<Record<string, LogValue>> = record.fields;
  void level;
  void fields;
  // @ts-expect-error sink records are immutable
  record.message = 'replacement';
  // @ts-expect-error context fields are immutable
  record.fields.requestId = 'replacement';
  // @ts-expect-error fields must remain JSON-safe
  const invalid: LogValue = () => record.message;
  void invalid;
};
const module = LoggingModule.forRoot({ sinks: [sink], categories: { http: 1 } });
const provider = defineProvider(APP_LOGGER, {
  useFactory: () => new ApplicationLogger(),
  inject: [],
});
const consumer = defineProvider('logging-consumer', {
  inject: [APP_LOGGER],
  useFactory: (logging) => {
    const service: LoggerService = logging.createLogger('test');
    // @ts-expect-error checked provider injection retains ApplicationLogger, never any
    logging.notALoggerMethod();
    return service;
  },
});
// @ts-expect-error numeric levels are finite literals
LoggingModule.forRoot({ level: 999 });
// @ts-expect-error typed logger providers cannot be rebound to unrelated values
const bad = defineProvider(APP_LOGGER, { useValue: 'not a logger' });
const record: LogRecord = {
  timestamp: 0,
  level: 'LOG',
  category: 'test',
  message: 'x',
  fields: {},
  // @ts-expect-error wire record arguments cannot contain raw BigInts
  arguments: [1n],
};
void module;
void provider;
void consumer;
void bad;
void record;
