"use client"

import { useState } from "react"
import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import { AddTradeDrawer } from "@/components/add-trade-drawer"
import { StatsCards } from "@/components/stats-cards"
import { RecentTrades } from "@/components/recent-trades"
import { PerformanceChart } from "@/components/performance-chart"

export default function TradingJournal() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState("dashboard")
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <Header
        title={activeTab}
        sidebarCollapsed={sidebarCollapsed}
        onAddTrade={() => setIsDrawerOpen(true)}
      />

      <main
        className={`min-h-screen pt-16 transition-all duration-300 ${
          sidebarCollapsed ? "pl-16" : "pl-64"
        }`}
      >
        <div className="p-6">
          {activeTab === "dashboard" && (
            <div className="space-y-6">
              <StatsCards />
              
              <div className="grid gap-6 lg:grid-cols-2">
                <PerformanceChart />
                <RecentTrades />
              </div>
            </div>
          )}

          {activeTab === "stats" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">📊</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">Статистика</h2>
                <p className="mt-2 text-muted-foreground">
                  Детальна аналітика ваших торгових результатів
                </p>
              </div>
            </div>
          )}

          {activeTab === "trades" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">📈</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">Угоди</h2>
                <p className="mt-2 text-muted-foreground">
                  Повний список всіх ваших торгових операцій
                </p>
              </div>
            </div>
          )}

          {activeTab === "screenshots" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">🖼️</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">Скріншоти</h2>
                <p className="mt-2 text-muted-foreground">
                  Галерея скріншотів ваших торгових сетапів
                </p>
              </div>
            </div>
          )}

          {activeTab === "ai-mentor" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">🤖</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">AI Ментор</h2>
                <p className="mt-2 text-muted-foreground">
                  Персональний AI-асистент для покращення торгівлі
                </p>
              </div>
            </div>
          )}

          {activeTab === "playbook" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">📖</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">Плейбук</h2>
                <p className="mt-2 text-muted-foreground">
                  Ваші торгові стратегії та правила
                </p>
              </div>
            </div>
          )}

          {activeTab === "learn" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">🎓</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">Навчання</h2>
                <p className="mt-2 text-muted-foreground">
                  Освітні матеріали для трейдерів
                </p>
              </div>
            </div>
          )}

          {activeTab === "settings" && (
            <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <span className="text-2xl">⚙️</span>
                </div>
                <h2 className="text-xl font-semibold text-foreground">Налаштування</h2>
                <p className="mt-2 text-muted-foreground">
                  Налаштування вашого облікового запису
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      <AddTradeDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      />
    </div>
  )
}
