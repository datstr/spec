// pm2 definitions for a datstr coordinator, two gateways and two CPU miners on one box.
// Copy next to your node's files, edit the paths and addresses, then:
//   pm2 start datstr.config.cjs && pm2 save
// The miners exit when their gateway's socket drops, so pm2 restarts them with a delay.
const { readFileSync } = require('node:fs');
const HOME = process.env.HOME;
const REPO = `${HOME}/remote/github.com/datstr/spec`;
const CONF = `${HOME}/knots-testnet4/bitcoin.conf`;
const NETWORK = 'btc:testnet4-blake2b';
const ADDR = readFileSync(`${HOME}/knots-testnet4/miner-addresses.txt`, 'utf8').trim().split('\n');
const MINER = `${HOME}/remote/github.com/iohzrd/ratum/target/release/sia-test-miner`;
const LOGS = `${HOME}/knots-testnet4`;
const base = (name, extra) => ({ name, cwd: REPO, autorestart: true, restart_delay: 3000, max_restarts: 1000, min_uptime: 10000, time: true, out_file: `${LOGS}/pm2-${name}.log`, error_file: `${LOGS}/pm2-${name}.err`, ...extra });
const gateway = (name, addr, port, api, keyFile) => base(name, {
  script: 'gateway/serve.mjs',
  args: ['--conf', CONF, '--network', NETWORK, '--pay', addr, '--port', String(port), '--api', String(api), '--key-file', keyFile,
    '--diff', '0.05', '--vardiff-min', '0.001', '--poll', '1', '--stop-height', '151198', '--min-bits', '1d00ffff', '--pool', 'ws://127.0.0.1:3400/ws'],
});
module.exports = { apps: [
  base('datstr-coordinator', { script: 'plugin/standalone.mjs', args: ['--conf', CONF, '--network', NETWORK, '--data', `${HOME}/knots-testnet4/datstr-coordinator`, '--port', '3400', '--min-difficulty', '0.001', '--window-multiple', '0', '--window-min-weight', '4'] }),
  gateway('datstr-gateway-a', ADDR[0], 3333, 3334, `${HOME}/.datstr/btc-testnet4-blake2b.key`),
  // B mines for a cold master key: gateway/delegate.mjs made the descriptor and delegation off the gateway
  { ...gateway('datstr-gateway-b', ADDR[1], 3335, 3336, `${HOME}/.datstr/btc-testnet4-blake2b-b.key`),
    args: [...gateway('datstr-gateway-b', ADDR[1], 3335, 3336, `${HOME}/.datstr/btc-testnet4-blake2b-b.key`).args,
      '--descriptor', `${HOME}/.datstr/master-b/descriptor.json`, '--delegation', `${HOME}/.datstr/master-b/delegation-<first 16 hex of worker>.json`] },
  base('datstr-miner-a', { script: MINER, args: ['127.0.0.1:3333', `${ADDR[0]}.datstr-a`], interpreter: 'none' }),
  base('datstr-miner-b', { script: MINER, args: ['127.0.0.1:3335', `${ADDR[1]}.datstr-b`], interpreter: 'none' }),
] };
