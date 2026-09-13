// The datstr coordinator as a JSS plugin (https://jss.live/):
//   jss start --plugin /path/to/datstr/spec/plugin/index.mjs@/datstr
// with, in the JSS config, plugins: [{ module, prefix: '/datstr', config: { conf, network, params } }].
// Gateways connect to ws(s)://host/datstr/ws; documents are served under /datstr/.
import { createCoordinator, routes } from './coordinator.mjs';

export async function activate(api) {
  const cfg = api.config ?? {};
  const dataDir = cfg.dataDir ?? api.storage.pluginDir();
  const log = (...a) => api.log.info(a.join(' '));
  const info = api.serverInfo?.() ?? {};
  const co = await createCoordinator({ ...cfg, dataDir, params: { ...(cfg.params ?? {}), endpoints: { ws: `${(info.baseUrl ?? '').replace(/^http/, 'ws')}${api.prefix}/ws`, http: `${info.baseUrl ?? ''}${api.prefix}/` } } }, log);
  const route = routes(co);
  api.fastify.get(`${api.prefix}/*`, async (req, reply) => {
    const [status, type, body] = await route(req.url.split('?')[0].slice(api.prefix.length));
    reply.code(status).type(type).header('access-control-allow-origin', '*').send(body);
  });
  api.ws.route(`${api.prefix}/ws`, (socket, request) => {
    co.connect({
      remote: request?.socket ? `${request.socket.remoteAddress}:${request.socket.remotePort}` : null,
      send: (s) => socket.send(s), onMessage: (cb) => socket.on('message', (d) => cb(d.toString())), onClose: (cb) => socket.on('close', cb), close: () => socket.close(),
    });
  });
  return { deactivate() { co.stop(); } };
}
