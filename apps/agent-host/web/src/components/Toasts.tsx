import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./Toasts.css";

export type ToastTone = "success" | "danger" | "accent" | "neutral";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  push: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = "neutral") => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, tone, message }]);
      setTimeout(() => dismiss(id), 4200);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (m) => push(m, "success"),
      error: (m) => push(m, "danger"),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="il-toasts" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`il-toast il-toast--${t.tone}`}
            aria-label={`${t.message}. Dismiss notification`}
            onClick={() => dismiss(t.id)}
          >
            <span className="il-toast__dot" />
            <span className="il-toast__msg">{t.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within a ToastProvider");
  return ctx;
}
