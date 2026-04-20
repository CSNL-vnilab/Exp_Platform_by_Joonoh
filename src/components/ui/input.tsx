import { type InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, id, className = "", ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={id} className="text-sm font-medium text-foreground">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={`
            w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground
            placeholder:text-muted
            focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20
            disabled:cursor-not-allowed disabled:opacity-50
            ${error ? "border-danger focus:border-danger focus:ring-danger/20" : ""}
            ${className}
          `}
          {...props}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";

export { Input, type InputProps };
