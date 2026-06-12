interface BadgeProps {
  variant?: "default" | "success" | "danger" | "info" | "warning";
  children: React.ReactNode;
  className?: string;
}

const variantClasses = {
  default: "bg-neutral-100 text-neutral-700 ring-1 ring-inset ring-neutral-200",
  success: "bg-success-50 text-success-800 ring-1 ring-inset ring-success-600/20",
  danger: "bg-danger-50 text-danger-700 ring-1 ring-inset ring-danger-600/20",
  info: "bg-info-50 text-info-800 ring-1 ring-inset ring-info-600/20",
  warning: "bg-warning-50 text-warning-800 ring-1 ring-inset ring-warning-600/20",
} as const;

export function Badge({ variant = "default", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums
        ${variantClasses[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
