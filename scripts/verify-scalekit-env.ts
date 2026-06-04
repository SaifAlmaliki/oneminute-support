import "dotenv/config";
import {
  assertScalekitEnv,
  getMissingScalekitEnv,
  isPlaceholderScalekitConfig,
} from "../lib/scalekit-env";

function buildAuthorizationUrlPreview(): string {
  const envUrl = process.env.SCALEKIT_ENVIRONMENT_URL!.replace(/\/$/, "");
  const clientId = process.env.SCALEKIT_CLIENT_ID!;
  const redirectUri = process.env.SCALEKIT_REDIRECT_URI!;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
  });
  return `${envUrl}/oauth/authorize?${params.toString()}`;
}

function main() {
  const missing = getMissingScalekitEnv();
  if (missing.length > 0) {
    console.error("Missing:", missing.join(", "));
    console.error("Copy .env.example → .env and set Scalekit values from your dashboard.");
    process.exit(1);
  }

  assertScalekitEnv();

  if (isPlaceholderScalekitConfig()) {
    console.warn(
      "Warning: SCALEKIT_ENVIRONMENT_URL or SCALEKIT_CLIENT_ID still look like placeholders."
    );
    process.exit(1);
  }

  const redirectUri = process.env.SCALEKIT_REDIRECT_URI!;
  const url = buildAuthorizationUrlPreview();

  try {
    new URL(url);
  } catch {
    console.error("Invalid authorization URL:", url);
    process.exit(1);
  }

  console.log("Scalekit env OK.");
  console.log("Redirect URI:", redirectUri);
  console.log("Login starts at: GET /api/auth");
  console.log("Sample auth URL (truncated):", url.slice(0, 96) + "...");
}

main();
