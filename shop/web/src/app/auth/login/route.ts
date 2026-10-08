import { NextResponse, type NextRequest } from "next/server";
import { startLogin } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "/";
  return NextResponse.redirect(await startLogin(returnTo));
}
