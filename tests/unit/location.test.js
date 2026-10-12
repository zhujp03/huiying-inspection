import { describe, expect, it } from "vitest";
import { evaluateCheckin, haversineMeters } from "../../apps/api/src/location.js";

const store = { latitudeGcj02: 31.2304, longitudeGcj02: 121.4737, radiusMeters: 100, accuracyAllowanceMaxMeters: 200 };
const now = new Date("2026-07-24T15:00:00.000Z");

describe("server-side GCJ-02 check-in evaluation", () => {
  it("uses a clamped Haversine calculation", () => {
    expect(haversineMeters(31.2304, 121.4737, 31.2304, 121.4737)).toBe(0);
    expect(haversineMeters(31.2304, 121.4737, 31.2313, 121.4737)).toBeGreaterThan(90);
  });

  it("accepts only a fresh, accurate sample inside the server-computed effective radius", () => {
    const result = evaluateCheckin({ latitude: 31.2304, longitude: 121.4737, accuracy: 15, capturedAt: "2026-07-24T14:59:30.000Z", inRange: false }, store, now);
    expect(result).toMatchObject({ result: "accepted", allowanceMeters: 15, effectiveRadiusMeters: 115 });
  });

  it("rejects stale, future, low-accuracy, and outside samples without trusting a client flag", () => {
    expect(evaluateCheckin({ latitude: 31.2304, longitude: 121.4737, accuracy: 1, capturedAt: "2026-07-24T14:58:59.000Z", inRange: true }, store, now).result).toBe("stale");
    expect(evaluateCheckin({ latitude: 31.2304, longitude: 121.4737, accuracy: 1, capturedAt: "2026-07-24T15:00:06.000Z", inRange: true }, store, now).result).toBe("rejected");
    expect(evaluateCheckin({ latitude: 31.2304, longitude: 121.4737, accuracy: 201, capturedAt: "2026-07-24T14:59:59.000Z", inRange: true }, store, now).result).toBe("low_accuracy");
    expect(evaluateCheckin({ latitude: 31.2404, longitude: 121.4737, accuracy: 1, capturedAt: "2026-07-24T14:59:59.000Z", inRange: true }, store, now).result).toBe("outside_radius");
  });
});
