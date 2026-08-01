import pino from 'pino';

const childLoggers: pino.Logger[] = [];

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
    ],
    censor: '[REDACTED]',
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
