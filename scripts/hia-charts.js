function createBarChart(container, data, options = {}) {
  if (!container || !data) return;

  const defaults = {
    width: 400,
    height: 300,
    barColor: "#3b82f6",
    textColor: "#374151",
    gridColor: "#e5e7eb",
  };

  const config = { ...defaults, ...options };

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", config.width);
  svg.setAttribute("height", config.height);

  // Clear container and add SVG
  container.innerHTML = "";
  container.appendChild(svg);

  const margin = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartWidth = config.width - margin.left - margin.right;
  const chartHeight = config.height - margin.top - margin.bottom;

  const maxValue = Math.max(...data.map((d) => d.value));

  data.forEach((item, index) => {
    const barHeight = (item.value / maxValue) * chartHeight;
    const barWidth = (chartWidth / data.length) * 0.8;
    const x =
      margin.left +
      (index * chartWidth) / data.length +
      (chartWidth / data.length) * 0.1;
    const y = margin.top + chartHeight - barHeight;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", barWidth);
    rect.setAttribute("height", barHeight);
    rect.setAttribute("fill", config.barColor);
    svg.appendChild(rect);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", x + barWidth / 2);
    text.setAttribute("y", config.height - margin.bottom + 15);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", config.textColor);
    text.setAttribute("font-size", "12");
    text.textContent = item.label;
    svg.appendChild(text);
  });
}

function createPieChart(container, data, options = {}) {
  if (!container || !data) return;

  const defaults = {
    width: 300,
    height: 300,
    colors: ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"],
  };

  const config = { ...defaults, ...options };
  const radius = Math.min(config.width, config.height) / 2 - 20;
  const centerX = config.width / 2;
  const centerY = config.height / 2;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", config.width);
  svg.setAttribute("height", config.height);

  // Clear container and add SVG
  container.innerHTML = "";
  container.appendChild(svg);

  const total = data.reduce((sum, item) => sum + item.value, 0);

  let currentAngle = 0;
  data.forEach((item, index) => {
    const sliceAngle = (item.value / total) * 2 * Math.PI;
    const endAngle = currentAngle + sliceAngle;

    const x1 = centerX + radius * Math.cos(currentAngle);
    const y1 = centerY + radius * Math.sin(currentAngle);
    const x2 = centerX + radius * Math.cos(endAngle);
    const y2 = centerY + radius * Math.sin(endAngle);

    const largeArcFlag = sliceAngle > Math.PI ? 1 : 0;

    const pathData = [
      `M ${centerX} ${centerY}`,
      `L ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
      "Z",
    ].join(" ");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", config.colors[index % config.colors.length]);
    svg.appendChild(path);

    currentAngle = endAngle;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createBarChart, createPieChart };
} else if (typeof window !== "undefined") {
  window.HIACharts = { createBarChart, createPieChart };
}
