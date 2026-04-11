"use client"

import { useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { AppHeader } from "@/components/app-header"
import { TradeDrawer } from "@/components/trade-drawer"
import { StatsCards } from "@/components/stats-cards"
import { cn } from "@/lib/utils"

const tabTitles: Record<string, string> = {
  dashboard: "Dashboard",
  stats: "Statistics",
  trades: "Trade History",
  screenshots: "Screenshots",
  "ai-mentor": "AI Mentor",
  playbook: "Playbook",
  learn: "Learning Center",
  settings: "Settings",
}

export default function TradingJournalPage() {
  const [activeTab, setActiveTab] = useState("dashboard")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background">
      {/* Background gradient */}
      <div className="fixed inset-0 bg-gradient-to-br from-indigo-500/5 via-background to-purple-500/5 pointer-events-none" />
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none" />

      {/* Sidebar */}
      <AppSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />

      {/* Header */}
      <AppHeader
        title={tabTitles[activeTab] || "Dashboard"}
        sidebarCollapsed={sidebarCollapsed}
        onAddTrade={() => setDrawerOpen(true)}
      />

      {/* Main Content Area */}
      <main
        className={cn(
          "pt-16 min-h-screen transition-all duration-300",
          sidebarCollapsed ? "pl-[72px]" : "pl-[240px]"
        )}
      >
        <div className="p-6 lg:p-8 max-w-7xl">
          {/* Page Header */}
          <div className="mb-8">
            <p className="text-muted-foreground">
              Welcome back! Here&apos;s your trading performance overview.
            </p>
          </div>

          {/* Stats Grid */}
          <StatsCards />

          {/* Additional Content Sections */}
          <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Activity Card */}
            <div className="bg-card/50 backdrop-blur-sm border border-white/10 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-foreground mb-4">
                Recent Activity
              </h3>
              <div className="space-y-4">
                {[
                  { symbol: "NVDA", pnl: "+$342.50", time: "2 hours ago", type: "Long" },
                  { symbol: "TSLA", pnl: "-$89.20", time: "4 hours ago", type: "Short" },
                  { symbol: "AAPL", pnl: "+$156.80", time: "Yesterday", type: "Long" },
                  { symbol: "AMD", pnl: "+$78.40", time: "Yesterday", type: "Long" },
                ].map((trade, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-3 border-b border-white/5 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center text-sm font-bold text-muted-foreground">
                        {trade.symbol.slice(0, 2)}
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{trade.symbol}</p>
                        <p className="text-sm text-muted-foreground">{trade.type} · {trade.time}</p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        trade.pnl.startsWith("+")
                          ? "text-emerald-400"
                          : "text-red-400"
                      )}
                    >
                      {trade.pnl}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Stats Card */}
            <div className="bg-card/50 backdrop-blur-sm border border-white/10 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-foreground mb-4">
                Today&apos;s Summary
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between py-3 border-b border-white/5">
                  <span className="text-muted-foreground">Trades Taken</span>
                  <span className="font-semibold text-foreground tabular-nums">8</span>
                </div>
                <div className="flex items-center justify-between py-3 border-b border-white/5">
                  <span className="text-muted-foreground">Winners</span>
                  <span className="font-semibold text-emerald-400 tabular-nums">6</span>
                </div>
                <div className="flex items-center justify-between py-3 border-b border-white/5">
                  <span className="text-muted-foreground">Losers</span>
                  <span className="font-semibold text-red-400 tabular-nums">2</span>
                </div>
                <div className="flex items-center justify-between py-3 border-b border-white/5">
                  <span className="text-muted-foreground">Largest Win</span>
                  <span className="font-semibold text-emerald-400 tabular-nums">$342.50</span>
                </div>
                <div className="flex items-center justify-between py-3">
                  <span className="text-muted-foreground">Largest Loss</span>
                  <span className="font-semibold text-red-400 tabular-nums">-$89.20</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Trade Drawer */}
      <TradeDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  )
}
