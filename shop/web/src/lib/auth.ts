import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import * as oidc from "openid-client";
import { config } from "./config";
import { log } from "./log";
import { redis } from "./redis";

// Login with authentik over OpenID Connect: authorization code + PKCE, state and nonce
// checked on the way back. The session lives in Redis; the browser only holds a random id
// in an HttpOnly cookie, so access tokens never reach it and any replica can serve any visitor.

export const SESSION_COOKIE = "shop_session";
const LOGIN_TTL_SECONDS = 600;

export type Session = {
  sub: string;
  username: string;
  accessToken: string;
  idToken?: string;
  expiresAt: number; // epoch seconds
};

let discovered: Promise<oidc.Configuration> | undefined;
export function oidcConfig(): Promise<oidc.Configuration> {
  discovered ??= oidc.discovery(new URL(config.oidcIssuer), config.oidcClientId, config.oidcClientSecret)
    .catch((e) => { discovered = undefined; throw e; });
  return discovered;
}

const callbackUrl = () => new URL("/auth/callback", config.appUrl).toString();

export async function startLogin(returnTo: string): Promise<string> {
  const cfg = await oidcConfig();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  await redis().set(`oidc:${state}`, JSON.stringify({ verifier, nonce, returnTo }), "EX", LOGIN_TTL_SECONDS);
  return oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: callbackUrl(),
    scope: "openid profile",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  }).toString();
}

// Exchanges the code, creates the session and returns where to send the visitor next.
export async function finishLogin(search: string): Promise<{ sessionId: string; maxAge: number; returnTo: string }> {
  const params = new URLSearchParams(search);
  const state = params.get("state") ?? "";
  const pending = await redis().getdel(`oidc:${state}`);
  if (!pending) throw new Error("unknown or expired login attempt");
  const { verifier, nonce, returnTo } = JSON.parse(pending);

  const cfg = await oidcConfig();
  // The callback URL as the browser saw it (behind the gateway the server sees localhost).
  const current = new URL(`/auth/callback${search}`, config.appUrl);
  const tokens = await oidc.authorizationCodeGrant(cfg, current, {
    pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce,
  });
  const claims = tokens.claims()!;
  const maxAge = tokens.expiresIn() ?? 3600;
  const session: Session = {
    sub: claims.sub,
    username: String(claims.preferred_username ?? claims.sub),
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: Math.floor(Date.now() / 1000) + maxAge,
  };
  const sessionId = randomBytes(32).toString("base64url");
  await redis().set(`session:${sessionId}`, JSON.stringify(session), "EX", maxAge);
  log.info({ "enduser.id": session.username }, "visitor logged in");
  return { sessionId, maxAge, returnTo: safeReturnTo(returnTo) };
}

export async function getSession(): Promise<Session | null> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const raw = await redis().get(`session:${id}`);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function endSession(): Promise<string> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  let idToken: string | undefined;
  if (id) {
    const raw = await redis().getdel(`session:${id}`);
    idToken = raw ? (JSON.parse(raw) as Session).idToken : undefined;
  }
  // Log out of authentik too, then come back to the shop.
  const cfg = await oidcConfig();
  return oidc.buildEndSessionUrl(cfg, {
    post_logout_redirect_uri: config.appUrl,
    ...(idToken ? { id_token_hint: idToken } : {}),
  }).toString();
}

// Only same-site paths: never an open redirect.
function safeReturnTo(path: unknown): string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : "/";
}
