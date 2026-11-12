/* Per-account alert thresholds shared by client status views. */
window.clientThresholds = (function () {
  'use strict';

  const defaults = {
    bearing: { watch: 75, critical: 60 },
    nonbearing: { watch: 30, critical: 50 },
    discolored: { watch: 15, critical: 25 },
  };
  let current = clone(defaults);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalize(saved) {
    const value = clone(defaults);
    if (!saved || typeof saved !== 'object') return value;
    ['bearing', 'nonbearing', 'discolored'].forEach(function (key) {
      const metric = saved[key];
      if (!metric) return;
      const watch = Number(metric.watch);
      const critical = Number(metric.critical);
      const valid = Number.isFinite(watch) && Number.isFinite(critical) &&
        watch >= 0 && watch <= 100 && critical >= 0 && critical <= 100 &&
        (key === 'bearing' ? critical < watch : critical > watch);
      if (valid) value[key] = { watch: watch, critical: critical };
    });
    return value;
  }

  async function load(userId) {
    current = clone(defaults);
    if (!userId) return get();
    try {
      const payload = await request('GET');
      current = normalize(payload.alertThresholds);
    } catch (error) {
      console.error('Could not load account alert thresholds:', error);
    }
    return get();
  }

  async function save(userId, value) {
    if (!userId) throw new Error('Could not identify the signed-in account');
    const normalized = normalize(value);
    const payload = await request('PUT', { alertThresholds: normalized });
    current = normalize(payload.alertThresholds);
    return get();
  }

  async function request(method, body) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('You are signed out. Sign in again and retry.');
    const token = await user.getIdToken();
    const response = await fetch('/api/client/alert-thresholds', {
      method: method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(payload.error || 'Request failed (' + response.status + ')');
    }
    return payload;
  }

  function get() {
    return clone(current);
  }

  function classify(block) {
    const values = {
      bearing: Number(block && block.bearing) || 0,
      nonbearing: Number(block && (block.nonbearing ?? block.nonBearing)) || 0,
      discolored: Number(block && (block.nonViable ?? block.discolored)) || 0,
    };
    const statuses = [
      metricStatus('bearing', values.bearing),
      metricStatus('nonbearing', values.nonbearing),
      metricStatus('discolored', values.discolored),
    ];
    if (statuses.includes('crit')) return 'crit';
    return statuses.includes('warn') ? 'warn' : 'good';
  }

  function metricStatus(metric, value) {
    const threshold = current[metric];
    if (metric === 'bearing') {
      return value < threshold.critical ? 'crit' : value < threshold.watch ? 'warn' : 'good';
    }
    return value > threshold.critical ? 'crit' : value > threshold.watch ? 'warn' : 'good';
  }

  function metricColor(metric, value) {
    const status = metricStatus(metric, Number(value) || 0);
    return status === 'crit' ? 'var(--red)' : status === 'warn' ? 'var(--amber)' : 'var(--green)';
  }

  function bearingColor(value) {
    return metricColor('bearing', value);
  }

  return {
    load: load,
    save: save,
    get: get,
    classify: classify,
    bearingColor: bearingColor,
    metricColor: metricColor,
  };
})();
