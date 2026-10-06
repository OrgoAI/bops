"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * A message box: Enter sends (submits its form), Shift+Enter starts a new line, and it grows with
 * what's typed, up to about 8 lines, then scrolls. Typing with an input method (e.g. Japanese) never
 * sends mid-composition.
 */
export function ComposerInput({
  value,
  onChange,
  onKeyDown,
  className = "",
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Fit the height to the text (shrinks again after sending).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.form?.requestSubmit();
        }
      }}
      className={`block max-h-[160px] resize-none overflow-y-auto ${className}`}
      {...rest}
    />
  );
}
