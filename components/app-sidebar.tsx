"use client"

import { useState } from "react"
import {
  LayoutDashboard,
  BarChart3,
  LineChart,
  Image,
  Bot,
  BookOpen,
  GraduationCap,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "trades", label: "Trades", icon: LineChart },
  { id: "screenshots", label: "Screenshots", icon: Image },
  { id: "ai-mentor", label: "AI Mentor", icon: Bot },
  { id: "playbook", label: "Playbook", icon: BookOpen },
  { id: "learn", label: "Learn", icon: GraduationCap },
  { id: "settings", label: "Settings", icon: Settings },
]

interface AppSidebarProps {
  activeTab: string
  onTabChange: (tab: string) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

export function AppSidebar({
  activeTab,
  onTabChange,
  collapsed,
  onCollapsedChange,
}: AppSidebarProps) {
  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen bg-card/50 backdrop-blur-xl border-r border-white/10 transition-all duration-300 ease-in-out flex flex-col",
        collapsed ? "w-[72px]" : "w-[240px]"
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex items-center h-16 px-4 border-b border-white/10 shrink-0",
          collapsed ? "justify-center" : "gap-3"
        )}
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-indigo-500/25">
          TJ
        </div>
        {!collapsed && (
          <span className="font-semibold text-foreground tracking-tight">
            TJ Pro
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                collapsed ? "justify-center" : "",
                isActive
                  ? "bg-indigo-500/15 text-indigo-400 shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              <Icon
                className={cn(
                  "w-5 h-5 shrink-0 transition-colors",
                  isActive ? "text-indigo-400" : ""
                )}
              />
              {!collapsed && <span>{item.label}</span>}
            </button>
          )
        })}
      </nav>

      {/* Collapse Toggle */}
      <div className="p-3 border-t border-white/10 shrink-0">
        <button
          onClick={() => onCollapsedChange(!collapsed)}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all duration-200",
            collapsed ? "justify-center" : ""
          )}
        >
          {collapsed ? (
            <ChevronRight className="w-5 h-5" />
          ) : (
            <>
              <ChevronLeft className="w-5 h-5" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
