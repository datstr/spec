// The datstr coordinator as a JSS plugin (https://jss.live/):
//   jss start --plugin /path/to/datstr/spec/plugin/index.mjs@/datstr
// with, in the JSS config, plugins: [{ module, prefix: '/datstr', config: { conf, network, params } }].
// Gateways connect to ws(s)://host/datstr/ws; documents are served under /datstr/.
import { createCoordinator, routes } from './coordinator.mjs';

// Config comes from the JSS config entry (api.config) or, for the --plugin flag which carries
// none, from the environment: DATSTR_CONF, DATSTR_NETWORK, DATSTR_DATA, DATSTR_ACTIVATION,
// DATSTR_HEADLINE, DATSTR_KEY, and DATSTR_PARAMS as JSON ({"windowMinWeight":4,...}).
export async function activate(api) {
  const env = process.env;
  const cfg = { ...(env.DATSTR_CONF ? { conf: env.DATSTR_CONF } : {}), ...(env.DATSTR_NETWORK ? { network: env.DATSTR_NETWORK } : {}), ...(env.DATSTR_DATA ? { dataDir: env.DATSTR_DATA } : {}),
    ...(env.DATSTR_ACTIVATION ? { activation: env.DATSTR_ACTIVATION } : {}), ...(env.DATSTR_HEADLINE ? { headline: env.DATSTR_HEADLINE } : {}), ...(env.DATSTR_KEY ? { key: env.DATSTR_KEY } : {}),
    ...(env.DATSTR_PARAMS ? { params: JSON.parse(env.DATSTR_PARAMS) } : {}), ...(api.config ?? {}) };
  const dataDir = cfg.dataDir ?? api.storage.pluginDir();
  const log = (...a) => api.log.info(a.join(' '));
  const info = api.serverInfo?.() ?? {};
  const co = await createCoordinator({ ...cfg, dataDir, params: { ...(cfg.params ?? {}), endpoints: { ws: `${(info.baseUrl ?? '').replace(/^http/, 'ws')}${api.prefix}/ws`, http: `${info.baseUrl ?? ''}${api.prefix}/` } } }, log);
  const route = await routes(co);
  api.fastify.get(api.prefix, async (req, reply) => { const [status, type, body] = await route('/'); reply.code(status).type(type).send(body); });
  api.fastify.get(`${api.prefix}/*`, async (req, reply) => {
    const [status, type, body] = await route(req.url.split('?')[0].slice(api.prefix.length));
    reply.code(status).type(type).header('access-control-allow-origin', '*').send(body);
  });
  await api.ws.route(`${api.prefix}/ws`, (socket, request) => {
    co.connect({
      remote: request?.socket ? `${request.socket.remoteAddress}:${request.socket.remotePort}` : null,
      send: (s) => socket.send(s), onMessage: (cb) => socket.on('message', (d) => cb(d.toString())), onClose: (cb) => socket.on('close', cb), close: () => socket.close(),
    });
  });
  return { deactivate() { co.stop(); } };
}
