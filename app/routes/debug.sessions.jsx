import prisma from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const provided = String(url.searchParams.get("key") || "");
  const expected = String(process.env.DEBUG_KEY || "");

  if (!expected || provided !== expected) {
    throw new Response("Not found", { status: 404 });
  }

  const shop = (url.searchParams.get("shop") || "").trim().toLowerCase();
  const where = shop ? { shop } : undefined;

  const sessions = await prisma.session.findMany({
    where,
    select: { id: true, shop: true, isOnline: true, scope: true, expires: true },
    orderBy: { id: "asc" },
  });

  return {
    shop: shop || null,
    count: sessions.length,
    sessions,
  };
};

