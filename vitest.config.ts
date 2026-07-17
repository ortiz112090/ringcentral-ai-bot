import { defineConfig } from "vitest/config";

// Env needed so config.ts / remoteConfig.ts module-load guards pass under test.
// These are throwaway values — no test performs real network I/O (Supabase and
// Twilio calls are mocked).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      BOT_ID: "00000000-0000-0000-0000-000000000001",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      PUBLIC_BASE_URL: "https://bot.example.com",
      TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      TWILIO_AUTH_TOKEN: "test-auth-token",
      TWILIO_NUMBER: "+15550000001",
      VOICE_PROVIDER: "twilio",
      TWILIO_ESCALATION_NUMBER: "+15559999999",
    },
  },
});
