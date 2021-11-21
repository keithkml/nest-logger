const { createLogger, format, transports } = require("winston");

const newLogger = (datadogApiKey) =>
  createLogger({
    level: "info",
    exitOnError: false,
    format: format.json(),
    defaultMeta: { service: "nest-logger", instance: Math.random() },
    transports: [
      new transports.File({ filename: `logs/all.log` }),
      new transports.Http({
        host: "http-intake.logs.datadoghq.com",
        path: `/api/v2/logs?dd-api-key=${datadogApiKey}&ddsource=nodejs&service=nestlogger`,
        ssl: true,
      }),
      // TODO: make console also log debug
      new transports.Console(),
    ],
  });

module.exports = { newLogger };
