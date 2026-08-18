/** Shared geodesy — one haversine, one home. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = ((bLat - aLat) * Math.PI) / 180;
  const dl = ((bLon - aLon) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Point at fraction f along the great-circle-ish segment (linear interp is fine at route scale). */
export function lerpPoint(aLat: number, aLon: number, bLat: number, bLon: number, f: number) {
  return { lat: aLat + (bLat - aLat) * f, lon: aLon + (bLon - aLon) * f };
}
