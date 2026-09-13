// The schema engine (bitcoin-desktop/schema) with the knots-blake2b overlay, plus a regtest
// BLAKE2b network for local runs, where the fork height is whatever the node was started with.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

export const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`;

export async function loadEngine({ network, activationHeight = 0, headline = '' } = {}) {
  const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
  const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
  const pow = await import(`${SCHEMA}/codec/pow/knots-header-v2.js`);
  const hash = await import(`${SCHEMA}/codec/hash.js`);
  const script = await import(`${SCHEMA}/codec/script.js`);
  const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));
  const overlays = [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))];
  if (network === 'btc:regtest-blake2b') {
    overlays.push({ graph: { '@graph': [{
      '@id': 'btc:regtest-blake2b', '@type': 'btc:NetworkParams', extends: 'btc:regtest', label: 'regtest-blake2b', name: 'regtest-blake2b',
      powHash: 'knots:blake2b-v2', structVariants: { 'btc:BlockHeader': [{ when: { field: 'version', bit: 31 }, struct: 'knots:BlockHeaderV2' }] },
      blake2bHeight: activationHeight, blake2bHeadline: headline, rdtsExpiryTime: 4102444800,
    }] } });
  }
  const k = createKernel({
    core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
    chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network, overlays,
  });
  return { k, pow, hash, script };
}
