import { ToastProvider } from "@/components/ui/toast";

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
