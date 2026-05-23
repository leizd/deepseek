export function detectReminderFromText(text, now = new Date()) {
  const value = String(text || "").trim();
  if (!/提醒我/.test(value)) return null;
  const dueAt = parseReminderTime(value, now);
  if (!dueAt) return null;
  const content = value.replace(/^.*?提醒我/, "").replace(/[，,。]*$/, "").trim() || value;
  return { title: "DeepSeek 提醒", content, dueAt };
}

export function parseReminderTime(text, now = new Date()) {
  const value = String(text || "");
  const match = value.match(/(明早|明天|今天|今晚|早上|上午|下午|晚上)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?/);
  if (!match) return "";
  const base = now instanceof Date ? now : new Date(now);
  let hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  const period = match[1] || "";
  if (["下午", "晚上", "今晚"].includes(period) && hour < 12) hour += 12;
  const due = new Date(base);
  if (["明早", "明天"].includes(period)) due.setDate(due.getDate() + 1);
  due.setHours(Math.min(hour, 23), Math.min(minute, 59), 0, 0);
  if (due <= base) due.setDate(due.getDate() + 1);
  return due.toISOString();
}
