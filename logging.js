const { createLogger, format, transports } = require("winston");
require("winston-daily-rotate-file");

const newLogger = (datadogApiKey) =>
  createLogger({
    level: "debug",
    exitOnError: false,
    format: format.json(),
    defaultMeta: { service: "nest-logger", instance: "" + Math.random() },
    transports: [
      new transports.DailyRotateFile({
        filename: "logs/all-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "20m",
        maxFiles: 14,
        handleExceptions: true,
        handleRejections: true,
      }),
      new transports.Http({
        host: "http-intake.logs.datadoghq.com",
        path: `/api/v2/logs?dd-api-key=${datadogApiKey}&ddsource=nodejs&service=nestlogger`,
        ssl: true,
        handleExceptions: true,
        handleRejections: true,
        level: "info",
      }),
      new transports.Console({
        handleExceptions: true,
        handleRejections: true,
      }),
    ],
  });

module.exports = { newLogger };
