type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const asString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

async function fetchJson(url: string, label: string, headers?: HeadersInit) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return asObject(await response.json());
}

function compassDirection(degrees: number | null) {
  if (degrees === null) return null;
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[Math.round(degrees / 45) % 8];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < 32 || latitude > 43 || longitude < -125 || longitude > -113) {
    return Response.json({ error: "A California latitude and longitude are required" }, { status: 400 });
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,temperature_2m",
    forecast_days: "2",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
  }).toString();

  const airUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  airUrl.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,ozone",
    hourly: "us_aqi,pm2_5,pm10",
    forecast_days: "2",
    timezone: "auto",
  }).toString();

  const alertsUrl = `https://api.weather.gov/alerts/active?point=${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const [weatherResult, airResult, alertsResult] = await Promise.allSettled([
    fetchJson(forecastUrl.toString(), "Weather forecast"),
    fetchJson(airUrl.toString(), "Air-quality forecast"),
    fetchJson(alertsUrl, "NWS alerts", { "User-Agent": "FireGrowthTracker/1.0 (https://github.com/jc-ksbw/Fire-Growth-Tracker)" }),
  ]);

  const weather = weatherResult.status === "fulfilled" ? asObject(weatherResult.value.current) : {};
  const air = airResult.status === "fulfilled" ? asObject(airResult.value.current) : {};
  const alertsPayload = alertsResult.status === "fulfilled" ? alertsResult.value : {};
  const alertFeatures = Array.isArray(alertsPayload.features) ? alertsPayload.features : [];
  const alerts = alertFeatures.slice(0, 12).map((entry) => {
    const feature = asObject(entry);
    const properties = asObject(feature.properties);
    return {
      id: asString(properties.id) ?? asString(feature.id),
      event: asString(properties.event) ?? "Weather alert",
      severity: asString(properties.severity) ?? "Unknown",
      urgency: asString(properties.urgency) ?? "Unknown",
      headline: asString(properties.headline),
      effective: asString(properties.effective),
      ends: asString(properties.ends) ?? asString(properties.expires),
      instruction: asString(properties.instruction),
      web: asString(properties.web),
    };
  });

  const windDirection = asNumber(weather.wind_direction_10m);
  const aqi = asNumber(air.us_aqi);
  return Response.json({
    location: { latitude, longitude },
    updatedAt: Date.now(),
    weather: {
      temperatureF: asNumber(weather.temperature_2m),
      humidityPercent: asNumber(weather.relative_humidity_2m),
      precipitationIn: asNumber(weather.precipitation),
      windMph: asNumber(weather.wind_speed_10m),
      windGustMph: asNumber(weather.wind_gusts_10m),
      windDirectionDegrees: windDirection,
      windDirection: compassDirection(windDirection),
      weatherCode: asNumber(weather.weather_code),
    },
    airQuality: {
      aqi,
      pm25: asNumber(air.pm2_5),
      pm10: asNumber(air.pm10),
      smokeSignal: asNumber(air.pm2_5) !== null && (asNumber(air.pm2_5) as number) >= 35.5,
    },
    alerts,
    sources: {
      weather: weatherResult.status === "fulfilled" ? "Open-Meteo forecast models" : null,
      airQuality: airResult.status === "fulfilled" ? "Open-Meteo CAMS air-quality forecast" : null,
      alerts: alertsResult.status === "fulfilled" ? "National Weather Service" : null,
    },
    feedStatus: {
      weather: weatherResult.status === "fulfilled",
      airQuality: airResult.status === "fulfilled",
      alerts: alertsResult.status === "fulfilled",
    },
  }, { headers: { "Cache-Control": "public, max-age=120, s-maxage=300" } });
}
