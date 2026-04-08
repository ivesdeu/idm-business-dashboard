"use client"

import { useMemo, useRef, useEffect } from "react"
import { createAgentChat } from "@21st-sdk/nextjs"
import { useChat } from "@ai-sdk/react"
import type { Chat } from "@ai-sdk/react"
import type { UIMessage } from "ai"

import { AIChatInput } from "@/components/ui/ai-chat-input"
import { cn } from "@/lib/utils"

function textFromMessage(m: UIMessage): string {
  const parts = m.parts
  if (parts && parts.length) {
    return parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
  }
  const legacy = (m as unknown as { content?: unknown }).content
  return typeof legacy === "string" ? legacy : ""
}

export function ChatSession({
  sandboxId,
  embed = false,
}: {
  sandboxId: string
  embed?: boolean
}) {
  const chat = useMemo(
    () =>
      createAgentChat({
        agent: "my-agent",
        tokenUrl: "/api/an-token",
        sandboxId,
      }),
    [sandboxId],
  )

  const { messages, sendMessage, status, stop, error } = useChat({
    chat: chat as Chat<UIMessage>,
  })
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, status])

  const busy = status === "streaming" || status === "submitted"

  return (
    <div
      className={cn(
        "flex flex-col text-zinc-900",
        embed
          ? "min-h-[100dvh] bg-[#fafafa]"
          : "min-h-screen bg-zinc-50",
      )}
    >
      {!embed ? (
        <header className="border-b border-zinc-200 bg-white px-4 py-3">
          <h1 className="text-lg font-semibold tracking-tight">AI Chat</h1>
          <p className="text-sm text-zinc-500">
            21st agent <span className="font-mono text-xs">my-agent</span>
          </p>
        </header>
      ) : null}

      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col",
          embed
            ? "max-w-none px-4 py-3 min-h-0"
            : "max-w-3xl px-4 py-4",
        )}
      >
        {error ? (
          <div
            className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            role="alert"
          >
            {error.message}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
          {messages.length === 0 ? (
            <p className="text-center text-sm text-zinc-400">
              Ask anything about your business or this dashboard.
            </p>
          ) : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "rounded-2xl px-4 py-2 text-sm leading-relaxed",
                m.role === "user"
                  ? "ml-8 bg-zinc-900 text-white"
                  : "mr-8 border border-zinc-200 bg-white shadow-sm",
              )}
            >
              <div className="whitespace-pre-wrap break-words">
                {textFromMessage(m) || "…"}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div
          className={cn(
            "sticky bottom-0 pb-2 pt-3",
            embed
              ? "border-t border-zinc-200/80 bg-[#fafafa]/95 backdrop-blur supports-[backdrop-filter]:bg-[#fafafa]/90"
              : "border-t border-zinc-200 bg-zinc-50/95 backdrop-blur supports-[backdrop-filter]:bg-zinc-50/80",
          )}
        >
          <AIChatInput
            disabled={busy}
            showStopButton={busy}
            onStop={busy ? stop : undefined}
            onSubmit={(text, opts) => {
              let out = text.trim()
              if (!out) return
              if (opts.think) {
                out =
                  "Please think step-by-step before answering.\n\n" + out
              }
              if (opts.deepSearch) {
                out =
                  "Please research thoroughly and cite sources when possible.\n\n" +
                  out
              }
              sendMessage({ text: out })
            }}
          />
        </div>
      </div>
    </div>
  )
}
