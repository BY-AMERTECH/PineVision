/* Farm manager's default plant health thresholds. */
window.farmManagerThresholds = (function () {
  'use strict';

  const thresholds = {
    bearing: { watch: 60, critical: 40 },
    nonbearing: { watch: 50, critical: 80 },
    discolored: { watch: 15, critical: 25 },
  };

  function metricStatus(metric, value) {
    const limit = thresholds[metric];
    const rate = Number(value) || 0;
    if (metric === 'bearing') {
      return rate < limit.critical ? 'crit' : rate < limit.watch ? 'warn' : 'good';
    }
    return rate > limit.critical ? 'crit' : rate > limit.watch ? 'warn' : 'good';
  }

  function classify(block) {
    const statuses = [
      metricStatus('bearing', block && block.bearing),
      metricStatus('nonbearing', block && (block.nonbearing ?? block.nonBearing)),
      metricStatus('discolored', block && (block.nonViable ?? block.discolored)),
    ];
    if (statuses.includes('crit')) return 'crit';
    return statuses.includes('warn') ? 'warn' : 'good';
  }

  function color(metric, value) {
    const status = metricStatus(metric, value);
    return status === 'crit' ? 'var(--red-mid)' : status === 'warn' ? 'var(--amber-mid)' : 'var(--green-mid)';
  }

  return {
    values: thresholds,
    classify: classify,
    metricStatus: metricStatus,
    color: color,
  };
})();
