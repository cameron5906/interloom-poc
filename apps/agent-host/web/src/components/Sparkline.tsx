import { useId } from "react";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Fill the area under the line with a soft gradient. */
  fill?: boolean;
  stroke?: string;
  className?: string;
}

/**
 * Inline SVG sparkline. Pads a short series to the left so a fresh stream grows
 * from the right edge; auto-scales to the running max with a small headroom so
 * the line never clips the top.
 */
export function Sparkline({
  data,
  width = 200,
  height = 40,
  fill = true,
  stroke = "var(--il-accent)",
  className,
}: SparklineProps) {
  const gid = useId();
  const points = data.length > 0 ? data : [0];
  const max = Math.max(1, ...points) * 1.15;
  const n = Math.max(points.length, 2);
  const stepX = width / (n - 1);

  const coords = points.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * height;
    return [x, y] as const;
  });
  // If only one real point, duplicate to render a flat baseline.
  if (coords.length === 1) coords.push([width, coords[0]![1]!]);

  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const lastY = coords[coords.length - 1]![1]!;

  return (
    <svg
      className={className}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#spark-${gid})`} /> : null}
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={lastY} r="2.2" fill={stroke} />
    </svg>
  );
}
