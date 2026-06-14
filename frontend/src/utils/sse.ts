/** SSE client helper — wraps fetch streaming with typed event listeners. */

import type { SSEEvent } from "@/types/workflow";

type EventHandlers = {
  onProgress?: (data: Record<string, unknown>) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (data: Record<string, unknown>) => void;
};

/**
 * Open an SSE connection to the `/api/generate` endpoint.
 *
 * Returns an object with an `abort()` method to cancel the connection
 * and signal the backend to stop generation.
 */
export function createSSEConnection(
  body: unknown,
  handlers: EventHandlers
): { abort: () => void } {
  const controller = new AbortController();

  fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        handlers.onError?.({
          status: "error",
          message: `HTTP ${response.status}: ${response.statusText}`,
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE messages from the buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "message";
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataStr = line.slice(6).trim();
            } else if (line.startsWith(": ")) {
              // Comment/keepalive — ignore
            }
          }

          if (!dataStr) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }

          switch (eventType) {
            case "progress":
              handlers.onProgress?.(parsed);
              break;
            case "done":
              handlers.onDone?.(parsed);
              break;
            case "error":
              handlers.onError?.(parsed);
              break;
          }
        }
      }
    })
    .catch((err: Error) => {
      // AbortError = intentional cancellation, not an error
      if (err.name !== "AbortError") {
        handlers.onError?.({ status: "error", message: err.message });
      }
    });

  return {
    abort: () => controller.abort(),
  };
}
