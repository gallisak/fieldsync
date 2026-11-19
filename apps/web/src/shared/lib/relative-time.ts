const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 60],
  ['hour', 60 * 60],
  ['day', 24 * 60 * 60],
];

const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatRelative(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 45 * 60) return format.format(Math.round(seconds / 60), STEPS[0][0]);
  if (abs < 22 * 60 * 60) return format.format(Math.round(seconds / STEPS[1][1]), STEPS[1][0]);
  if (abs < 26 * 24 * 60 * 60) return format.format(Math.round(seconds / STEPS[2][1]), STEPS[2][0]);
  return new Date(time).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}
