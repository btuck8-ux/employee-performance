import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Touch the session to trigger refresh-if-needed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname.startsWith("/auth");
  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    // Vercel Cron sends Authorization: Bearer <CRON_SECRET> but no user
    // session. Bypass session check; each cron route enforces its own
    // CRON_SECRET match in the GET handler.
    pathname.startsWith("/api/cron") ||
    // /api/scores enforces its own SCORES_FEED_TOKEN bearer check in the
    // route handler; bypass the session/redirect like the cron routes.
    pathname.startsWith("/api/scores") ||
    // /api/identity (EPD->CP identity feed) enforces its own SCORES_FEED_TOKEN
    // bearer check in the route handler; bypass like /api/scores.
    pathname.startsWith("/api/identity") ||
    // /api/admin/* (operator backfills) enforce their own CRON_SECRET bearer
    // check in the route handler; bypass the session/redirect like the crons.
    pathname.startsWith("/api/admin");

  if (!user && !isAuthRoute && !isPublicAsset) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/auth/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
