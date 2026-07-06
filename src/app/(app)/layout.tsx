import Link from "next/link";
import { isOwnerRequest } from "@/lib/workspace";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const owner = await isOwnerRequest();
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/inbox" className="text-lg font-semibold tracking-tight">
            dlectroflow
          </Link>
          <nav className="text-muted-foreground flex items-center gap-4 text-sm">
            <Link href="/inbox" className="hover:text-foreground transition-colors">
              🧠 Inbox
            </Link>
            <Link href="/dashboard" className="hover:text-foreground transition-colors">
              🎉 Dashboard
            </Link>
            {owner ? (
              <a href="/api/auth/logout" className="text-xs text-muted-foreground">Sign out</a>
            ) : (
              <a href="/login" className="text-xs text-muted-foreground">Owner sign in</a>
            )}
          </nav>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</div>
    </div>
  );
}
