const state = require("./state.json");

const TYPES = {
  kryptonite: "sensor",
  diamond3: "Nest",
  onyx: "NestE",
};

const to_f = (cTemp) => {
  const f = (cTemp * 9) / 5 + 32;
  return Math.round(f * 10) / 10;
};

const rooms = Object.values(state)
  .flatMap((d) => d.traits)
  .filter((t) => t.label == "located_annotations")
  .flatMap((t) => [
    ...t.value.predefinedWheresMapMap,
    ...t.value.customWheresMapMap,
  ])
  .map((a) => a[1])
  .filter((r) => r.resourceId?.resourceId && r.label?.literal)
  .reduce(
    (acc, r) => ({ ...acc, [r.resourceId.resourceId]: r.label.literal }),
    {}
  );

for (const deviceId in state) {
  const d = state[deviceId];
  const traits = (d.traits || {}).reduce(
    (acc, val) => ({
      ...acc,
      [val.label]: val,
    }),
    {}
  );
  const temp = (traits.current_temperature || traits.temperature)?.value
    ?.temperatureValue?.temperature?.value;
  const rid =
    traits.device_located_settings?.value?.whereAnnotationRid?.resourceId;
  const room = rooms[rid] || rid || deviceId;

  // don't forget about current_humidity
  // or target_temperature_settings
  const type = TYPES[traits.device_info?.value?.className] || "unknown";
  if (temp) {
    const tempf = to_f(temp);
    console.log();
    console.log(rid);
    console.log(`${room} is ${tempf}ºF (${type})`);
  }
  // this is wrong - there are multiple of these
  const target = traits.target_temperature_settings?.value?.targetTemperature;
  if (target) {
    if (target.heatingTarget?.value) {
      console.log(`🔥 heat target ${to_f(target.heatingTarget?.value)}ºF`);
    }
    if (target.coolingTarget?.value) {
      console.log(`❄️ cool target ${to_f(target.coolingTarget?.value)}ºF`);
    }
  }
  const humidity =
    traits.current_humidity?.value?.humidityValue?.humidity?.value;
  if (humidity) {
    console.log(`🌬 humidity is ${Math.round(humidity * 10) / 10}%`);
  }
}
