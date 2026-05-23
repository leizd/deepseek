import { normalizeVoiceLanguage } from "./normalize.js";

export function speechTextFromMessage(message) {
  if (!message) return "";
  return String(message.content || "")
    .replace(/```(?:mermaid|mmd)\s+([\s\S]*?)```/gi, (_, body) => mermaidSpeechText(body))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " 公式略 ")
    .replace(/\\\[[\s\S]*?\\\]/g, " 公式略 ")
    .replace(/\\\([\s\S]*?\\\)/g, " 公式略 ")
    .replace(/\$[^$\n]{1,500}\$/g, " 公式略 ")
    .replace(/\[\^[^\]]+\]/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\|/g, " ")
    .replace(/[#>*_~\-]+/g, " ")
    .replace(/(?:公式略\s*){2,}/g, "公式略 ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function mermaidSpeechText(source) {
  const labels = [];
  const text = String(source || "");
  for (const match of text.matchAll(/"([^"]+)"|\[([^\]]+)\]/g)) {
    const label = String(match[1] || match[2] || "").replace(/[\[\]{}()|]/g, " ").trim();
    if (label && !/^[\w\s-]+$/.test(label)) labels.push(label);
    if (labels.length >= 8) break;
  }
  return labels.length ? ` ${labels.join("。")} ` : " ";
}

export function speechChunks(text) {
  const maxLength = 180;
  const source = String(text || "").trim();
  if (!source) return [];
  const sentences = source.match(/[^。！？!?；;\n]+[。！？!?；;]?|\n+/g) || [source];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const segment = sentence.trim();
    if (!segment) continue;
    for (const piece of splitLongSpeechSegment(segment, maxLength)) {
      if (!current) {
        current = piece;
      } else if (`${current} ${piece}`.length <= maxLength) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 80);
}

export function splitLongSpeechSegment(segment, maxLength) {
  const value = String(segment || "").trim();
  if (value.length <= maxLength) return [value];
  const words = value.split(/(\s+)/).filter(Boolean);
  if (words.length > 1) {
    const pieces = [];
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word.trim();
      } else if (`${current}${word}`.length <= maxLength) {
        current += word;
      } else {
        if (current.trim()) pieces.push(current.trim());
        current = word.trim();
      }
    }
    if (current.trim()) pieces.push(current.trim());
    return pieces.flatMap((piece) => splitLongSpeechSegment(piece, maxLength));
  }
  const pieces = [];
  for (let index = 0; index < value.length; index += maxLength) {
    pieces.push(value.slice(index, index + maxLength));
  }
  return pieces;
}

export function preferredSpeechVoice(lang, voices = speechVoices()) {
  if (!voices.length) return null;
  const normalized = normalizeVoiceLanguage(lang).toLowerCase();
  const base = normalized.split("-")[0];
  return (
    voices.find((voice) => String(voice.lang || "").toLowerCase() === normalized) ||
    voices.find((voice) => String(voice.lang || "").toLowerCase().startsWith(`${base}-`)) ||
    null
  );
}

function speechVoices() {
  const speech = globalThis.speechSynthesis || globalThis.window?.speechSynthesis;
  return speech?.getVoices?.() || [];
}
