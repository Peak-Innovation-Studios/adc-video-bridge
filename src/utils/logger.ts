import pino from 'pino';

const childLoggers: pino.Logger[] = [];

/** `rtsp://user:pass@host` → `rtsp://[REDACTED]@host`. Non-strings pass through. */
export function scrubRtspCredentials<T>(value: T): T {
  if (typeof value !== 'string') return value;
  return value.replace(/(rtsps?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@') as unknown as T;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'signallingServerToken',
      '*.signallingServerToken',
      'cameraAuthToken',
      '*.cameraAuthToken',
      'credential',
      '*.credential',
      'authorization',
      '*.authorization',
      'cookie',
      '*.cookie',
      'ajaxKey',
      '*.ajaxKey',
      'rtspUrl',
      '*.rtspUrl',
      'rtspBaseUrl',
      '*.rtspBaseUrl',
    ],
    censor: '[REDACTED]',
  },
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map(scrubRtspCredentials) as typeof args);
    },
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export function createChildLogger(name: string) {
  const child = logger.child({ component: name });
  childLoggers.push(child);
  return child;
}

export function setLogLevel(level: string): void {
  logger.level = level;
  for (const child of childLoggers) child.level = level;
}
