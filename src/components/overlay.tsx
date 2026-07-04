import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// Locks body scroll while at least one overlay is open (ref-counted so nested
// overlays don't clobber each other's restore).
let scrollLocks = 0;
function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    scrollLocks += 1;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = prev;
    };
  }, [active]);
}

// Escape-to-close, shared by both primitives.
function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);
}

/**
 * Right-side slide-over. Header row with an optional title + close (X) button;
 * the content area scrolls. Backdrop dims and closes on click. Escape closes,
 * body scroll is locked while open, and the panel is focused on open. The
 * translate-x transition is skipped when the user prefers reduced motion.
 */
export function Drawer({
  open,
  onClose,
  title,
  widthClass = "w-[620px] max-w-[92vw]",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  widthClass?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(open);
  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* scrim */}
      <div
        className="absolute inset-0 bg-black/25 motion-safe:transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "absolute right-0 top-0 flex h-full flex-col border-l border-border bg-card shadow-xl outline-none",
          "motion-safe:translate-x-0 motion-safe:transition-transform motion-safe:duration-300",
          widthClass,
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {title != null && (
            <h2 className="min-w-0 flex-1 truncate font-display text-sm font-medium text-foreground">
              {title}
            </h2>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className={cn(
              "ml-auto cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Centered modal card (max-w-md). Backdrop, close button, Escape-to-close,
 * body scroll lock, focus-on-open. A lightly-used but general primitive.
 */
export function Dialog({
  open,
  onClose,
  title,
  widthClass = "max-w-md",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  widthClass?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(open);
  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/25 motion-safe:transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[90vh] w-full flex-col rounded-xl border border-border bg-card shadow-xl outline-none",
          widthClass,
          "motion-safe:transition-transform motion-safe:duration-200",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {title != null && (
            <h2 className="min-w-0 flex-1 truncate font-display text-sm font-medium text-foreground">
              {title}
            </h2>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className={cn(
              "ml-auto cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
