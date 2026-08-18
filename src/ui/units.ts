/**
 * Display units. ONE rule underneath everything here: **stored data stays Celsius.**
 *
 * The ledger, the observation store, the climatology percentiles and every cached forecast
 * are Celsius on disk and Celsius in memory; this module converts at the last moment, on the
 * way to a screen. Storing display units would corrupt the verification ledger the first
 * time someone flipped the switch — scores computed in °C would be compared against receipts
 * recorded in °F, and the app's whole claim to honesty runs through that comparison.
 *
 * The other rule, easy to get wrong: **a temperature and a temperature DIFFERENCE convert
 * differently.** 20 °C is 68 °F (×9/5 + 32), but a 2 °C error is a 3.6 °F error (×9/5, no
 * offset). Applying the absolute formula to the ledger's mean error would turn a 1.5 °C
 * model bias into a nonsensical "34.7 °F bias". Hence two functions, deliberately named so
 * the wrong one looks wrong at the call site.
 */

export type TempUnit = 'C' | 'F';

const KEY = 'aether.tempunit';

/**
 * Locale default, overridable: the US, its territories, and a short list of other holdouts
 * use Fahrenheit. Everyone else — and every unknown locale — gets Celsius, which is also
 * what the underlying data speaks.
 */
function localeDefault(): TempUnit {
  const l = (navigator.language || '').toUpperCase();
  return /-(US|PR|GU|VI|MP|AS|BS|BZ|KY|PW|FM|MH)$/.test(l) ? 'F' : 'C';
}

export function tempUnit(): TempUnit {
  const saved = localStorage.getItem(KEY);
  return saved === 'C' || saved === 'F' ? saved : localeDefault();
}

export function setTempUnit(u: TempUnit): void {
  localStorage.setItem(KEY, u);
  window.dispatchEvent(new CustomEvent('aether:units'));
}

export function toggleTempUnit(): TempUnit {
  const next: TempUnit = tempUnit() === 'C' ? 'F' : 'C';
  setTempUnit(next);
  return next;
}

/** '°C' or '°F' — for headers and axis labels that name the unit once. */
export function unitLabel(): string {
  return tempUnit() === 'F' ? '°F' : '°C';
}

/** An ABSOLUTE temperature, converted for display. */
export function temp(celsius: number): number {
  return tempUnit() === 'F' ? celsius * 1.8 + 32 : celsius;
}

/**
 * A temperature DIFFERENCE (error, bias, spread, model-vs-model gap), converted for
 * display. No offset — see the module note.
 */
export function tempDelta(celsius: number): number {
  return tempUnit() === 'F' ? celsius * 1.8 : celsius;
}

/** Absolute, rounded, degree sign only: "72°" — the forecast-card style. */
export function fmtTemp(celsius: number, digits = 0): string {
  return `${temp(celsius).toFixed(digits)}°`;
}

/** Absolute with the unit named: "22.3 °C" — tables that stand alone. */
export function fmtTempUnit(celsius: number, digits = 1): string {
  return `${temp(celsius).toFixed(digits)} ${unitLabel()}`;
}

/** A difference with the unit named: "1.4 °F" — never carries the +32 offset. */
export function fmtDeltaUnit(celsius: number, digits = 1): string {
  return `${tempDelta(celsius).toFixed(digits)} ${unitLabel()}`;
}

/** A signed difference: "+1.4 °F" / "-0.6 °C". */
export function fmtDeltaSigned(celsius: number, digits = 1): string {
  const v = tempDelta(celsius);
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} ${unitLabel()}`;
}
