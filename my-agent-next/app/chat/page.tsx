"use client"

import dynamic from "next/dynamic"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import "@21st-sdk/react/styles.css"

const SANDBOX_STORAGE_KEY = "idm-21st-chat-sandbox"

const ChatSessionDynamic = dynamic(
  () =>
    import("./chat-session").then((m) => ({
      default: m.ChatSession,
    })),
  { ssr: false },
)

function PreparingShell() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
      Preparing chat…
    </div>
  )
}

function ChatPageContent() {
  const searchParams = useSearchParams()
  const embed = searchParams.get("embed") === "1"

  const [mounted, setMounted] = useState(false)
  const [sandboxId, setSandboxId] = useState<string | null>(null)

  useEffect(() => {
    void import("./chat-session")
  }, [])

  useEffect(() => {
    let id = localStorage.getItem(SANDBOX_STORAGE_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(SANDBOX_STORAGE_KEY, id)
    }
    setSandboxId(id)
    setMounted(true)
  }, [])

  if (!mounted || !sandboxId) {
    return <PreparingShell />
  }

  return <ChatSessionDynamic sandboxId={sandboxId} embed={embed} />
}

export default function ChatPage() {
  return (
    <Suspense fallback={<PreparingShell />}>
      <ChatPageContent />
    </Suspense>
  )
}
