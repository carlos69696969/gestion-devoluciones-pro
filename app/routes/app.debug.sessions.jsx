import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = String(session?.shop || "").trim().toLowerCase();

  const sessions = await prisma.session.findMany({
    where: shop ? { shop } : undefined,
    select: {
      id: true,
      shop: true,
      isOnline: true,
      scope: true,
      expires: true,
      accessToken: true,
    },
    orderBy: { id: "asc" },
  });

  return {
    shop,
    count: sessions.length,
    sessions: sessions.map((s) => ({
      ...s,
      // Never print full tokens; just show a short prefix for troubleshooting.
      accessToken: s.accessToken ? `${String(s.accessToken).slice(0, 6)}…` : null,
    })),
  };
};

export default function DebugSessions() {
  const data = useLoaderData();
  return (
    <main style={{ padding: 16 }}>
      <h1>Debug Sessions</h1>
      <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(data, null, 2)}</pre>
    </main>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

