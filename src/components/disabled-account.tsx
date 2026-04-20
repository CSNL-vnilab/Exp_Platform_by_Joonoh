"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function DisabledAccount({ email }: { email: string }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-card px-4">
      <div className="w-full max-w-md">
        <Card>
          <div className="flex flex-col gap-4 text-center">
            <h1 className="text-xl font-bold text-foreground">계정이 비활성화되었습니다</h1>
            <p className="text-sm text-muted">
              <span className="font-medium text-foreground">{email}</span> 계정은
              현재 이용할 수 없습니다. 관리자에게 문의하세요.
            </p>
            <Button onClick={signOut} className="w-full mt-2">
              로그아웃
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
