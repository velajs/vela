export type CronMatcher = (date: Date) => boolean;

export interface CronOptions {
  /** Unix uses 0/7 = Sunday; Cloudflare uses 1 = Sunday through 7 = Saturday. */
  dialect?: 'unix' | 'cloudflare';
  /** Defaults to local for Unix and UTC for Cloudflare. Cloudflare requires UTC. */
  timeZone?: 'local' | 'UTC';
}

interface CalendarMinute {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
type DayMatcher = (date: CalendarMinute) => boolean;

/**
 * Five-field cron matching. The 1.x default retains local time and conjunctive
 * day-of-month/day-of-week matching. Native Workers dispatch still matches the
 * trigger's exact string; it never evaluates this matcher at delivery time.
 */
export function parseCron(expression: string, options: CronOptions = {}): CronMatcher | null {
  const dialect = options.dialect ?? 'unix';
  const timeZone = options.timeZone ?? (dialect === 'cloudflare' ? 'UTC' : 'local');
  if (dialect !== 'unix' && dialect !== 'cloudflare') return null;
  if (timeZone !== 'local' && timeZone !== 'UTC') return null;
  if (dialect === 'cloudflare' && timeZone !== 'UTC') return null;
  if (typeof expression !== 'string') return null;
  const fields = expression.trim().toUpperCase().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  if (!minuteField || !hourField || !dayField || !monthField || !weekdayField) return null;

  const minute = parseField(minuteField, 0, 59);
  const hour = parseField(hourField, 0, 23);
  const month = parseField(monthField, 1, 12, MONTHS);
  const day = parseDayOfMonth(dayField, dialect);
  const weekday = parseDayOfWeek(weekdayField, dialect);
  if (!minute || !hour || !day || !month || !weekday) return null;

  return (date) => {
    if (!Number.isFinite(date.getTime())) return false;
    const utc = timeZone === 'UTC';
    const value: CalendarMinute = {
      year: utc ? date.getUTCFullYear() : date.getFullYear(),
      month: (utc ? date.getUTCMonth() : date.getMonth()) + 1,
      day: utc ? date.getUTCDate() : date.getDate(),
      weekday: utc ? date.getUTCDay() : date.getDay(),
      hour: utc ? date.getUTCHours() : date.getHours(),
      minute: utc ? date.getUTCMinutes() : date.getMinutes(),
    };
    return (
      minute(value.minute) && hour(value.hour) && month(value.month) && day(value) && weekday(value)
    );
  };
}

function integer(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseField(
  field: string,
  min: number,
  max: number,
  names: readonly string[] = [],
): ((value: number) => boolean) | null {
  const accepted = new Set<number>();
  const number = (raw: string): number | null => {
    const index = names.indexOf(raw);
    const value = index < 0 ? integer(raw) : index + min;
    return value !== null && value >= min && value <= max ? value : null;
  };
  for (const segment of field.split(',')) {
    const [range, stepRaw, extra] = segment.split('/');
    if (!range || extra !== undefined) return null;
    const step = stepRaw === undefined ? 1 : integer(stepRaw);
    if (step === null || step < 1) return null;
    const bounds = range.split('-');
    const start = range === '*' ? min : number(bounds[0] ?? '');
    const end =
      range === '*'
        ? max
        : bounds.length === 1
          ? stepRaw === undefined
            ? start
            : max
          : number(bounds[1] ?? '');
    if (bounds.length > 2 || start === null || end === null || start > end) return null;
    for (let value = start; value <= end; value += step) accepted.add(value);
  }
  return (value) => accepted.has(value);
}

function lastDay(date: CalendarMinute): number {
  const calendar = new Date(0);
  calendar.setUTCFullYear(date.year, date.month, 0);
  return calendar.getUTCDate();
}

function weekdayAt(date: CalendarMinute, day: number): number {
  const calendar = new Date(0);
  calendar.setUTCFullYear(date.year, date.month - 1, day);
  return calendar.getUTCDay();
}

function nearestWeekday(date: CalendarMinute, day: number): number {
  const weekday = weekdayAt(date, day);
  if (weekday === 6) return day === 1 ? 3 : day - 1;
  if (weekday === 0) return day === lastDay(date) ? day - 2 : day + 1;
  return day;
}

function parseDayOfMonth(
  field: string,
  dialect: NonNullable<CronOptions['dialect']>,
): DayMatcher | null {
  if (dialect === 'cloudflare') {
    if (field === 'L') return (date) => date.day === lastDay(date);
    if (field === 'LW') return (date) => date.day === nearestWeekday(date, lastDay(date));
    const near = /^(\d+)W$/.exec(field);
    if (near) {
      const day = integer(near[1] ?? '');
      if (day === null || day < 1 || day > 31) return null;
      return (date) => day <= lastDay(date) && date.day === nearestWeekday(date, day);
    }
  }
  const matches = parseField(field, 1, 31);
  return matches ? (date) => matches(date.day) : null;
}

function parseDayOfWeek(
  field: string,
  dialect: NonNullable<CronOptions['dialect']>,
): DayMatcher | null {
  if (dialect === 'cloudflare') {
    if (field === 'L') return (date) => date.weekday === 6;
    const special = /^(\d+|SUN|MON|TUE|WED|THU|FRI|SAT)(L|#[1-5])$/.exec(field);
    if (special) {
      const matches = parseField(special[1] ?? '', 1, 7, WEEKDAYS);
      if (!matches) return null;
      const occurrence = special[2];
      return (date) =>
        matches(date.weekday + 1) &&
        (occurrence === 'L'
          ? date.day + 7 > lastDay(date)
          : Math.ceil(date.day / 7) === Number(occurrence?.slice(1)));
    }
    const matches = parseField(field, 1, 7, WEEKDAYS);
    return matches ? (date) => matches(date.weekday + 1) : null;
  }
  const matches = parseField(field, 0, 7, WEEKDAYS);
  return matches ? (date) => matches(date.weekday) || (date.weekday === 0 && matches(7)) : null;
}
