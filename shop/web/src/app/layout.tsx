import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Portfolio Shop",
  description: "A small shop that runs on the portfolio platform: follow your own purchase through every layer.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return (
    <html lang="en">
      <body>
        <header>
          <Link href="/" style={{ fontWeight: 700, textDecoration: "none" }}>Portfolio Shop</Link>
          <nav>
            <Link href="/orders">My orders</Link>
            <Link href="/rate-limit">Rate limits</Link>
            {session ? (
              <form className="inline" action="/auth/logout" method="post">
                <span className="muted">{session.username} </span>
                <button className="secondary" type="submit">Log out</button>
              </form>
            ) : (
              <a className="button" href="/auth/login">Log in / Sign up</a>
            )}
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          Nothing here costs money: payments are simulated (Pix, approved in a few seconds).{" "}
          <a href="https://emersonzulian.dev">How this works</a> · <a href="https://status.emersonzulian.dev">Status</a>
        </footer>
      </body>
    </html>
  );
}
