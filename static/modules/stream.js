export function parseStreamEventLine(line, logger = console) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    logger?.warn?.("Skipped invalid stream event line", error);
    return null;
  }
}

export async function readChatStream(response, { onEvent, waitUntilResumed = () => Promise.resolve() } = {}) {
  if (!response.body) {
    throw new Error("当前浏览器不支持流式读取");
  }
  if (typeof onEvent !== "function") {
    throw new Error("Stream event handler is required");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    await waitUntilResumed();
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        await waitUntilResumed();
        const event = parseStreamEventLine(line);
        if (event) {
          onEvent(event);
        }
      }
    }
  }

  await waitUntilResumed();
  buffer += decoder.decode();
  const event = parseStreamEventLine(buffer);
  if (event) {
    onEvent(event);
  }
}
