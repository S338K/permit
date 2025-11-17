export function formatDate24(d) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  const fmtOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  return date.toLocaleString(undefined, fmtOptions);
}

export function formatLastLogin(d) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  const now = new Date();

  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  const time = date.toLocaleTimeString(undefined, { hour12: false });

  if (isSameDay) return `${time} on Today`;
  if (isYesterday) return `${time} on Yesterday`;

  const datePart = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
  return `${time} on ${datePart}`;
}
