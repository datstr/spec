#!/usr/bin/env node
// The coordinator on its own: node:http for the documents, the engine's zero-dependency
// WebSocket server for gateways at /ws. For tests and for running without JSS.
//
//   node plugin/standalone.mjs --conf <bitcoin.conf> --network btc:testnet4-blake2b --data <dir>
//                              [--port 3400] [--key <hex>] [--window-multiple 2] [--window-min-weight 0]
//                              [--min-difficulty 1] [--start-difficulty 1] [--fee-bps 0] [--activation N] [--headline S]
import http from 'node:http';
import { createCoordinator, routes } from './coordinator.mjs';
import { SCHEMA } from '../gateway/lib/engine.mjs';
const { attachWsServer } = await import(`${SCHEMA}/codec/ws.js`);

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const num = (v) => v === undefined ? undefined : Number(v);
const port = Number(args.port ?? 3400);
const co = await createCoordinator({
  conf: args.conf, network: args.network, dataDir: args.data ?? './datstr-coordinator', key: args.key, activation: args.activation, headline: args.headline,
  params: { windowMultiple: num(args['window-multiple']), windowMinWeight: num(args['window-min-weight']), minDifficulty: num(args['min-difficulty']), startDifficulty: num(args['start-difficulty']), feeBps: num(args['fee-bps']), feeScript: args['fee-script'], endpoints: { ws: `ws://127.0.0.1:${port}/ws`, http: `http://127.0.0.1:${port}/` } },
}, log);
for (const k of Object.keys(co.params)) if (co.params[k] === undefined) delete co.params[k];
const route = await routes(co);
const server = http.createServer(async (req, res) => {
  const [status, type, body] = await route(req.url.split('?')[0]);
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' }); res.end(body);
});
attachWsServer(server, (client, req) => {
  if (req.url.split('?')[0] !== '/ws') return client.close();
  co.connect({ remote: `${req.socket.remoteAddress}:${req.socket.remotePort}`, send: (s) => client.send(new TextEncoder().encode(s)), onMessage: client.onMessage, onClose: client.onClose, close: client.close });
});
server.listen(port, '127.0.0.1', () => log(`coordinator: ws://127.0.0.1:${port}/ws, documents at http://127.0.0.1:${port}/`));
process.on('SIGTERM', () => { co.stop(); server.close(); process.exit(0); });
