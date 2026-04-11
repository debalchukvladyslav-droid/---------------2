"use client"

import { TrendingUp, TrendingDown, Target, BarChart3, Percent, Activity } from "lucide-react"
import { cn } from "@/lib/utils"

const stats = [
  {
    label: "Net P&L",
    value: "$12,847.50",
    change: "+18.2%",
    isPositive: true,
    icon: TrendingUp,
    iconColor: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
  },
  {
    label: "Win Rate",
    value: "68.5%",
    change: "+2.3%",
    isPositive: true,
    icon: Target,
    iconColor: "text-indigo-400",
    bgColor: "bg-indigo-500/10",
  },
  {
    label: "Profit Factor",
    value: "2.34",
    change: "+0.12",
    isPositive: true,
    icon: BarChart3,
    iconColor: "text-purple-400",
    bgColor: "bg-purple-500/10",
  },
  {
    label: "Total Trades",
    value: "142",
    change: "+12",
    isPositive: true,
    icon: Activity,
    iconColor: "text-amber-400",
    bgColor: "bg-amber-500/10",
  },
  {
    label: "Avg Win",
    value: "$284.32",
    change: "+$12.50",
    isPositive: true,
    icon: TrendingUp,
    iconColor: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
  },
  {
    label: "Avg Loss",
    value: "-$121.45",
    change: "-$8.20",
    isPositive: false,
    icon: TrendingDown,
    iconColor: "text-red-400",
    bgColor: "bg-red-500/10",
  },
]

export function StatsCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {stats.map((stat) => {
        const Icon = stat.icon
        return (
          <div
            key={stat.label}
            className="group relative bg-card/50 backdrop-blur-sm border border-white/10 rounded-xl p-5 hover:border-white/20 transition-all duration-300 hover:shadow-lg hover:shadow-black/20"
          >
            {/* Subtle gradient overlay on hover */}
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
            
            <div className="relative flex items-start justify-between">
              <div className="space-y-3">
                <p className="text-sm font-medium text-muted-foreground">
                  {stat.label}
                </p>
                <p className="text-2xl font-bold text-foreground tabular-nums tracking-tight">
                  {stat.value}
                </p>
                <p
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    stat.isPositive ? "text-emerald-400" : "text-red-400"
                  )}
                >
                  {stat.change} from last month
                </p>
              </div>
              <div className={cn("p-3 rounded-lg", stat.bgColor)}>
                <Icon className={cn("w-5 h-5", stat.iconColor)} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
