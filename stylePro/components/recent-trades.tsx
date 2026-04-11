"use client"

import { cn } from "@/lib/utils"
import { TrendingUp, TrendingDown } from "lucide-react"

interface Trade {
  id: string
  symbol: string
  direction: "long" | "short"
  entryPrice: number
  exitPrice: number
  pnl: number
  pnlPercent: number
  date: string
}

const recentTrades: Trade[] = [
  {
    id: "1",
    symbol: "BTCUSDT",
    direction: "long",
    entryPrice: 42350.00,
    exitPrice: 43120.50,
    pnl: 770.50,
    pnlPercent: 1.82,
    date: "2024-01-15",
  },
  {
    id: "2",
    symbol: "ETHUSDT",
    direction: "short",
    entryPrice: 2280.00,
    exitPrice: 2195.00,
    pnl: 85.00,
    pnlPercent: 3.73,
    date: "2024-01-15",
  },
  {
    id: "3",
    symbol: "EURUSD",
    direction: "long",
    entryPrice: 1.0892,
    exitPrice: 1.0845,
    pnl: -47.00,
    pnlPercent: -0.43,
    date: "2024-01-14",
  },
  {
    id: "4",
    symbol: "SOLUSDT",
    direction: "long",
    entryPrice: 98.50,
    exitPrice: 105.20,
    pnl: 134.00,
    pnlPercent: 6.80,
    date: "2024-01-14",
  },
  {
    id: "5",
    symbol: "GBPUSD",
    direction: "short",
    entryPrice: 1.2710,
    exitPrice: 1.2685,
    pnl: 25.00,
    pnlPercent: 0.20,
    date: "2024-01-13",
  },
]

export function RecentTrades() {
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border/50 px-6 py-4">
        <h3 className="text-lg font-semibold text-foreground">Останні угоди</h3>
        <button className="text-sm text-primary hover:underline">
          Переглянути всі
        </button>
      </div>
      <div className="divide-y divide-border/50">
        {recentTrades.map((trade) => (
          <div
            key={trade.id}
            className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/30"
          >
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg",
                  trade.direction === "long"
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                {trade.direction === "long" ? (
                  <TrendingUp className="h-4 w-4" />
                ) : (
                  <TrendingDown className="h-4 w-4" />
                )}
              </div>
              <div>
                <p className="font-medium text-foreground">{trade.symbol}</p>
                <p className="text-xs text-muted-foreground">
                  {trade.direction === "long" ? "Long" : "Short"} • {trade.date}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p
                className={cn(
                  "font-semibold tabular-nums",
                  trade.pnl >= 0 ? "text-success" : "text-destructive"
                )}
              >
                {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
              </p>
              <p
                className={cn(
                  "text-xs tabular-nums",
                  trade.pnl >= 0 ? "text-success/70" : "text-destructive/70"
                )}
              >
                {trade.pnlPercent >= 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
