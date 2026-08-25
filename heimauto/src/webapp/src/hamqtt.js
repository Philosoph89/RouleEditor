// Home Assistant MQTT bridge: publishes the derived entities via MQTT
// Discovery and turns incoming commands into bridge calls.
//
// Topic layout (base defaults to "heimauto"):
//   heimauto/status                      online / offline  (LWT)
//   heimauto/<id>/state                  state payload (plain or JSON)
//   heimauto/<id>/set                    command from Home Assistant
//   heimauto/<id>/position               cover position 0..100
//   heimauto/<id>/set_position           cover target position
//   <prefix>/<component>/heimauto/<id>/config    discovery
//
// Every entity is attached to a device per HomeBus module, so Home Assistant
// groups them as "HomeBus Modul 1A" etc. The master itself is the via_device.

import mqtt from 'mqtt';
import { moduleDevice, areaHints, DIM_LEVEL_MAX } from './entities.js';

const COMPONENT = {
  switch: 'switch',
  light: 'light',
  dimmer: 'light',
  cover: 'cover',
  button: 'binary_sensor',
  fan: 'fan',        // Stufenschalter mit Lüftungs-Charakter (Prozent-Slider)
  level: 'number',   // sonstiger Stufenschalter (0..n)
};

// The bridge itself as a Home Assistant device, so the per-module devices have
// a real `via_device` parent and the bus state is visible in HA.
export const MASTER_DEVICE = {
  identifiers: ['heimauto_master'],
  name: 'Heimauto HomeBus Master',
  manufacturer: 'HomeBus',
  model: 'RouleEditor Web / Heimauto Bridge',
};

export class HaMqtt {
  constructor(bridge) {
    this.bridge = bridge;
    this.client = null;
    this.opts = null;
    this.base = 'heimauto';
    this.prefix = 'homeassistant';
    this.entities = [];
    this.overrides = {};
    this.areaHints = {};
    this.onLog = null;
    this.stats = { published: 0, commands: 0, errors: 0, connectedAt: null };
    this.lastError = null;
  }

  get connected() { return Boolean(this.client?.connected); }

  status() {
    return {
      connected: this.connected,
      configured: Boolean(this.opts),
      host: this.opts?.host || null,
      port: this.opts?.port || null,
      base: this.base,
      prefix: this.prefix,
      entities: this.entities.filter((e) => e.enabled !== false).length,
      stats: this.stats,
      lastError: this.lastError,
    };
  }

  log(msg) { if (this.onLog) this.onLog(msg); }

  // opts: { host, port, username, password, base, discoveryPrefix, clientId, protocol }
  async connect(opts = {}) {
    await this.disconnect();
    this.opts = {
      host: opts.host || '127.0.0.1',
      port: Number(opts.port) || 1883,
      protocol: opts.protocol || 'mqtt',
      username: opts.username || undefined,
      password: opts.password || undefined,
      clientId: opts.clientId || `heimauto_${Math.floor(process.uptime() * 1000) % 100000}`,
    };
    this.base = opts.base || this.base;
    this.prefix = opts.discoveryPrefix || this.prefix;
    const url = `${this.opts.protocol}://${this.opts.host}:${this.opts.port}`;
    this.lastError = null;

    this.client = mqtt.connect(url, {
      username: this.opts.username,
      password: this.opts.password,
      clientId: this.opts.clientId,
      clean: true,
      reconnectPeriod: 5000,
      will: { topic: `${this.base}/status`, payload: 'offline', qos: 1, retain: true },
    });

    this.client.on('connect', () => {
      this.stats.connectedAt = Date.now();
      this.log(`MQTT verbunden: ${url}`);
      this.client.publish(`${this.base}/status`, 'online', { qos: 1, retain: true });
      this.client.subscribe([`${this.base}/+/set`, `${this.base}/+/set_position`,
                            `${this.base}/+/set_percentage`,
                            `${this.prefix}/status`], { qos: 1 });
      this.publishDiscovery();
      this.bridge.publishAll();
    });
    this.client.on('message', (topic, payload) => this._onMessage(topic, payload));
    this.client.on('error', (err) => { this.lastError = err.message; this.stats.errors++; this.log('MQTT-Fehler: ' + err.message); });
    this.client.on('close', () => this.log('MQTT-Verbindung geschlossen'));

    // NOTE: the bridge's onState hook is owned by the caller (server.js fans it
    // out to MQTT *and* the web UI *and* the persisted shadow). Overwriting it
    // here silently killed the UI's live state column.

    // A first connect that fails must NOT leave a client retrying in the
    // background (reconnectPeriod) — the caller gets an error and expects the
    // bridge to be idle, not to reconnect minutes later.
    const client = this.client;
    return new Promise((resolve, reject) => {
      const cleanup = () => { client.off('connect', ok); client.off('error', fail); clearTimeout(timer); };
      const ok = () => { cleanup(); resolve(this.status()); };
      const fail = (e) => {
        cleanup();
        this.lastError = e?.message || 'MQTT-Verbindung fehlgeschlagen';
        if (this.client === client) this.client = null;
        try { client.end(true); } catch { /* ignore */ }
        reject(new Error(this.lastError));
      };
      const timer = setTimeout(() => fail(new Error('Zeitüberschreitung beim Verbinden zum MQTT-Broker')), 15000);
      client.once('connect', ok);
      client.once('error', fail);
    });
  }

  async disconnect() {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    try {
      c.publish(`${this.base}/status`, 'offline', { qos: 1, retain: true });
      await new Promise((r) => c.end(false, {}, r));
    } catch { /* ignore */ }
  }

  setEntities(list, overrides = {}) {
    this.entities = list;
    this.overrides = overrides;
    this.areaHints = areaHints(list);
    if (this.connected) this.publishDiscovery();
  }

  // --- discovery ------------------------------------------------------------
  topics(e) {
    const b = `${this.base}/${e.id}`;
    return { state: `${b}/state`, set: `${b}/set`, position: `${b}/position`,
             setPosition: `${b}/set_position`,
             percentage: `${b}/percentage`, setPercentage: `${b}/set_percentage` };
  }

  discoveryConfig(e) {
    const t = this.topics(e);
    const comp = COMPONENT[e.kind];
    if (!comp) return null;
    const common = {
      name: e.name,
      unique_id: `heimauto_${e.id}`,
      object_id: `heimauto_${e.id}`,
      availability_topic: `${this.base}/status`,
      payload_available: 'online',
      payload_not_available: 'offline',
      device: moduleDevice(e.module, this.overrides, this.areaHints?.[e.module.toString(16).toUpperCase().padStart(2, '0')]),
      qos: 1,
    };

    switch (e.kind) {
      case 'switch':
      case 'light':
        return { comp, cfg: { ...common, state_topic: t.state, command_topic: t.set,
                              payload_on: 'ON', payload_off: 'OFF', optimistic: false } };
      case 'dimmer':
        return { comp, cfg: { ...common, schema: 'json', brightness: true,
                              state_topic: t.state, command_topic: t.set } };
      case 'cover':
        return { comp, cfg: { ...common, device_class: e.deviceClass || 'shutter',
                              command_topic: t.set, state_topic: t.state,
                              position_topic: t.position, set_position_topic: t.setPosition,
                              payload_open: 'OPEN', payload_close: 'CLOSE', payload_stop: 'STOP',
                              state_open: 'open', state_closed: 'closed',
                              state_opening: 'opening', state_closing: 'closing',
                              position_open: 100, position_closed: 0 } };
      case 'button':
        return { comp, cfg: { ...common, state_topic: t.state, payload_on: 'ON', payload_off: 'OFF',
                              device_class: e.deviceClass || undefined } };
      case 'fan':
        // Die Stufen sind diskret (16 bei der Lüftung): speed_range 1..steps-1
        // lässt Home Assistant genau diese Stufen anfahren, Stufe 0 = aus.
        return { comp, cfg: { ...common, state_topic: t.state, command_topic: t.set,
                              payload_on: 'ON', payload_off: 'OFF',
                              percentage_state_topic: t.percentage,
                              percentage_command_topic: t.setPercentage,
                              speed_range_min: 1, speed_range_max: Math.max(1, (e.steps || 2) - 1) } };
      case 'level':
        return { comp, cfg: { ...common, state_topic: t.percentage, command_topic: t.setPercentage,
                              min: 0, max: Math.max(1, (e.steps || 2) - 1), step: 1,
                              mode: 'slider', unit_of_measurement: 'Stufe' } };
      default: return null;
    }
  }

  publishDiscovery() {
    if (!this.connected) return 0;
    let n = 0;
    for (const e of this.entities) {
      const d = this.discoveryConfig(e);
      if (!d) continue;
      const topic = `${this.prefix}/${d.comp}/heimauto/${e.id}/config`;
      if (e.enabled === false) {
        this.client.publish(topic, '', { qos: 1, retain: true });   // remove
        continue;
      }
      this.client.publish(topic, JSON.stringify(d.cfg), { qos: 1, retain: true });
      n++;
    }
    this.log(`MQTT Discovery veröffentlicht: ${n} Entitäten`);
    return n;
  }

  // Diagnostics of the bridge itself: is the bus being polled, how many modules
  // answer, which operating mode is active.
  publishSystem({ polling = false, modules = 0, mode = 'bridge' } = {}) {
    if (!this.connected) return;
    const dev = MASTER_DEVICE;
    const defs = [
      { comp: 'binary_sensor', id: 'bus', name: 'HomeBus Polling', cfg: {
          state_topic: `${this.base}/system/bus`, payload_on: 'ON', payload_off: 'OFF',
          device_class: 'connectivity', entity_category: 'diagnostic' },
        payload: polling ? 'ON' : 'OFF' },
      { comp: 'sensor', id: 'modules', name: 'HomeBus Module', cfg: {
          state_topic: `${this.base}/system/modules`, unit_of_measurement: 'Module',
          state_class: 'measurement', entity_category: 'diagnostic' },
        payload: String(modules) },
      { comp: 'sensor', id: 'mode', name: 'Heimauto Betriebsart', cfg: {
          state_topic: `${this.base}/system/mode`, entity_category: 'diagnostic' },
        payload: String(mode) },
    ];
    for (const d of defs) {
      this.client.publish(`${this.prefix}/${d.comp}/heimauto/system_${d.id}/config`, JSON.stringify({
        name: d.name,
        unique_id: `heimauto_system_${d.id}`,
        object_id: `heimauto_system_${d.id}`,
        availability_topic: `${this.base}/status`,
        payload_available: 'online', payload_not_available: 'offline',
        device: dev, qos: 1, ...d.cfg,
      }), { qos: 1, retain: true });
      this.client.publish(d.cfg.state_topic, d.payload, { qos: 1, retain: true });
    }
  }

  publishState(e, state) {
    if (!this.connected || !state) return;
    const t = this.topics(e);
    if (e.kind === 'dimmer') {
      this.client.publish(t.state, JSON.stringify({ state: state.state, brightness: state.brightness }),
                          { qos: 1, retain: true });
    } else if (e.kind === 'cover') {
      this.client.publish(t.state, String(state.state), { qos: 1, retain: true });
      this.client.publish(t.position, String(state.position), { qos: 1, retain: true });
    } else if (e.kind === 'fan') {
      this.client.publish(t.state, String(state.state), { qos: 1, retain: true });
      // Home Assistant erwartet hier die STUFE (speed_range), nicht Prozent.
      this.client.publish(t.percentage, String(state.level), { qos: 1, retain: true });
    } else if (e.kind === 'level') {
      this.client.publish(t.percentage, String(state.level), { qos: 1, retain: true });
    } else {
      this.client.publish(t.state, String(state.state), { qos: 1, retain: true });
    }
    this.stats.published++;
  }

  // --- commands -------------------------------------------------------------
  _onMessage(topic, payload) {
    const text = payload.toString();
    if (topic === `${this.prefix}/status`) {
      if (text === 'online') {
        this.log('Home Assistant ist online — Discovery erneut senden');
        this.publishDiscovery();
        this.bridge.publishAll();
      }
      return;
    }
    const m = topic.match(new RegExp(`^${escapeRe(this.base)}/([^/]+)/(set|set_position|set_percentage)$`));
    if (!m) return;
    const [, id, kind] = m;
    this.stats.commands++;
    try {
      if (kind === 'set_position') this.bridge.command(id, { position: Number(text) });
      // fan/number liefern die STUFE (speed_range 1..n bzw. number 0..n)
      else if (kind === 'set_percentage') this.bridge.command(id, { level: Number(text) });
      else if (text.trim().startsWith('{')) this.bridge.command(id, JSON.parse(text));
      else this.bridge.command(id, text.trim());
    } catch (e) {
      this.stats.errors++;
      this.log(`MQTT-Kommando ${id} "${text}" abgelehnt: ${e.message}`);
    }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
