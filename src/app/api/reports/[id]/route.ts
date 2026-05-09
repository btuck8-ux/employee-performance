import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  const { data: report } = await supabase
    .from("generated_reports")
    .select("id, storage_path")
    .eq("id", id)
    .single();
  if (!report) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { data: signed, error } = await supabase.storage
    .from("reports")
    .createSignedUrl(report.storage_path, 60 * 15);
  if (error || !signed?.signedUrl) {
    return new NextResponse(`Could not sign URL: ${error?.message ?? "unknown"}`, {
      status: 500,
    });
  }

  return NextResponse.redirect(signed.signedUrl, 302);
}
