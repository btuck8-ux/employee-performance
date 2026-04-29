"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createLocationAction(formData: FormData) {
  const client_id = String(formData.get("client_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!client_id || !name) return;
  const supabase = await createClient();
  await supabase.from("locations").insert({ client_id, name });
  revalidatePath(`/dashboard/clients/${client_id}`);
  revalidatePath("/dashboard/locations");
}
