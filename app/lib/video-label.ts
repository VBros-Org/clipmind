export function formatVideoLabel(createdAt: Date | string): string {
  const date = typeof createdAt === "string" ? new Date(createdAt) : createdAt;

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "Video";
  }

  return `Video, ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(date)}`;
}
