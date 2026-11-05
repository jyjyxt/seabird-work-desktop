const pad = (value: number) => String(value).padStart(2, '0');

export function calendarDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function calendarLocalInput(date: Date): string {
  return `${calendarDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseCalendarLocalInput(input: string): number | null {
  const date = new Date(input);
  return !!input && !Number.isNaN(date.getTime()) && calendarLocalInput(date) === input ? date.getTime() : null;
}

export function calendarMonthDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index));
}
