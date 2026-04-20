import { ToastProvider } from "@/components/ui/toast";
import { BRAND_NAME, BRAND_SUBTITLE, BRAND_PI, BRAND_INITIAL } from "@/lib/branding";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-white">
        <header className="border-b border-border bg-white">
          <div className="mx-auto max-w-2xl px-4 py-4 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
                <span className="text-sm font-bold text-white">{BRAND_INITIAL}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-lg font-semibold leading-tight text-foreground">
                  {BRAND_NAME}
                </span>
                <span className="text-[11px] leading-tight text-muted">
                  {BRAND_SUBTITLE} · {BRAND_PI}
                </span>
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}
