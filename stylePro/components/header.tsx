"use client"

import { Plus, Users } from "lucide-react"
import { Button } from "@/components/ui/button"

interface HeaderProps {
  title: string
  sidebarCollapsed: boolean
  onAddTrade: () => void
}

const pageTitles: Record<string, string> = {
  dashboard: "Дашборд",
  stats: "Статистика",
  trades: "Угоди",
  screenshots: "Скріншоти",
  "ai-mentor": "AI Ментор",
  playbook: "Плейбук",
  learn: "Навчання",
  settings: "Налаштування",
}

export function Header({ title, sidebarCollapsed, onAddTrade }: HeaderProps) {
  return (
    <header
      className={`fixed top-0 right-0 z-30 flex h-16 items-center justify-between border-b border-border/50 bg-background/80 px-6 backdrop-blur-xl transition-all duration-300 ${
        sidebarCollapsed ? "left-16" : "left-64"
      }`}
    >
      <h1 className="text-xl font-semibold text-foreground">
        {pageTitles[title] || title}
      </h1>
      
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" className="gap-2">
          <Users className="h-4 w-4" />
          <span>Команда</span>
        </Button>
        
        <Button onClick={onAddTrade} size="sm" className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
          <Plus className="h-4 w-4" />
          <span>Додати угоду</span>
        </Button>
      </div>
    </header>
  )
}
