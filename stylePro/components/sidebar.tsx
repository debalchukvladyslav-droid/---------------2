"use client"

import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  BarChart3,
  LineChart,
  Image,
  Bot,
  BookOpen,
  GraduationCap,
  Settings,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react"

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  activeTab: string
  onTabChange: (tab: string) => void
}

const navItems = [
  { id: "dashboard", label: "Дашборд", icon: LayoutDashboard },
  { id: "stats", label: "Статистика", icon: BarChart3 },
  { id: "trades", label: "Угоди", icon: LineChart },
  { id: "screenshots", label: "Скріншоти", icon: Image },
  { id: "ai-mentor", label: "AI Ментор", icon: Bot },
  { id: "playbook", label: "Плейбук", icon: BookOpen },
  { id: "learn", label: "Навчання", icon: GraduationCap },
  { id: "settings", label: "Налаштування", icon: Settings },
]

export function Sidebar({ collapsed, onToggle, activeTab, onTabChange }: SidebarProps) {
  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-border/50 bg-sidebar transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="flex h-16 items-center justify-between border-b border-border/50 px-4">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <span className="text-sm font-bold text-primary-foreground">TJ</span>
            </div>
            <span className="text-lg font-semibold text-foreground">TJ Pro</span>
          </div>
        )}
        {collapsed && (
          <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-bold text-primary-foreground">TJ</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeTab === item.id
          
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-sidebar-accent text-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
              )}
            >
              <Icon className={cn("h-5 w-5 shrink-0", isActive && "text-primary")} />
              {!collapsed && <span>{item.label}</span>}
            </button>
          )
        })}
      </nav>

      {/* Toggle Button */}
      <div className="border-t border-border/50 p-3">
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeft className="h-5 w-5" />
          ) : (
            <>
              <PanelLeftClose className="h-5 w-5" />
              <span>Згорнути</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
