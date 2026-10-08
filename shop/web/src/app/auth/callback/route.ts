import { NextResponse, type NextRequest } from "next/server";
import { finishLogin, SESSION_COOKIE } from "@/lib/auth";
import { config } from "@/lib/config";
import { log } from "@/lib/log";

export async function GET(request: NextRequest) {
  try {
    const { sessionId, maxAge, returnTo } = await finishLogin(request.nextUrl.search);
    const response = NextResponse.redirect(new URL(returnTo, config.appUrl));
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge,
    });
    return response;
  } catch (e) {
    log.error({ err: e }, "login callback failed");
    return NextResponse.redirect(new URL("/?login=failed", config.appUrl));
  }
}
