import prisma from "../db.server";

const DEFAULT_DAILY_GEOCODE_LIMIT = 300;

export function normalizeGoogleMapsAddress(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s#.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function todayStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function googleMapsApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

function dailyGeocodeLimit() {
  const value = Number(process.env.GOOGLE_MAPS_DAILY_GEOCODE_LIMIT || DEFAULT_DAILY_GEOCODE_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_GEOCODE_LIMIT;
}

async function canUseNewGoogleGeocode(shop) {
  const limit = dailyGeocodeLimit();
  const usedToday = await prisma.googleMapsGeocodeCache.count({
    where: {
      shop,
      source: "google",
      createdAt: { gte: todayStart() },
    },
  });
  return usedToday < limit;
}

async function fetchGoogleGeocode(address) {
  const key = googleMapsApiKey();
  if (!key || !address) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "mx");
  url.searchParams.set("language", "es");
  url.searchParams.set("key", key);

  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = await response.json();
  if (payload?.status !== "OK" || !Array.isArray(payload?.results) || !payload.results.length) return null;

  const result = payload.results[0];
  const location = result?.geometry?.location;
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    formattedAddress: String(result?.formatted_address || address).trim(),
    latitude,
    longitude,
    placeId: String(result?.place_id || "").trim() || null,
  };
}

export async function geocodeAddressWithCache(shop, address) {
  const cleanShop = String(shop || "").trim();
  const cleanAddress = String(address || "").trim();
  const addressKey = normalizeGoogleMapsAddress(cleanAddress);
  if (!cleanShop || !addressKey) return null;

  const cached = await prisma.googleMapsGeocodeCache.findUnique({
    where: { shop_addressKey: { shop: cleanShop, addressKey } },
  });
  if (cached) {
    return {
      address: cached.address,
      formattedAddress: cached.formattedAddress || cached.address,
      latitude: cached.latitude,
      longitude: cached.longitude,
      placeId: cached.placeId || "",
      cached: true,
    };
  }

  if (!googleMapsApiKey()) return null;
  if (!(await canUseNewGoogleGeocode(cleanShop))) return null;

  const geocode = await fetchGoogleGeocode(cleanAddress);
  if (!geocode) return null;

  await prisma.googleMapsGeocodeCache.upsert({
    where: { shop_addressKey: { shop: cleanShop, addressKey } },
    create: {
      shop: cleanShop,
      addressKey,
      address: cleanAddress,
      formattedAddress: geocode.formattedAddress,
      latitude: geocode.latitude,
      longitude: geocode.longitude,
      placeId: geocode.placeId,
    },
    update: {
      address: cleanAddress,
      formattedAddress: geocode.formattedAddress,
      latitude: geocode.latitude,
      longitude: geocode.longitude,
      placeId: geocode.placeId,
      source: "google",
    },
  });

  return { address: cleanAddress, ...geocode, cached: false };
}

export function haversineDistanceMeters(firstPoint, secondPoint) {
  const firstLatitude = Number(firstPoint?.latitude);
  const firstLongitude = Number(firstPoint?.longitude);
  const secondLatitude = Number(secondPoint?.latitude);
  const secondLongitude = Number(secondPoint?.longitude);
  if (
    !Number.isFinite(firstLatitude) ||
    !Number.isFinite(firstLongitude) ||
    !Number.isFinite(secondLatitude) ||
    !Number.isFinite(secondLongitude)
  ) {
    return Number.MAX_SAFE_INTEGER;
  }

  const earthRadiusMeters = 6371000;
  const latitudeDelta = ((secondLatitude - firstLatitude) * Math.PI) / 180;
  const longitudeDelta = ((secondLongitude - firstLongitude) * Math.PI) / 180;
  const firstLatitudeRadians = (firstLatitude * Math.PI) / 180;
  const secondLatitudeRadians = (secondLatitude * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitudeRadians) *
      Math.cos(secondLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
