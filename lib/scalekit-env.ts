const SCALEKIT_ENV_KEYS = [
  "SCALEKIT_ENVIRONMENT_URL",
  "SCALEKIT_CLIENT_ID",
  "SCALEKIT_CLIENT_SECRET",
  "SCALEKIT_REDIRECT_URI",
] as const;

export type ScalekitEnvKey = (typeof SCALEKIT_ENV_KEYS)[number];

export function getMissingScalekitEnv(): ScalekitEnvKey[] {
  return SCALEKIT_ENV_KEYS.filter((key) => !process.env[key]?.trim());
}

export function assertScalekitEnv(): void {
  const missing = getMissingScalekitEnv();
  if (missing.length > 0) {
    throw new Error(
      `Missing Scalekit environment variables: ${missing.join(", ")}. Copy .env.example to .env and set values from the Scalekit dashboard.`
    );
  }
}

export function getPostLogoutRedirectUri(): string {
  return (
    process.env.SCALEKIT_POST_LOGOUT_REDIRECT_URI?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000/"
  );
}

export function isPlaceholderScalekitConfig(): boolean {
  const url = process.env.SCALEKIT_ENVIRONMENT_URL ?? "";
  const clientId = process.env.SCALEKIT_CLIENT_ID ?? "";
  return (
    url.includes("your-env") ||
    clientId.startsWith("skc_...") ||
    clientId === "your-client-id"
  );
}
