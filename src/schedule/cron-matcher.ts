export type CronMatcher = (date: Date) => boolean;

export function parseCron(expression: string): CronMatcher | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;

  const minute = parseField(minuteField, 0, 59);
  const hour = parseField(hourField, 0, 23);
  const day = parseField(dayField, 1, 31);
  const month = parseField(monthField, 1, 12);
  const weekday = parseField(weekdayField, 0, 7);

  if (!minute || !hour || !day || !month || !weekday) return null;

  return (date: Date) =>
    minute(date.getMinutes()) &&
    hour(date.getHours()) &&
    day(date.getDate()) &&
    month(date.getMonth() + 1) &&
    weekday(date.getDay());
}

function parseField(field: string, min: number, max: number): ((value: number) => boolean) | null {
  const segments = field.split(',');
  const predicates: Array<(value: number) => boolean> = [];

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) return null;

    const stepParts = segment.split('/');
    if (stepParts.length > 2) return null;

    const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    const range = parseRange(stepParts[0], min, max);
    if (!range) return null;

    predicates.push((value) => {
      if (value < range.start || value > range.end) return false;
      return (value - range.start) % step === 0;
    });
  }

  return (value) => predicates.some((p) => p(value));
}

function parseRange(segment: string, min: number, max: number): { start: number; end: number } | null {
  if (segment === '*') return { start: min, end: max };

  const bounds = segment.split('-');
  if (bounds.length === 1) {
    const value = parseCronNumber(bounds[0], min, max);
    if (value === null) return null;
    return { start: value, end: value };
  }

  if (bounds.length !== 2) return null;
  const start = parseCronNumber(bounds[0], min, max);
  const end = parseCronNumber(bounds[1], min, max);
  if (start === null || end === null || start > end) return null;
  return { start, end };
}

function parseCronNumber(raw: string, min: number, max: number): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;

  // Cron allows 0 and 7 as Sunday.
  const normalized = max === 7 && value === 7 ? 0 : value;
  if (normalized < min || normalized > max) return null;
  return normalized;
}
