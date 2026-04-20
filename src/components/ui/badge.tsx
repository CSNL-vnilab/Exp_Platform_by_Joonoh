interface BadgeProps {
  variant?: "default" | "success" | "danger" | "info" | "warning";
  children: React.ReactNode;
  className?: string;
}

const variantClasses = {
  default: "bg-gray-100 text-gray-700",
  success: "bg-green-100 text-green-700",
  danger: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
  warning: "bg-yellow-100 text-yellow-700",
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
