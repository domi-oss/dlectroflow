import { chromium } from "@playwright/test";
import { signOwnerSession, OWNER_COOKIE } from "../src/lib/auth/session";
import {
  SESSION_SECRET,
  OWNER_SUB,
  STORAGE_STATE,
  BASE_URL,
} from "./constants";

// Mint a real, valid owner session the same way the OAuth callback does,
// then persist it as Playwright storageState so every spec starts logged in.
// No auth-bypass path is added to application code.
export default async function globalSetup(): Promise<void> {
  const token = await signOwnerSession(
    { kind: "owner", sub: OWNER_SUB },
    SESSION_SECRET,
  );
  const url = new URL(BASE_URL);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: OWNER_COOKIE, // "df_owner"
      value: token,
      domain: url.hostname, // "localhost"
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    },
  ]);
  await context.storageState({ path: STORAGE_STATE });
  await browser.close();
}
