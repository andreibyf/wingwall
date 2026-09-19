// Floating trading-copilot chat widget.
//
// Mounted globally (see App.tsx) so it is reachable from every tab. Each request sends the
// full visible conversation to POST /api/copilot/chat; the server attaches a live desk
// snapshot (open positions priced live, threshold distances, performance ledger, campaign
// wall, checklist, journal) before calling the model, so the chat always reasons off real
// book state rather than whatever gets typed into it.
//
// Advice-only: there is no write path from this widget into positions or the journal.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, X, Send, Loader2, RotateCcw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string };

type CopilotStatus = { configured: boolean; model: string };

/**
 * apiRequest throws `"<status>: <raw body>"`, and the body is JSON. Pull the human message
 * out so the panel shows "Upstream model error…" rather than a wall of escaped JSON.
 */
function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
  if (!m) return raw;
  const [, status, body] = m;
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed?.message === "string") detail = parsed.message;
  } catch {
    // Not JSON — fall through and show the body as-is.
  }
  if (detail === "fetch failed") {
    detail = "Could not reach the model API. Check the network and the API key.";
  }
  return status === "503" ? detail : `${detail} (${status})`;
}

const SUGGESTIONS = [
  "What's my position risk right now?",
  "Read my current campaign branch.",
  "How is my expectancy tracking?",
  "Is now inside the entry window?",
];

/**
 * Minimal inline renderer for the small subset of markdown the copilot is prompted to
 * use: **bold**, `code`, and - bullets. Deliberately not a full markdown engine — it
 * keeps the bundle flat and there is no HTML passthrough, so model output can't inject
 * markup.
 */
function renderInline(text: string, keyPrefix: string) {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-b${i++}`} className="font-semibold text-foreground">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={`${keyPrefix}-c${i++}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MessageBody({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="ml-4 list-disc space-y-1">
        {bullets.map((b, i) => (
          <li key={i}>{renderInline(b, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flushBullets();
    if (trimmed.length === 0) return;
    blocks.push(
      <p key={`p-${idx}`} className="whitespace-pre-wrap">
        {renderInline(trimmed.replace(/^#+\s*/, ""), `p-${idx}`)}
      </p>,
    );
  });
  flushBullets();

  return <div className="space-y-2">{blocks}</div>;
}

export function CopilotWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: status } = useQuery<CopilotStatus>({
    queryKey: ["/api/copilot/status"],
    staleTime: 60_000,
  });

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes the panel from anywhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /**
   * Posts `history` (which must already end with the user turn being answered) and appends
   * the reply. On failure the history is left untouched so Retry can resend it verbatim.
   */
  async function exchange(history: Msg[]) {
    setError(null);
    setPending(true);
    try {
      const res = await apiRequest("POST", "/api/copilot/chat", { messages: history });
      const data = await res.json();
      setMessages([...history, { role: "assistant", content: data.reply }]);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setPending(false);
    }
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    const next: Msg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    void exchange(next);
  }

  function retryLast() {
    if (pending || messages.length === 0) return;
    // A failed exchange leaves the unanswered user turn as the last message.
    if (messages[messages.length - 1].role !== "user") return;
    void exchange(messages);
  }

  const configured = status?.configured ?? true;

  return (
    <>
      {/* Launcher — sits above the mobile tab bar so it never covers navigation. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="button-copilot-open"
          aria-label="Open trading copilot"
          className="fixed bottom-20 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95 md:bottom-6 md:right-6"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Trading copilot"
          data-testid="panel-copilot"
          className="fixed inset-x-3 bottom-20 z-30 flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl md:inset-x-auto md:bottom-6 md:right-6 md:w-[400px]"
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                <h2 className="truncate text-sm font-semibold text-foreground">Copilot</h2>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                Advice only · reads your live book
              </p>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMessages([]);
                    setError(null);
                  }}
                  aria-label="Clear conversation"
                  data-testid="button-copilot-clear"
                  className="rounded-md p-1.5 text-muted-foreground hover-elevate"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close copilot"
                data-testid="button-copilot-close"
                className="rounded-md p-1.5 text-muted-foreground hover-elevate"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto [overscroll-behavior:contain] px-4 py-3">
            {!configured ? (
              <div className="space-y-2 text-xs text-muted-foreground" data-testid="text-copilot-unconfigured">
                <p className="font-medium text-foreground">Copilot needs an API key</p>
                <p>
                  Add an <code className="rounded bg-muted px-1 py-0.5 font-mono">ANTHROPIC_API_KEY</code>{" "}
                  environment variable to this service in the Render dashboard, then redeploy. The chat
                  turns on automatically once the key is present.
                </p>
              </div>
            ) : messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Ask about your open flies, the current campaign branch, sizing, or the playbook rules. I
                  read your live positions and journal on every question.
                </p>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      data-testid={`button-copilot-suggestion-${s.slice(0, 12)}`}
                      className="rounded-md border border-border px-2.5 py-1.5 text-left text-xs text-foreground hover-elevate"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    data-testid={`message-copilot-${m.role}`}
                    className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
                  >
                    <div
                      className={cn(
                        "max-w-[88%] rounded-lg px-3 py-2 text-xs leading-relaxed",
                        m.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      )}
                    >
                      {m.role === "assistant" ? (
                        <MessageBody content={m.content} />
                      ) : (
                        <span className="whitespace-pre-wrap">{m.content}</span>
                      )}
                    </div>
                  </div>
                ))}

                {pending && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="status-copilot-thinking">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Reading your book…
                  </div>
                )}

                {error && (
                  <div
                    className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] text-foreground"
                    data-testid="text-copilot-error"
                  >
                    <p className="break-words">{error}</p>
                    <button
                      type="button"
                      onClick={retryLast}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {configured && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-end gap-2 border-t border-border px-3 py-2.5"
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                placeholder="Ask about your book…"
                data-testid="input-copilot"
                className="max-h-24 min-h-9 flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
              <button
                type="submit"
                disabled={pending || input.trim().length === 0}
                aria-label="Send message"
                data-testid="button-copilot-send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
