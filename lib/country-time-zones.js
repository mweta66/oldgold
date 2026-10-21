import countries from "countries-and-timezones";
import { EGYPT_ZONE, validTimeZone } from "../time-zones.js";

export const timeZoneCountries = Object.values(countries.getAllCountries())
  .map((c) => ({
    country: c.id,
    timeZones: c.timezones.filter(validTimeZone),
  }))
  .filter((c) => c.timeZones.length);
const choices = new Map(
  timeZoneCountries.map((c) => [c.country, new Set(c.timeZones)]),
);
export function validPreferences(data) {
  return (
    data &&
    typeof data.country === "string" &&
    typeof data.timeZone === "string" &&
    choices.get(data.country)?.has(data.timeZone) === true
  );
}
export function displayPreferences(role, data) {
  if (role === "admin")
    return { country: "EG", timeZone: EGYPT_ZONE, fixed: true };
  return {
    country: validPreferences(data) ? data.country : "",
    timeZone: validPreferences(data) ? data.timeZone : "UTC",
    fixed: false,
  };
}
