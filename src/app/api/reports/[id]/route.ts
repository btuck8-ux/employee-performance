import { NextResponse } from "next/server";
import { canReadEmployee, getSessionRole } from "@/lib/authz";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, user } = await getSessionRole();
  if (!user) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  const { data: report } = await supabase
    .from("generated_reports")
    .select("id, storage_path, employee_id, location_id")
    .eq("id", id)
    .single();
  if (!report) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Role scoping (Phase A): signed URLs are only issued for reports about
  // employees in the caller's scope — SA all · RA territory · AA assigned
  // stores · Manager own store · User own linked employee only. The predicate
  // is the canonical SQL helper epd_can_read_employee (mig 046). Unauthorized
  // reads get the same 404 as missing rows so report UUIDs can't be probed
  // for existence.
  const allowed = await canReadEmployee(
    supabase,
    report.employee_id,
    report.location_id
  );
  if (!allowed) {
    // Server-side only (Vercel function logs) — an audit trail of scope
    // denials without leaking anything to the caller.
    console.warn("[reports] scope denial", { report_id: id, user_id: user.id });
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
