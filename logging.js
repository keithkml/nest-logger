const { createLogger, format, transports } = require("winston");

export const newLogger = (datadogApiKey) =>
  createLogger({
    level: "info",
    exitOnError: false,
    format: format.json(),
    transports: [
      new transports.File({ filename: `logs/all.log` }),
      new transports.Http({
        host: "http-intake.logs.datadoghq.com",
        path: `/api/v2/logs?dd-api-key=${datadogApiKey}&ddsource=nodejs&service=nestlogger`,
        ssl: true,
      }),
    ],
  });

module.exports = logger;

// Example logs
logger.log("info", "Hello simple log!");
logger.info("Hello log with metas", { color: "blue" });
