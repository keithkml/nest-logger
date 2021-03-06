const Connection = require("./nest-connection");
const fs = require("fs");
const { newLogger } = require("./logging");

const AUTH_JSON_PATHS = [".", "/etc/secrets"];

function loadAuthJson() {
  for (const path of AUTH_JSON_PATHS) {
    const filePath = path + "/auth.json";
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath));
    }
  }
  throw new Error("could not find auth.json in " + AUTH_JSON_PATHS);
}

const { nestRefreshToken, datadogApiKey } = loadAuthJson();
const logger = newLogger(datadogApiKey);
logger.info("starting up");

const cToF = (celsius) => (celsius * 9) / 5 + 32;
function handle(data) {
  fs.writeFileSync("state.json", JSON.stringify(data, null, 2));
  logger.info("got data");
  for (const t of Object.values(data?.devices?.thermostats ?? {})) {
    logger.info({
      msgType: "thermostat",
      mode: t.hvac_mode,
      state: t.hvac_state,
      heating: t.hvac_heater_state,
      cooling: t.hvac_ac_state,
      fan: t.hvac_fan_state,
      fanMode: t.fan_mode_protobuf,
      temp: cToF(t.current_temperature),
      humidity: t.current_humidity,
      targetTempType: t.target_temperature_type,
      targetTemp: cToF(t.target_temperature),
      targetTempLow: cToF(t.target_temperature_low),
      targetTempHigh: cToF(t.target_temperature_high),
      room: t.where_name,
      sensor: t.name,
    });
  }
  for (const t of Object.values(data?.devices?.temp_sensors ?? [])) {
    logger.info({
      msgType: "sensor",
      sensor: t.name,
      temp: cToF(t.current_temperature),
    });
  }
  for (const s of Object.values(data?.devices?.home_away_sensors ?? {})) {
    logger.info({
      msgType: "homeAway",
      away: s.away == true,
    });
  }
}

async function go() {
  const conn = new Connection({ refreshToken: nestRefreshToken }, logger, true);
  // Use auth details to get JWT token. Returned object contains {token, expiry, refresh}
  // where refresh is a function to get a new token object
  const token = await conn.auth();
  logger.info("authed: " + token);
  conn.observe(handle);
}

go().then(logger.info).catch(logger.error);
