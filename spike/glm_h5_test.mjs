// Prove h5wasm reads a real GLM L2 LCFA granule: variable names, dtypes, scale/offset.
import { readFileSync } from 'node:fs';
import h5wasm from 'h5wasm/node';

const { FS } = await h5wasm.ready;
const buf = readFileSync(process.argv[2]);
FS.writeFile('g.nc', new Uint8Array(buf));
const f = new h5wasm.File('g.nc', 'r');

console.log('root keys:', f.keys().filter(k => k.startsWith('flash_')).join(', '));

for (const name of ['flash_lat', 'flash_lon', 'flash_energy', 'flash_quality_flag']) {
  const d = f.get(name);
  if (!d) { console.log(name, ': MISSING'); continue; }
  const attrs = {};
  for (const a of ['scale_factor', 'add_offset', 'units']) {
    if (d.attrs[a]) attrs[a] = d.attrs[a].value;
  }
  const v = d.value;
  console.log(name, '| dtype', d.dtype, '| n', v.length, '| attrs', JSON.stringify(attrs), '| sample', Array.from(v.slice(0, 3)));
}

// Reconstruct 3 physical flashes
const lat = f.get('flash_lat').value;
const lon = f.get('flash_lon').value;
const eD = f.get('flash_energy');
const sf = Number(eD.attrs['scale_factor'].value[0]);
const off = Number(eD.attrs['add_offset'].value[0]);
const en = eD.value;
console.log('physical flashes:');
for (let i = 0; i < Math.min(3, lat.length); i++) {
  console.log(`  ${lat[i].toFixed(2)}, ${lon[i].toFixed(2)}  energy ${(en[i] * sf + off).toExponential(2)} J`);
}
f.close();
