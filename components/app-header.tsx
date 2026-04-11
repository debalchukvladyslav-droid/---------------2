"use client"

import { Plus, Users } from "lucide-react"
import { cn } from "@/lib/utils"

interface AppHeaderProps {
  title: string
  sidebarCollapsed: boolean
  onAddTrade: () => void
}

export function AppHeader({ title, sidebarCollapsed, onAddTrade }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "fixed top-0 right-0 z-30 h-16 bg-background/80 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-6 transition-all duration-300",
        sidebarCollapsed ? "left-[72px]" : "left-[240px]"
      )}
    >
      {/* Page Title */}
      <h1 className="text-xl font-semibold text-foreground tracking-tight">
        {title}
      </h1>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all duration-200">
          <Users className="w-4 h-4" />
          Team
        </button>
        <button
          onClick={onAddTrade}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-all duration-200 shadow-lg shadow-indigo-500/25"
        >
          <Plus className="w-4 h-4" />
          Add Trade
        </button>
      </div>
    </header>
  )
}
