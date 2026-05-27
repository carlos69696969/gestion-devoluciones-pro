import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  throw redirect(query ? `/app?${query}` : "/app");
};

export default function App() {
  return null;
}
