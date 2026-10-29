import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' && !process.env.TEST_LOGS ? 'silent' : env.LOG_LEVEL,
  redact: {
    // Never log credentials or session tokens. Response bodies (which carry presigned URLs) are not logged.
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
    ],
    censor: '[redacted]',
  },
});
