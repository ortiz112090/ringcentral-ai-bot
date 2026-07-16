import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { config } from "../config";

/**
 * Single shared Supabase client using the service-role key (server-side only).
 * NOTE: the service-role key bypasses row-level security — never expose it to a browser.
 *
 * Node.js < 22 has no native WebSocket global, which the Supabase realtime client
 * requires at construction time even if realtime features aren't used. Passing the
 * `ws` package explicitly avoids a hard crash on startup under Node 20 (Render's
 * current default runtime for this service).
 */
export const supabase: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      transport: ws as any,
    },
  }
);
