"use client";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  async function signInWithGoogle() {
    const supabase = createClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${siteUrl}/auth/callback`,
      },
    });
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-slate-50 px-4 overflow-hidden">
      {/* The brand book's halftone-dot motif — used exactly once, as a quiet
          corner texture (kickoff §5f). */}
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-16 -right-16 h-72 w-72 rounded-full opacity-15"
        style={{
          backgroundImage: "radial-gradient(#702f8a 1.5px, transparent 1.5px)",
          backgroundSize: "12px 12px",
        }}
      />
      <Card className="w-full max-w-sm relative">
        <CardHeader className="items-center text-center">
          <Image
            src="/brand/logo-vertical-t.png"
            alt="Ike's Love & Sandwiches"
            width={180}
            height={180}
            priority
            className="mx-auto h-auto w-44"
          />
          <CardDescription className="pt-2">
            Employee Performance Platform — sign in to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={signInWithGoogle}>
            Sign in with Google
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
