"use client";

/**
 * A setting as the bot panel draws one: its title and a line under it on the left, a pill of choices on the right (the
 * panel's own Thinking, Works on and Approvals look). For a bot's settings page (bot-settings.tsx).
 */
export function Segmented<V extends string>({
  title,
  hint,
  value,
  options,
  onPick,
  disabled,
}: {
  title: string;
  hint?: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onPick: (v: V) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full items-center gap-3" data-setting={title}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-semibold leading-4">{title}</span>
        {hint && <span className="text-[12px] leading-4 text-[#6B6B6B]">{hint}</span>}
      </div>
      <div role="radiogroup" aria-label={title} className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
        {options.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            disabled={disabled}
            onClick={() => value !== v && onPick(v)}
            className={`rounded-full px-2.5 py-1 text-[12px] leading-4 disabled:opacity-60 ${value === v ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
