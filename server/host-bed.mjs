export const HOST_BED_RADIUS = 500;

// Only a host collector may report the saved custom spawn point. An absent
// report is deliberately different from an explicit unset spawn point.
export function hostBedReport(payload) {
  const report = payload.hostBed;
  if (report === undefined) return null;
  if (payload.mode !== 'host') throw new TypeError('hostBed: точку спального места может передавать только хост.');
  if (report === null) return null;
  if (typeof report !== 'object' || Array.isArray(report)) throw new TypeError('hostBed: ожидается объект либо null.');
  if (report.status === 'unset') {
    if (Object.keys(report).some(key => key !== 'status')) throw new TypeError('hostBed: у unset не должно быть координат.');
    return { status: 'unset' };
  }
  if (report.status !== 'set' || Object.keys(report).some(key => !['status', 'x', 'y', 'z'].includes(key))) throw new TypeError('hostBed: ожидается status set или unset.');
  for (const axis of ['x', 'y', 'z']) {
    if (typeof report[axis] !== 'number' || !Number.isFinite(report[axis]) || Math.abs(report[axis]) > 10_000_000) throw new TypeError(`hostBed.${axis}: недопустимая координата.`);
  }
  return { status: 'set', x: report.x, y: report.y, z: report.z };
}

export function hostBedArea(anchor) {
  if (!anchor) return { status: 'pending', radius: HOST_BED_RADIUS, applied: false };
  const common = { radius: HOST_BED_RADIUS, applied: true, observedAt: new Date(anchor.observed_at).toISOString() };
  return anchor.status === 'set'
    ? { status: 'active', ...common, x: anchor.x, y: anchor.y, z: anchor.z }
    : { status: 'unset', ...common };
}

export function withinHostBedArea(container, area) {
  return !area.applied || (area.status === 'active' && Math.hypot(container.x - area.x, container.z - area.z) <= area.radius);
}
