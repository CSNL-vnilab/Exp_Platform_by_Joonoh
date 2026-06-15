import { getCurrentProfile } from "@/lib/auth/role";
import { Sidebar } from "@/components/sidebar";
import { DisabledAccount } from "@/components/disabled-account";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getCurrentProfile();

  // On login page (no session), render children without sidebar
  if (!profile) {
    return (
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    );
  }

  // Disabled accounts see a signout screen instead of the app shell.
  if (profile.disabled) {
    return (
      <ToastProvider>
        <ConfirmProvider>
          <DisabledAccount email={profile.email} />
        </ConfirmProvider>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="min-h-screen bg-neutral-100">
          <Sidebar role={profile.role} displayName={profile.display_name} />
          {/* Main content area — offset for desktop sidebar */}
          <main className="lg:pl-64">
            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
              {children}
            </div>
          </main>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}
