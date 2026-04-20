export function relativeTime(timestamp) {
  if (!timestamp) return '';

  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return '';

  const mins = Math.floor((Date.now() - then.getTime()) / 60_000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const thisYear = new Date().getFullYear();
  const thenYear = then.getFullYear();

  const dateStr = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return thenYear === thisYear ? dateStr : `${dateStr}, ${thenYear}`;
}

export function absoluteCalendarDate(timestamp) {
  if (!timestamp) return '';
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(then);
}
