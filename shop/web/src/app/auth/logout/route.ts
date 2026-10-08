import { NextResponse } from "next/server";
import { endSession, SESSION_COOKIE } from "@/lib/auth";

// POST only: a logout link that a GET could trigger (prefetch, an <img>) would log people out.
export async function POST() {
  const response = NextResponse.redirect(await endSession(), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
