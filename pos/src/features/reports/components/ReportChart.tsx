import React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartResponsiveContainer } from "@/components/common/ChartResponsiveContainer";
import { formatCurrency, formatNumber } from "../utils/reportUtils";

const COLORS = [
  "#059669", // emerald-600
  "#0284c7", // sky-600
  "#7c3aed", // violet-600
  "#d97706", // amber-600
  "#e11d48", // rose-600
  "#4b5563", // gray-600
  "#0d9488", // teal-600
  "#ea580c", // orange-600
];

interface ReportTrendChartProps {
  data: Record<string, any>[];
  xKey: string;
  lines: {
    key: string;
    name: string;
    color: string;
    isCurrency?: boolean;
  }[];
  height?: number;
}

export function ReportTrendChart({
  data,
  xKey,
  lines,
  height = 320,
}: ReportTrendChartProps) {
  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-400"
      >
        No trend data available for this range
      </div>
    );
  }

  return (
    <div style={{ height, width: "100%" }}>
      <ChartResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <defs>
            {lines.map((l) => (
              <linearGradient
                key={l.key}
                id={`grad-${l.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor={l.color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={l.color} stopOpacity={0.0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#f1f5f9"
            vertical={false}
          />
          <XAxis
            dataKey={xKey}
            stroke="#94a3b8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="#94a3b8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) =>
              val >= 1000 ? `${(val / 1000).toFixed(0)}k` : String(val)
            }
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#ffffff",
              borderRadius: "0.75rem",
              border: "1px solid #e2e8f0",
              boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
              fontSize: "12px",
            }}
            formatter={(value: any, name: any) => {
              const lineConf = lines.find((l) => l.name === name);
              return [
                lineConf?.isCurrency !== false
                  ? formatCurrency(value)
                  : formatNumber(value),
                name,
              ];
            }}
          />
          <Legend
            verticalAlign="top"
            height={36}
            iconType="circle"
            wrapperStyle={{ fontSize: "12px", paddingBottom: "10px" }}
          />
          {lines.map((l) => (
            <Area
              key={l.key}
              type="monotone"
              dataKey={l.key}
              name={l.name}
              stroke={l.color}
              strokeWidth={2}
              fillOpacity={1}
              fill={`url(#grad-${l.key})`}
            />
          ))}
        </AreaChart>
      </ChartResponsiveContainer>
    </div>
  );
}

interface ReportBarChartProps {
  data: Record<string, any>[];
  xKey: string;
  bars: {
    key: string;
    name: string;
    color: string;
    isCurrency?: boolean;
  }[];
  height?: number;
  layout?: "horizontal" | "vertical";
}

export function ReportBarChart({
  data,
  xKey,
  bars,
  height = 320,
  layout = "horizontal",
}: ReportBarChartProps) {
  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-400"
      >
        No chart data available
      </div>
    );
  }

  return (
    <div style={{ height, width: "100%" }}>
      <ChartResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout={layout}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#f1f5f9"
            vertical={layout === "vertical"}
            horizontal={layout === "horizontal"}
          />
          {layout === "horizontal" ? (
            <>
              <XAxis
                dataKey={xKey}
                stroke="#94a3b8"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#94a3b8"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val) =>
                  val >= 1000 ? `${(val / 1000).toFixed(0)}k` : String(val)
                }
              />
            </>
          ) : (
            <>
              <XAxis
                type="number"
                stroke="#94a3b8"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val) =>
                  val >= 1000 ? `${(val / 1000).toFixed(0)}k` : String(val)
                }
              />
              <YAxis
                type="category"
                dataKey={xKey}
                stroke="#94a3b8"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={110}
              />
            </>
          )}
          <Tooltip
            contentStyle={{
              backgroundColor: "#ffffff",
              borderRadius: "0.75rem",
              border: "1px solid #e2e8f0",
              boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
              fontSize: "12px",
            }}
            formatter={(value: any, name: any) => {
              const barConf = bars.find((b) => b.name === name);
              return [
                barConf?.isCurrency !== false
                  ? formatCurrency(value)
                  : formatNumber(value),
                name,
              ];
            }}
          />
          <Legend
            verticalAlign="top"
            height={36}
            iconType="circle"
            wrapperStyle={{ fontSize: "12px", paddingBottom: "10px" }}
          />
          {bars.map((b) => (
            <Bar
              key={b.key}
              dataKey={b.key}
              name={b.name}
              fill={b.color}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}

interface ReportPieChartProps {
  data: { name: string; value: number }[];
  height?: number;
  isCurrency?: boolean;
}

export function ReportPieChart({
  data,
  height = 280,
  isCurrency = true,
}: ReportPieChartProps) {
  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-400"
      >
        No breakdown data available
      </div>
    );
  }

  return (
    <div style={{ height, width: "100%" }}>
      <ChartResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={95}
            paddingAngle={3}
            dataKey="value"
          >
            {data.map((_, index) => (
              <Cell
                key={`cell-${index}`}
                fill={COLORS[index % COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "#ffffff",
              borderRadius: "0.75rem",
              border: "1px solid #e2e8f0",
              boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
              fontSize: "12px",
            }}
            formatter={(value: any) => [
              isCurrency ? formatCurrency(value) : formatNumber(value),
              "Amount",
            ]}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="circle"
            wrapperStyle={{ fontSize: "12px" }}
          />
        </PieChart>
      </ChartResponsiveContainer>
    </div>
  );
}
