# Independent side: Skyfield (its own SGP4 + ephemeris) on the same TLE and window.
import sys
from skyfield.api import load, wgs84, EarthSatellite

l1, l2 = [ln.strip() for ln in open('spike/iss.tle').read().strip().split('\n')]
ts = load.timescale()
sat = EarthSatellite(l1, l2, 'ISS', ts)
nyc = wgs84.latlon(40.7128, -74.006)
t0 = ts.from_datetime(__import__('datetime').datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00')))
t1 = ts.tt_jd(t0.tt + 2.0)
times, events = sat.find_events(nyc, t0, t1, altitude_degrees=10.0)
rise = None
for t, e in zip(times, events):
    if e == 0:
        rise = t
    elif e == 1:
        alt, _, _ = (sat - nyc).at(t).altaz()
        peak = (t, alt.degrees)
    elif e == 2 and rise is not None:
        print(rise.utc_strftime('%Y-%m-%dT%H:%M'), t.utc_strftime('%Y-%m-%dT%H:%M'), f'{peak[1]:.1f}')
        rise = None
