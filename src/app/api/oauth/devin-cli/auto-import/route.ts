import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { isAuthRequired, isAuthenticated } from "@/shared/utils/apiAuth";
import { createProviderConnection, getProviderConnections } from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";

/**
 * Resolve the Devin CLI credentials.toml path.
 * Windows: %APPDATA%\devin\credentials.toml
 * Linux/macOS: ~/.config/devin/credentials.toml  (or ~/.devin/credentials.toml)
 */
function resolveCredentialsPath(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return [join(appData, "devin", "credentials.toml")];
  }
  return [
    join(home, ".config", "devin", "credentials.toml"),
    join(home, ".devin", "credentials.toml"),
  ];
}

/**
 * Parse a TOML-like credentials file (key = "value" lines only — no nested tables).
 */
function parseToml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(\w+)\s*=\s*"([^"]*)"\s*$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

/**
 * GET /api/oauth/devin-cli/auto-import
 *
 * Reads the Devin CLI credentials.toml written by `devin auth login`
 * and imports the windsurf_api_key as a new provider connection.
 *
 * Usage: run `devin auth login` in a terminal first, then call this endpoint.
 */
export async function GET(request: Request) {
  if (await isAuthRequired(request)) {
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Try each candidate path
  const candidates = resolveCredentialsPath();
  let raw: string | null = null;
  let foundPath: string | null = null;

  for (const p of candidates) {
    try {
      raw = await readFile(p, "utf-8");
      foundPath = p;
      break;
    } catch {
      // try next
    }
  }

  if (!raw || !foundPath) {
    return NextResponse.json({
      found: false,
      error:
        "Devin credentials not found. Run `devin auth login` in a terminal first, then try again.",
      checkedPaths: candidates,
    });
  }

  const creds = parseToml(raw);
  const apiKey = creds.windsurf_api_key;

  if (!apiKey) {
    return NextResponse.json({
      found: false,
      error: "credentials.toml found but windsurf_api_key is missing.",
      path: foundPath,
    });
  }

  try {
    // Check for existing devin-cli connection with same key to avoid duplicates
    const existing = await getProviderConnections({ provider: "devin-cli" });
    const duplicate = existing.find(
      (c: any) => c.accessToken === apiKey || c.apiKey === apiKey
    );
    if (duplicate) {
      return NextResponse.json({
        found: true,
        duplicate: true,
        message: "Devin CLI credentials already imported.",
        connectionId: duplicate.id,
      });
    }

    const machineId = await getConsistentMachineId();
    const connection = await createProviderConnection({
      provider: "devin-cli",
      name: creds.devin_webapp_host
        ? `Devin (${creds.devin_webapp_host})`
        : "Devin CLI (auto-imported)",
      accessToken: apiKey,
      providerSpecificData: {
        authMethod: "devin-auth-login",
        apiServerUrl: creds.api_server_url || "https://server.codeium.com",
        devinWebappHost: creds.devin_webapp_host || "app.devin.ai",
        devinApiUrl: creds.devin_api_url || "https://api.devin.ai",
        importedFrom: foundPath,
      },
      machineId,
    });

    await syncToCloud().catch(() => {});

    return NextResponse.json({
      found: true,
      imported: true,
      connectionId: connection.id,
      message: "Devin CLI credentials imported successfully.",
      apiServerUrl: creds.api_server_url,
      devinWebappHost: creds.devin_webapp_host,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to save connection" },
      { status: 500 }
    );
  }
}
