import { PLATFORM_CREDIT, PLATFORM_REPO } from "@/lib/branding";

// Always-visible footer attribution. Renders across the entire app (public,
// admin, public booking pages) so every screen credits the upstream
// Exp_Platform by Joonoh and links back to the GitHub repo.
export function FooterWatermark() {
  return (
    <footer className="mt-auto border-t border-border bg-white/80 py-2 text-center text-[11px] text-muted">
      <a
        href={PLATFORM_REPO}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-foreground"
      >
        {PLATFORM_CREDIT} ·{" "}
        <span className="underline underline-offset-2">{PLATFORM_REPO}</span>
      </a>
    </footer>
  );
}
