"use client"

import { X, Calendar, DollarSign, TrendingUp, TrendingDown, FileText } from "lucide-react"
import { cn } from "@/lib/utils"

interface TradeDrawerProps {
  isOpen: boolean
  onClose: () => void
}

export function TradeDrawer({ isOpen, onClose }: TradeDrawerProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-300",
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <div
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-full max-w-md bg-card/95 backdrop-blur-xl border-l border-white/10 shadow-2xl transition-transform duration-300 ease-out",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-white/10">
          <h2 className="text-lg font-semibold text-foreground">Add New Trade</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto h-[calc(100%-4rem)]">
          {/* Date Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Date
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="date"
                className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
              />
            </div>
          </div>

          {/* Symbol Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Symbol
            </label>
            <input
              type="text"
              placeholder="e.g., AAPL, TSLA"
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
            />
          </div>

          {/* Side Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Side
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button className="flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 font-medium hover:bg-emerald-500/20 transition-all">
                <TrendingUp className="w-4 h-4" />
                Long
              </button>
              <button className="flex items-center justify-center gap-2 px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-muted-foreground font-medium hover:bg-white/10 transition-all">
                <TrendingDown className="w-4 h-4" />
                Short
              </button>
            </div>
          </div>

          {/* PnL Inputs */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Net PnL
              </label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="number"
                  placeholder="0.00"
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all tabular-nums"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Gross PnL
              </label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="number"
                  placeholder="0.00"
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all tabular-nums"
                />
              </div>
            </div>
          </div>

          {/* Fees */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Commission
              </label>
              <input
                type="number"
                placeholder="0.00"
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Locates
              </label>
              <input
                type="number"
                placeholder="0.00"
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all tabular-nums"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Notes
            </label>
            <textarea
              rows={4}
              placeholder="Add your trade notes, setup details, mistakes..."
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all resize-none"
            />
          </div>

          {/* Submit Button */}
          <button className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-all shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40">
            Save Trade
          </button>
        </div>
      </div>
    </>
  )
}
