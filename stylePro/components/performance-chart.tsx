"use client"

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

const data = [
  { date: "Січ 01", value: 10000 },
  { date: "Січ 05", value: 10250 },
  { date: "Січ 09", value: 10180 },
  { date: "Січ 13", value: 10420 },
  { date: "Січ 17", value: 10890 },
  { date: "Січ 21", value: 10650 },
  { date: "Січ 25", value: 11200 },
  { date: "Січ 29", value: 11450 },
  { date: "Лют 02", value: 11380 },
  { date: "Лют 06", value: 11920 },
  { date: "Лют 10", value: 12350 },
  { date: "Лют 14", value: 12847 },
]

export function PerformanceChart() {
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-6 backdrop-blur-sm">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Динаміка капіталу</h3>
          <p className="text-sm text-muted-foreground">Графік зміни балансу за місяць</p>
        </div>
        <div className="flex gap-2">
          <button className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground">
            1М
          </button>
          <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            3М
          </button>
          <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            6М
          </button>
          <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            1Р
          </button>
        </div>
      </div>
      
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.67 0.21 145)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.67 0.21 145)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "oklch(0.55 0 0)", fontSize: 12 }}
              dy={10}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "oklch(0.55 0 0)", fontSize: 12 }}
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
              dx={-10}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  return (
                    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
                      <p className="text-xs text-muted-foreground">
                        {payload[0].payload.date}
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-foreground">
                        ${payload[0].value?.toLocaleString()}
                      </p>
                    </div>
                  )
                }
                return null
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="oklch(0.67 0.21 145)"
              strokeWidth={2}
              fill="url(#colorValue)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
