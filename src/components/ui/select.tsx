import { type SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Render the danger border/ring treatment (mirrors Input's `error`). */
  error?: boolean;
}

/**
 * Native `<select>` wrapped in shared field tokens — the same border / focus /
 * disabled idiom as {@link Input}, so selects stop drifting from text inputs.
 *
 * This is a *presentational* wrapper, NOT a custom dropdown: the real
 * `<select>` is preserved, so native keyboard navigation, screen-reader
 * semantics, and OS picker behavior stay exactly as before. All
 * `SelectHTMLAttributes` (value, onChange, disabled, required, name, id,
 * aria-*, …) pass straight through, and `<option>` children render unchanged.
 *
 * The default OS chevron is hidden via `appearance-none`; a custom inline SVG
 * chevron is layered on top (absolutely positioned, `pointer-events-none`) so
 * the control looks consistent across browsers without intercepting clicks.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ error, className = "", children, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={`
            w-full appearance-none rounded-lg border border-border bg-white px-3 py-2 pr-9 text-sm text-foreground
            focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20
            disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:opacity-50
            ${error ? "border-danger focus:border-danger focus:ring-danger/20" : ""}
            ${className}
          `}
          {...props}
        >
          {children}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500"
        >
          <path d="m6 8 4 4 4-4" />
        </svg>
      </div>
    );
  }
);

Select.displayName = "Select";

export { Select, type SelectProps };
