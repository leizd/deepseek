import { escapeHtml } from "./markdown.js";

export function parseChartCell(value) {
  const number = Number(String(value || "").replace(/[%,$，\s]/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

export function chartSvg(data, type) {
  if (type === "pie") return pieChartSvg(data);
  const width = 640;
  const height = 260;
  const padding = 34;
  const values = data.map((item) => item.value);
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const xStep = (width - padding * 2) / Math.max(data.length, 1);
  const points = data.map((item, index) => {
    const x = padding + xStep * index + xStep / 2;
    const y = height - padding - ((item.value - min) / range) * (height - padding * 2);
    return { ...item, x, y };
  });
  const bars = points
    .map((point) => {
      const barWidth = Math.max(14, xStep * 0.56);
      const zeroY = height - padding - ((0 - min) / range) * (height - padding * 2);
      const y = Math.min(point.y, zeroY);
      const barHeight = Math.max(1, Math.abs(zeroY - point.y));
      const label = escapeHtml(point.label.length > 8 ? `${point.label.slice(0, 8)}...` : point.label);
      return `<rect x="${point.x - barWidth / 2}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" class="chart-bar"></rect><text x="${point.x}" y="${height - 10}" text-anchor="middle">${label}</text>`;
    })
    .join("");
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const dots = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" class="chart-dot"><title>${escapeHtml(point.label)}: ${point.value}</title></circle>`).join("");
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="表格图表">
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-axis"></line>
    ${type === "line" ? `<polyline points="${line}" class="chart-line"></polyline>${dots}` : bars}
  </svg>`;
}

export function pieChartSvg(data) {
  const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1;
  const width = 640;
  const height = 260;
  const cx = 150;
  const cy = 130;
  const radius = 86;
  let angle = -Math.PI / 2;
  const colors = ["#4d6bfe", "#16a34a", "#f97316", "#a855f7", "#0ea5e9", "#e11d48", "#64748b"];
  const slices = data
    .map((item, index) => {
      const value = Math.max(0, item.value);
      const color = colors[index % colors.length];
      const fraction = value / total;
      // 单一切片占满 100% 时，A 弧的起止点重合会退化成空路径（整张饼图空白），改画整圆。
      if (fraction >= 1) {
        return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"><title>${escapeHtml(item.label)}: ${item.value}</title></circle>`;
      }
      const nextAngle = angle + fraction * Math.PI * 2;
      const large = nextAngle - angle > Math.PI ? 1 : 0;
      const x1 = cx + Math.cos(angle) * radius;
      const y1 = cy + Math.sin(angle) * radius;
      const x2 = cx + Math.cos(nextAngle) * radius;
      const y2 = cy + Math.sin(nextAngle) * radius;
      angle = nextAngle;
      return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${color}"><title>${escapeHtml(item.label)}: ${item.value}</title></path>`;
    })
    .join("");
  const legend = data
    .map((item, index) => `<span><i style="background:${colors[index % colors.length]}"></i>${escapeHtml(item.label)} ${Math.round((Math.max(0, item.value) / total) * 100)}%</span>`)
    .join("");
  return `<div class="chart-pie-wrap"><svg class="chart-svg pie" viewBox="0 0 ${width} ${height}" role="img" aria-label="表格饼图">${slices}</svg><div class="chart-legend">${legend}</div></div>`;
}
