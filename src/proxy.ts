import { NextResponse, type NextRequest } from "next/server";
import { isDesktopApiAuthorized } from "@/lib/server/desktop-auth";

export function proxy(request: NextRequest) {
    if (isDesktopApiAuthorized(request.headers)) {
        return NextResponse.next();
    }

    return new NextResponse("Unauthorized", { status: 401 });
}

export const config = {
    matcher: "/api/:path*",
};
