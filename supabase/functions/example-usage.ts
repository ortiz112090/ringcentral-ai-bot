// Example edge function showing the corrected credential pattern.
// supabase/functions/some-function/index.ts

import { getCredential } from "../_shared/credentials.ts";

Deno.serve(async (_req) => {
  // Try Function Secrets first (RINGCENTRAL_CLIENT_ID + RINGCENTRAL_CLIENT_SECRET);
  // fall back to Vault (get_api_credential('ringcentral')) if either is missing.
  const rc = await getCredential("ringcentral", [
    "RINGCENTRAL_CLIENT_ID",
    "RINGCENTRAL_CLIENT_SECRET",
  ]);

  if (!rc) {
    // Do NOT leak which lookup failed or any secret material.
    return new Response(
      JSON.stringify({ error: "credentials_unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  // Use rc.RINGCENTRAL_CLIENT_ID etc. internally.
  // NEVER: console.log(rc) or return rc to the caller.

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { "content-type": "application/json" } },
  );
});
