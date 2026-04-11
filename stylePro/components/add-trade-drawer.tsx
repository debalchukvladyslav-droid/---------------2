"use client"

import { X, TrendingUp, TrendingDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useState } from "react"

interface AddTradeDrawerProps {
  isOpen: boolean
  onClose: () => void
}

export function AddTradeDrawer({ isOpen, onClose }: AddTradeDrawerProps) {
  const [direction, setDirection] = useState<"long" | "short">("long")

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-background/80 backdrop-blur-sm transition-opacity duration-300",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-border/50 bg-card shadow-2xl transition-transform duration-300",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">Нова угода</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            {/* Direction */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Напрямок</label>
              <div className="flex gap-3">
                <button
                  onClick={() => setDirection("long")}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-lg border py-3 text-sm font-medium transition-all",
                    direction === "long"
                      ? "border-success bg-success/10 text-success"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  )}
                >
                  <TrendingUp className="h-4 w-4" />
                  Long
                </button>
                <button
                  onClick={() => setDirection("short")}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-lg border py-3 text-sm font-medium transition-all",
                    direction === "short"
                      ? "border-destructive bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  )}
                >
                  <TrendingDown className="h-4 w-4" />
                  Short
                </button>
              </div>
            </div>

            {/* Symbol */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Інструмент</label>
              <Input
                placeholder="Напр. BTCUSDT, EURUSD"
                className="bg-muted/50 border-border"
              />
            </div>

            {/* Entry Price */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Ціна входу</label>
              <Input
                type="number"
                placeholder="0.00"
                className="bg-muted/50 border-border tabular-nums"
              />
            </div>

            {/* Exit Price */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Ціна виходу</label>
              <Input
                type="number"
                placeholder="0.00"
                className="bg-muted/50 border-border tabular-nums"
              />
            </div>

            {/* Position Size */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Розмір позиції</label>
              <Input
                type="number"
                placeholder="0.00"
                className="bg-muted/50 border-border tabular-nums"
              />
            </div>

            {/* Stop Loss */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Стоп-лосс</label>
              <Input
                type="number"
                placeholder="0.00"
                className="bg-muted/50 border-border tabular-nums"
              />
            </div>

            {/* Take Profit */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Тейк-профіт</label>
              <Input
                type="number"
                placeholder="0.00"
                className="bg-muted/50 border-border tabular-nums"
              />
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Нотатки</label>
              <textarea
                placeholder="Ваші нотатки щодо угоди..."
                className="min-h-[100px] w-full rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border/50 p-6">
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={onClose}
            >
              Скасувати
            </Button>
            <Button className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90">
              Зберегти угоду
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
