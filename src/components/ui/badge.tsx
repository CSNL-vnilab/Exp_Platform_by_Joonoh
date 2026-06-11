interface BadgeProps {
  variant?: "default" | "success" | "danger" | "info" | "warning";
  children: React.ReactNode;
  className?: string;
}

const variantClasses = {
  default: "bg-gray-100 text-gray-700",
  success: "bg-green-50 text-green-800",
  danger: "bg-red-50 text-red-700",
  info: "bg-sky-50 text-sky-800",
  warning: "bg-amber-50 text-amber-800",
} as const;

export function Badge({ variant = "default", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium
        ${variantClasses[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
