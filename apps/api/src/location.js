const EARTH_RADIUS_METERS = 6_371_008.8;
const radians = (degrees) => degrees * Math.PI / 180;

export function haversineMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function evaluateCheckin(sample, store, receivedAt = new Date()) {
  const capturedAt = new Date(sample.capturedAt);
  const ageMs = receivedAt.getTime() - capturedAt.getTime();
  const distanceMeters = haversineMeters(sample.latitude, sample.longitude, store.latitudeGcj02, store.longitudeGcj02);
  const allowanceMeters = Math.min(sample.accuracy, store.accuracyAllowanceMaxMeters);
  const effectiveRadiusMeters = store.radiusMeters + allowanceMeters;
  const base = { distanceMeters, allowanceMeters, effectiveRadiusMeters };
  if (ageMs < -5_000) return { ...base, result: "rejected", failureCode: "CAPTURED_AT_FUTURE" };
  if (ageMs > 60_000) return { ...base, result: "stale", failureCode: "LOCATION_STALE" };
  if (sample.accuracy > store.accuracyAllowanceMaxMeters) return { ...base, result: "low_accuracy", failureCode: "LOCATION_ACCURACY_LOW" };
  if (distanceMeters > effectiveRadiusMeters) return { ...base, result: "outside_radius", failureCode: "OUTSIDE_RADIUS" };
  return { ...base, result: "accepted", failureCode: null };
}
