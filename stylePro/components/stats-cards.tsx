"use client"

import { TrendingUp, TrendingDown, DollarSign, Target, BarChart3, Percent } from "lucide-react"
import { cn } from "@/lib/utils"

interface StatCardProps {
  title: string
  value: string
  change?: string
  changeType?: "positive" | "negative" | "neutral"
  icon: React.ReactNode
}

function StatCard({ title, value, change, changeType = "neutral", icon }: StatCardProps) {
  return (
    <div className="group rounded-xl border border-border/50 bg-card/50 p-6 backdrop-blur-sm transition-all duration-200 hover:border-border hover:bg-card">
      <div className="flex items-start justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
          {icon}
        </div>
        {change && (
          <div
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
              changeType === "positive" && "bg-success/10 text-success",
              changeType === "negative" && "bg-destructive/10 text-destructive",
              changeType === "neutral" && "bg-muted text-muted-foreground"
            )}
          >
            {changeType === "positive" && <TrendingUp className="h-3 w-3" />}
            {changeType === "negative" && <TrendingDown className="h-3 w-3" />}
            {change}
          </div>
        )}
      </div>
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      </div>
    </div>
  )
}

export function StatsCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <StatCard
        title="Загальний прибуток"
        value="$12,847.32"
        change="+12.5%"
        changeType="positive"
        icon={<DollarSign className="h-5 w-5" />}
      />
      <StatCard
        title="Вінрейт"
        value="67.8%"
        change="+2.3%"
        changeType="positive"
        icon={<Target className="h-5 w-5" />}
      />
      <StatCard
        title="Всього угод"
        value="156"
        change="+8 цього місяця"
        changeType="neutral"
        icon={<BarChart3 className="h-5 w-5" />}
      />
      <StatCard
        title="Profit Factor"
        value="2.34"
        change="-0.12"
        changeType="negative"
        icon={<Percent className="h-5 w-5" />}
      />
    </div>
  )
}
