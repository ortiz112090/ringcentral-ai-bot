import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

/**
 * Single shared Supabase client using the service-role key (server-side only).
 * NOTE: the service-role key bypasses row-level security — never expose it to a browser.
 */
export const supabase: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);
